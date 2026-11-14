import { describe, expect, it, vi } from "vitest";
import type { AudioPlaybackSource, AudioEngine } from "@/audio";
import { createReadAloudRuntime } from "./read-aloud-runtime";

function createEngine() {
  const played: AudioPlaybackSource[] = [];
  const engine: AudioEngine = {
    initialize: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    startCapture: vi.fn(async () => {}),
    stopCapture: vi.fn(async () => {}),
    toggleMute: vi.fn(() => false),
    isMuted: () => false,
    play: vi.fn(async (_source: AudioPlaybackSource) => {
      played.push(_source);
      return 0;
    }),
    stop: vi.fn(),
    clearQueue: vi.fn(),
    isPlaying: () => false,
  };
  return { engine, played };
}

function createHarness() {
  const { engine, played } = createEngine();
  const runtime = createReadAloudRuntime({ createEngine: () => engine });
  const client = {
    synthesizeTts: vi.fn(async () => ({
      base64: Buffer.from("wav-bytes").toString("base64"),
      mimeType: "audio/wav",
    })),
  };
  return { runtime, engine, played, client };
}

describe("ReadAloudRuntime", () => {
  it("synthesizes and plays, then settles back to idle", async () => {
    const { runtime, engine, played, client } = createHarness();
    const states: string[] = [];
    const unsubscribe = runtime.subscribe((snapshot) =>
      states.push(`${snapshot.status}:${snapshot.utteranceId}`),
    );

    await runtime.speak({ utteranceId: "turn-1", client, text: " hello " });

    expect(states).toEqual(["synthesizing:turn-1", "playing:turn-1", "idle:null"]);
    expect(client.synthesizeTts).toHaveBeenCalledWith("hello");
    expect(engine.play).toHaveBeenCalledTimes(1);
    expect(played[0]?.type).toBe("audio/wav");
    expect(runtime.getSnapshot()).toEqual({ status: "idle", utteranceId: null });
    unsubscribe();
  });

  it("pressing the active utterance again stops playback", async () => {
    const { runtime, engine } = createHarness();
    let resolveSynth!: (value: { base64: string; mimeType: string }) => void;
    const client = {
      synthesizeTts: () =>
        new Promise<{ base64: string; mimeType: string }>((resolve) => {
          resolveSynth = resolve;
        }),
    };

    const first = runtime.speak({ utteranceId: "turn-1", client, text: "hi" });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe("synthesizing"));

    // Pressing the active utterance's own action stops it instead of queueing a second one.
    await runtime.speak({ utteranceId: "turn-1", client, text: "hi" });

    expect(runtime.getSnapshot()).toEqual({ status: "idle", utteranceId: null });

    // The displaced synthesis settles silently and never reaches the speaker.
    resolveSynth({ base64: Buffer.from("late").toString("base64"), mimeType: "audio/wav" });
    await first;
    expect(engine.play).not.toHaveBeenCalled();
  });

  it("displaces an active utterance when a new one starts", async () => {
    const { runtime, client } = createHarness();
    runtime.speak({ utteranceId: "turn-1", client, text: "one" }).catch(() => undefined);
    await vi.waitFor(() => expect(runtime.getSnapshot().utteranceId).toBe("turn-1"));

    await runtime.speak({ utteranceId: "turn-2", client, text: "two" });

    expect(runtime.getSnapshot()).toEqual({ status: "idle", utteranceId: null });
  });

  it("rejects surfaces the synthesis error and returns to idle", async () => {
    const { runtime } = createHarness();
    const client = {
      synthesizeTts: vi.fn(async () => {
        throw new Error("TTS not configured");
      }),
    };

    await expect(runtime.speak({ utteranceId: "turn-1", client, text: "hi" })).rejects.toThrow(
      "TTS not configured",
    );
    expect(runtime.getSnapshot()).toEqual({ status: "idle", utteranceId: null });
  });

  it("does nothing without a client or text", async () => {
    const { runtime } = createHarness();
    await runtime.speak({ utteranceId: "turn-1", client: null, text: "hi" });
    await runtime.speak({ utteranceId: "turn-1", client: { synthesizeTts: vi.fn() }, text: "   " });
    expect(runtime.getSnapshot()).toEqual({ status: "idle", utteranceId: null });
  });
});
