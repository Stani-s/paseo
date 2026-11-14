import { Buffer } from "buffer";
import { createAudioEngine, type AudioEngine, type AudioEngineCallbacks } from "@/audio";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export type ReadAloudStatus = "idle" | "synthesizing" | "playing";

export interface ReadAloudSnapshot {
  status: ReadAloudStatus;
  /**
   * Identifies the utterance currently synthesizing or playing so actions can tell whether
   * they own the active playback (and should toggle it off) or start a new one.
   */
  utteranceId: string | null;
}

export type ReadAloudClient = Pick<DaemonClient, "synthesizeTts">;

export interface ReadAloudSpeakParams {
  // Stable identity for toggle UI, e.g. the stream item the button sits on.
  utteranceId: string;
  client: ReadAloudClient | null;
  text: string;
}

export interface ReadAloudRuntime {
  speak(params: ReadAloudSpeakParams): Promise<void>;
  stop(): void;
  subscribe(listener: (snapshot: ReadAloudSnapshot) => void): () => void;
  getSnapshot(): ReadAloudSnapshot;
}

const IDLE_SNAPSHOT: ReadAloudSnapshot = { status: "idle", utteranceId: null };

// Read aloud only plays; capture callbacks stay empty.
const ENGINE_CALLBACKS: AudioEngineCallbacks = {
  onCaptureData: () => {},
  onVolumeLevel: () => {},
};

interface ActiveUtterance {
  utteranceId: string;
  // Aborting marks the utterance displaced: its promises settle silently instead of
  // resetting state owned by the utterance that replaced it.
  abort: AbortController;
}

/**
 * Plays one-shot TTS syntheses for the agent stream. Only one utterance is active at a time:
 * a new speak stops the previous one, so buttons act as toggles for their own utterance.
 */
export function createReadAloudRuntime(options?: {
  createEngine?: (callbacks: AudioEngineCallbacks) => AudioEngine;
}): ReadAloudRuntime {
  const createEngine = options?.createEngine ?? ((callbacks) => createAudioEngine(callbacks));
  let engine: AudioEngine | null = null;
  let current: ActiveUtterance | null = null;
  let snapshot = IDLE_SNAPSHOT;
  const listeners = new Set<(snapshot: ReadAloudSnapshot) => void>();

  const publish = (next: ReadAloudSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) {
      listener(next);
    }
  };

  const ensureEngine = (): AudioEngine => {
    if (!engine) {
      engine = createEngine(ENGINE_CALLBACKS);
    }
    return engine;
  };

  const isCurrent = (utterance: ActiveUtterance): boolean => current === utterance;

  const stop = (): void => {
    if (!current) {
      return;
    }
    current.abort.abort();
    current = null;
    engine?.stop();
    publish(IDLE_SNAPSHOT);
  };

  const speak = async (params: ReadAloudSpeakParams): Promise<void> => {
    const text = params.text.trim();
    if (params.utteranceId === snapshot.utteranceId) {
      // The button's own utterance is active; pressing it stops playback.
      stop();
      return;
    }
    if (!params.client || !text) {
      return;
    }

    // Any utterance already in flight stops for the new one.
    if (current) {
      current.abort.abort();
      current = null;
      engine?.stop();
    }

    const active: ActiveUtterance = {
      utteranceId: params.utteranceId,
      abort: new AbortController(),
    };
    current = active;
    publish({ status: "synthesizing", utteranceId: active.utteranceId });

    try {
      const audio = await params.client.synthesizeTts(text);
      if (active.abort.signal.aborted || !isCurrent(active)) {
        return;
      }

      const playbackEngine = ensureEngine();
      await playbackEngine.initialize();
      if (active.abort.signal.aborted || !isCurrent(active)) {
        return;
      }

      publish({ status: "playing", utteranceId: active.utteranceId });
      try {
        const bytes = Uint8Array.from(Buffer.from(audio.base64, "base64"));
        await playbackEngine.play(
          {
            type: audio.mimeType,
            size: bytes.byteLength,
            arrayBuffer: async () => bytes.buffer,
          },
          active.abort.signal,
        );
      } finally {
        playbackEngine.stop();
      }
      if (isCurrent(active)) {
        current = null;
        publish(IDLE_SNAPSHOT);
      }
    } catch (error) {
      if (isCurrent(active)) {
        current = null;
        publish(IDLE_SNAPSHOT);
      }
      throw error;
    }
  };

  return {
    speak,
    stop,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
  };
}
