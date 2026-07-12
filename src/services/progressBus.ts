/**
 * 進捗イベントバス(3.3, 3.9)
 * - BackupServiceが発行するRunイベントを購読者(SSE)へ中継する
 * - スナップショットを保持し、SSE再接続時の状態回復に使う(design.md Event Contract)
 */
import type { RunSummary } from "../types/index.js";

export type ProgressEvent =
  | { type: "run-start"; runId: string; mode: string }
  | { type: "progress"; done: number; total: number; currentTitle: string }
  | { type: "article-done"; id: string; title: string; ok: boolean; imageFailed: number; reason?: string }
  | { type: "waiting-rate-limit"; resumeAt: string }
  | { type: "run-error"; code: string; message: string }
  | { type: "run-done"; summary: RunSummary };

export type ProgressSnapshot = {
  running: boolean;
  runId: string | null;
  done: number;
  total: number;
  currentTitle: string | null;
  waitingUntil: string | null;
  lastError: { code: string; message: string } | null;
  lastSummary: RunSummary | null;
};

export interface ProgressBus {
  emit(event: ProgressEvent): void;
  subscribe(listener: (event: ProgressEvent) => void): () => void;
  snapshot(): ProgressSnapshot;
}

export function createProgressBus(): ProgressBus {
  const listeners = new Set<(event: ProgressEvent) => void>();
  const state: ProgressSnapshot = {
    running: false,
    runId: null,
    done: 0,
    total: 0,
    currentTitle: null,
    waitingUntil: null,
    lastError: null,
    lastSummary: null,
  };

  const apply = (event: ProgressEvent): void => {
    switch (event.type) {
      case "run-start":
        state.running = true;
        state.runId = event.runId;
        state.done = 0;
        state.total = 0;
        state.currentTitle = null;
        state.waitingUntil = null;
        state.lastError = null;
        break;
      case "progress":
        state.done = event.done;
        state.total = event.total;
        state.currentTitle = event.currentTitle;
        state.waitingUntil = null;
        break;
      case "waiting-rate-limit":
        state.waitingUntil = event.resumeAt;
        break;
      case "run-error":
        state.lastError = { code: event.code, message: event.message };
        break;
      case "run-done":
        state.running = false;
        state.currentTitle = null;
        state.waitingUntil = null;
        state.lastSummary = event.summary;
        break;
      case "article-done":
        break;
    }
  };

  return {
    emit(event) {
      apply(event);
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // 購読者側の例外でRunを止めない
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot() {
      return { ...state };
    },
  };
}
