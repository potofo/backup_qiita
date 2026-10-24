import { describe, it, expect } from "vitest";
import { createProgressBus } from "../src/services/progressBus.js";

describe("ProgressBus — 画像フェーズのイベント(image-upload-automation 4.3, 6.5)", () => {
  it("ログイン待機中はスナップショットに待機期限を保持し、画像の進捗で解除される", () => {
    const bus = createProgressBus();
    bus.emit({ type: "run-start", runId: "r1", mode: "changes", direction: "upload" });
    bus.emit({ type: "image-login-waiting", timeoutAt: "2026-10-25T09:00:00.000Z" });
    expect(bus.snapshot().loginWaitingUntil).toBe("2026-10-25T09:00:00.000Z");

    bus.emit({ type: "image-progress", done: 0, total: 3, currentName: "a.png" });
    const snap = bus.snapshot();
    expect(snap.loginWaitingUntil).toBeNull();
    expect(snap.image).toEqual({ done: 0, total: 3, currentName: "a.png" });
  });

  it("画像1枚の結果イベントを購読者へ中継し、Run終了で画像の状態を消す", () => {
    const bus = createProgressBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    bus.emit({ type: "run-start", runId: "r1", mode: "changes", direction: "upload" });
    bus.emit({ type: "image-progress", done: 1, total: 1, currentName: "a.png" });
    bus.emit({ type: "image-done", name: "a.png", ok: false, reason: "タイムアウト" });
    expect(seen).toContain("image-done");

    bus.emit({
      type: "run-done",
      summary: {
        runId: "r1",
        mode: "changes",
        startedAt: "",
        finishedAt: "",
        total: 0,
        succeeded: 0,
        failed: 0,
        imageFailures: [],
        cancelled: false,
        commit: null,
      },
    });
    expect(bus.snapshot().image).toBeNull();
    expect(bus.snapshot().loginWaitingUntil).toBeNull();
  });
});
