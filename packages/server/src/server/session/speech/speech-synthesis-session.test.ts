import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";

import type { SessionOutboundMessage } from "../../messages.js";
import { parsePcm16MonoWav } from "../../speech/audio.js";
import type { TextToSpeechProvider } from "../../speech/speech-provider.js";
import { SpeechSynthesisSession } from "./speech-synthesis-session.js";

function createPcmProvider(options?: { format?: string; texts?: string[] }): {
  provider: TextToSpeechProvider;
  synthesizedTexts: string[];
} {
  const synthesizedTexts: string[] = [];
  const format = options?.format ?? "pcm;rate=16000";
  const provider: TextToSpeechProvider = {
    async synthesizeSpeech(text) {
      synthesizedTexts.push(text);
      // Two bytes per 16-bit sample; one distinct byte pattern per call keeps concatenations
      // visible in the decoded output.
      const marker = options?.texts ? options.texts[synthesizedTexts.length - 1] : `${text}-audio`;
      const pcm = Buffer.from(`${synthesizedTexts.length}:${marker}`, "utf8");
      return { stream: Readable.from([pcm]), format };
    },
  };
  return { provider, synthesizedTexts };
}

function createSession(tts: TextToSpeechProvider | null) {
  const emitted: SessionOutboundMessage[] = [];
  const session = new SpeechSynthesisSession({
    emit: (message) => emitted.push(message),
    logger: { warn: vi.fn() },
    tts: () => tts,
  });
  return { session, emitted };
}

function lastResponse(
  emitted: SessionOutboundMessage[],
): Extract<SessionOutboundMessage, { type: "speech.tts.synthesize.response" }> {
  const response = emitted[emitted.length - 1];
  if (!response || response.type !== "speech.tts.synthesize.response") {
    throw new Error("Expected a speech.tts.synthesize.response");
  }
  return response;
}

describe("SpeechSynthesisSession", () => {
  test("synthesizes short text into one WAV response", async () => {
    const { provider } = createPcmProvider();
    const { session, emitted } = createSession(provider);

    await session.dispatch({
      type: "speech.tts.synthesize.request",
      requestId: "r1",
      text: " hi ",
    });

    const response = lastResponse(emitted);
    expect(response.payload.requestId).toBe("r1");
    expect(response.payload.error).toBeNull();
    expect(response.payload.mimeType).toBe("audio/wav");

    const wav = parsePcm16MonoWav(Buffer.from(response.payload.audio!, "base64"));
    expect(wav.sampleRate).toBe(16000);
    // splitTextForTts normalizes the text before it reaches the provider.
    expect(wav.pcm16.toString("utf8")).toBe("1:hi-audio");
  });

  test("splits long text into provider-sized segments and joins the PCM", async () => {
    const { provider, synthesizedTexts } = createPcmProvider();
    const { session, emitted } = createSession(provider);

    // A sentence with no clause punctuation crosses the 260 character segment cap.
    const word = "word";
    const longText = `${word} `.repeat(200).trim();
    await session.dispatch({
      type: "speech.tts.synthesize.request",
      requestId: "r1",
      text: longText,
    });

    expect(synthesizedTexts.length).toBeGreaterThan(1);
    for (const segment of synthesizedTexts) {
      expect(segment.length).toBeLessThanOrEqual(260);
    }
    const response = lastResponse(emitted);
    expect(response.payload.error).toBeNull();
    const wav = parsePcm16MonoWav(Buffer.from(response.payload.audio!, "base64"));
    expect(wav.pcm16.toString("utf8").length).toBeGreaterThan(longText.length);
  });

  test("uses the OpenAI 24 kHz fallback rate for bare pcm output", async () => {
    const { provider } = createPcmProvider({ format: "pcm" });
    const { session, emitted } = createSession(provider);

    await session.dispatch({ type: "speech.tts.synthesize.request", requestId: "r1", text: "hi" });

    const wav = parsePcm16MonoWav(Buffer.from(lastResponse(emitted).payload.audio!, "base64"));
    expect(wav.sampleRate).toBe(24000);
  });

  test("reports an error when no TTS provider resolves", async () => {
    const { session, emitted } = createSession(null);

    await session.dispatch({ type: "speech.tts.synthesize.request", requestId: "r1", text: "hi" });

    const response = lastResponse(emitted);
    expect(response.payload.audio).toBeNull();
    expect(response.payload.mimeType).toBeNull();
    expect(response.payload.error).toContain("not available");
  });

  test("reports an error for empty text without calling the provider", async () => {
    const { provider, synthesizedTexts } = createPcmProvider();
    const { session, emitted } = createSession(provider);

    await session.dispatch({ type: "speech.tts.synthesize.request", requestId: "r1", text: "  " });

    expect(synthesizedTexts).toEqual([]);
    const response = lastResponse(emitted);
    expect(response.payload.audio).toBeNull();
    expect(response.payload.error).toContain("empty");
  });

  test("returns undefined for unrelated messages", () => {
    const { provider } = createPcmProvider();
    const { session } = createSession(provider);

    expect(session.dispatch({ type: "abort_request" } as never)).toBeUndefined();
  });
});
