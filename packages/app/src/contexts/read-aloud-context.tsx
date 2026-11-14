import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";
import {
  createReadAloudRuntime,
  type ReadAloudRuntime,
  type ReadAloudSnapshot,
} from "@/read-aloud/read-aloud-runtime";

interface ReadAloudContextValue extends ReadAloudSnapshot {
  /**
   * Resolves when the utterance finishes playing; rejects on synthesis or playback errors.
   * Pressing the active utterance's own action stops it and resolves.
   */
  speak: (params: Parameters<ReadAloudRuntime["speak"]>[0]) => Promise<void>;
  stop: () => void;
}

const IDLE_SNAPSHOT: ReadAloudSnapshot = { status: "idle", utteranceId: null };

const ReadAloudRuntimeContext = createContext<ReadAloudRuntime | null>(null);

const noopSubscribe = () => () => {};
const getIdleSnapshot = () => IDLE_SNAPSHOT;

const EMPTY_VALUE: ReadAloudContextValue = {
  ...IDLE_SNAPSHOT,
  speak: () => Promise.resolve(),
  stop: () => {},
};

export function useReadAloud(): ReadAloudContextValue {
  const runtime = useContext(ReadAloudRuntimeContext);
  const snapshot = useSyncExternalStore(
    runtime ? runtime.subscribe : noopSubscribe,
    runtime ? runtime.getSnapshot : getIdleSnapshot,
    runtime ? runtime.getSnapshot : getIdleSnapshot,
  );

  if (!runtime) {
    return EMPTY_VALUE;
  }
  return { ...snapshot, speak: runtime.speak, stop: runtime.stop };
}

export function ReadAloudProvider({ children }: { children: ReactNode }) {
  const runtimeRef = useRef<ReadAloudRuntime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = createReadAloudRuntime();
  }
  const runtime = runtimeRef.current;

  return (
    <ReadAloudRuntimeContext.Provider value={runtime}>{children}</ReadAloudRuntimeContext.Provider>
  );
}
