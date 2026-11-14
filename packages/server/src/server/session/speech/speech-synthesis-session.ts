import type { Readable } from "node:stream";
import { splitTextForTts } from "../../agent/tts-manager.js";
import { parsePcmRateFromFormat, pcm16MonoToWavBuffer } from "../../speech/audio.js";
import { toResolver, type Resolvable } from "../../speech/provider-resolver.js";
import type { TextToSpeechProvider } from "../../speech/speech-provider.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

type SpeechSynthesisRequest = Extract<
  SessionInboundMessage,
  { type: "speech.tts.synthesize.request" }
>;

export interface SpeechSynthesisLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

// Providers emit mono 16-bit PCM (local: "pcm;rate=<N>", OpenAI: 24 kHz "pcm"), so one-shot
// synthesis joins segment PCM at one rate inside a single WAV container.
const OPENAI_PCM_SAMPLE_RATE = 24000;

async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface SpeechSynthesisSessionOptions {
  emit(message: SessionOutboundMessage): void;
  logger?: Pick<SpeechSynthesisLogger, "warn">;
  // The read-aloud TTS provider; absent when the daemon runs without speech or the feature is off.
  tts?: Resolvable<TextToSpeechProvider | null> | null;
}

/** One-shot TTS synthesis outside a voice conversation (dictation's TTS counterpart). */
export class SpeechSynthesisSession {
  private readonly resolveTts: () => TextToSpeechProvider | null;

  constructor(private readonly options: SpeechSynthesisSessionOptions) {
    this.resolveTts = toResolver(options.tts ?? null);
  }

  // Handles speech.tts.synthesize.request; returns undefined for any other message.
  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type !== "speech.tts.synthesize.request") {
      return undefined;
    }
    return this.handleSynthesize(msg);
  }

  private async handleSynthesize(msg: SpeechSynthesisRequest): Promise<void> {
    try {
      const audio = await this.synthesize(msg.text);
      this.options.emit({
        type: "speech.tts.synthesize.response",
        payload: {
          requestId: msg.requestId,
          audio: audio.toString("base64"),
          mimeType: "audio/wav",
          error: null,
        },
      });
    } catch (error) {
      this.options.logger?.warn({ err: error }, "One-shot TTS synthesis failed");
      this.options.emit({
        type: "speech.tts.synthesize.response",
        payload: {
          requestId: msg.requestId,
          audio: null,
          mimeType: null,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async synthesize(text: string): Promise<Buffer> {
    const provider = this.resolveTts();
    if (!provider) {
      throw new Error("Text-to-speech is not available. Enable read aloud in Settings > Voice.");
    }

    const segments = splitTextForTts(text);
    const pcmChunks: Buffer[] = [];
    let sampleRate: number | null = null;

    for (const segment of segments) {
      const { stream, format } = await provider.synthesizeSpeech(segment.text);
      const pcm = await collectStream(stream);
      const rate = parsePcmRateFromFormat(format, OPENAI_PCM_SAMPLE_RATE);
      if (!isPcmFormat(format) || pcm.length === 0) {
        throw new Error(`TTS provider returned unsupported output format: ${format}`);
      }
      if (rate === null) {
        throw new Error(`TTS provider returned PCM without a sample rate: ${format}`);
      }
      if (sampleRate === null) {
        sampleRate = rate;
      } else if (sampleRate !== rate) {
        throw new Error(
          `TTS provider returned inconsistent sample rates (${sampleRate}, then ${rate})`,
        );
      }
      pcmChunks.push(pcm);
    }

    return pcm16MonoToWavBuffer(Buffer.concat(pcmChunks), sampleRate!);
  }
}

function isPcmFormat(format: string): boolean {
  return /^(audio\/)?pcm\b/i.test(format.trim());
}
