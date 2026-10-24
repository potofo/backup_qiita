/**
 * Run排他の共有機構(article-upload-sync 8.4)
 * - バックアップ/アップロードを通じてRunの同時実行を1件に制限する
 * - Runリース(獲得・解放)のみを所有し、Runの中身は関知しない
 * - 単一プロセス内のインメモリ排他(サーバは1プロセスのため分散考慮は不要)
 */
import type { Result, RunKind } from "../types/index.js";
import { ok, err } from "../types/index.js";

export type RunLease = { kind: RunKind; runId: string; release(): void };

export interface RunCoordinator {
  /** 実行中Runがあれば conflict(実行中の kind を含む)を返す */
  acquire(kind: RunKind, runId: string): Result<RunLease, { kind: "conflict"; active: RunKind }>;
  /** 現在実行中のRun種別(なければ null) */
  active(): RunKind | null;
}

export function createRunCoordinator(): RunCoordinator {
  let current: RunLease | null = null;

  return {
    acquire(kind, runId) {
      if (current) return err({ kind: "conflict", active: current.kind });
      const lease: RunLease = {
        kind,
        runId,
        release() {
          // 自分が保持中のリースである場合のみ解放する(二重解放の無害化)
          if (current === lease) current = null;
        },
      };
      current = lease;
      return ok(lease);
    },
    active() {
      return current?.kind ?? null;
    },
  };
}
