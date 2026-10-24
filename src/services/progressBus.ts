/**
 * 進捗イベントバス(3.3, 3.9)
 * - BackupServiceが発行するRunイベントを購読者(SSE)へ中継する
 * - スナップショットを保持し、SSE再接続時の状態回復に使う(design.md Event Contract)
 * - 画像フェーズ(image-upload-automation 4.3, 6.5)のログイン待機・画像進捗もスナップショットに含める
 */
import type { RunKind, RunSummary } from "../types/index.js";

export type ProgressEvent =
  | { type: "run-start"; runId: string; mode: string; direction: RunKind }
  | { type: "progress"; done: number; total: number; currentTitle: string }
  | { type: "article-done"; id: string; title: string; ok: boolean; imageFailed: number; reason?: string }
  | { type: "waiting-rate-limit"; resumeAt: string }
  | { type: "run-error"; code: string; message: string }
  | { type: "run-done"; summary: RunSummary }
  // 画像フェーズ(image-upload-automation 4.3, 6.5)
  | { type: "image-login-waiting"; timeoutAt: string }
  | { type: "image-progress"; done: number; total: number; currentName: string }
  | { type: "image-done"; name: string; ok: boolean; reason?: string };

export type ProgressSnapshot = {
  running: boolean;
  runId: string | null;
  /** 実行中RunのRun方向(article-upload-sync 7.1)。未実行時はnull */
  direction: RunKind | null;
  done: number;
  total: number;
  currentTitle: string | null;
  waitingUntil: string | null;
  lastError: { code: string; message: string } | null;
  lastSummary: RunSummary | null;
  /** 画像フェーズのログイン待機期限(待機中のみ) */
  loginWaitingUntil: string | null;
  /** 画像フェーズの進捗(画像フェーズ中のみ) */
  image: { done: number; total: number; currentName: string } | null;
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
    direction: null,
    done: 0,
    total: 0,
    currentTitle: null,
    waitingUntil: null,
    lastError: null,
    lastSummary: null,
    loginWaitingUntil: null,
    image: null,
  };

  const apply = (event: ProgressEvent): void => {
    switch (event.type) {
      case "run-start":
        state.running = true;
        state.runId = event.runId;
        state.direction = event.direction;
        state.done = 0;
        state.total = 0;
        state.currentTitle = null;
        state.waitingUntil = null;
        state.lastError = null;
        state.loginWaitingUntil = null;
        state.image = null;
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
        state.direction = null;
        state.currentTitle = null;
        state.waitingUntil = null;
        state.lastSummary = event.summary;
        state.loginWaitingUntil = null;
        state.image = null;
        break;
      case "image-login-waiting":
        state.loginWaitingUntil = event.timeoutAt;
        break;
      case "image-progress":
        state.loginWaitingUntil = null;
        state.image = { done: event.done, total: event.total, currentName: event.currentName };
        break;
      case "article-done":
      case "image-done":
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
