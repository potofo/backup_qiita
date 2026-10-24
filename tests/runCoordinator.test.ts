import { describe, it, expect } from "vitest";
import { createRunCoordinator } from "../src/services/runCoordinator.js";

describe("RunCoordinator(article-upload-sync 8.4)", () => {
  it("空き状態では獲得に成功し、activeがRun種別を返す", () => {
    const coordinator = createRunCoordinator();
    expect(coordinator.active()).toBeNull();

    const lease = coordinator.acquire("backup", "run-1");
    expect(lease.ok).toBe(true);
    expect(coordinator.active()).toBe("backup");
  });

  it("バックアップRun実行中はアップロードRunの獲得が競合エラーになる(実行中のkindを含む)", () => {
    const coordinator = createRunCoordinator();
    const first = coordinator.acquire("backup", "run-1");
    expect(first.ok).toBe(true);

    const second = coordinator.acquire("upload", "run-2");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.kind).toBe("conflict");
      expect(second.error.active).toBe("backup");
    }
  });

  it("アップロードRun実行中はバックアップRunの獲得が競合エラーになる(逆方向)", () => {
    const coordinator = createRunCoordinator();
    const first = coordinator.acquire("upload", "run-1");
    expect(first.ok).toBe(true);

    const second = coordinator.acquire("backup", "run-2");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.active).toBe("upload");
  });

  it("同種別のRun同士でも同時実行は1件に制限される", () => {
    const coordinator = createRunCoordinator();
    const first = coordinator.acquire("backup", "run-1");
    expect(first.ok).toBe(true);
    const second = coordinator.acquire("backup", "run-2");
    expect(second.ok).toBe(false);
  });

  it("release後は再び獲得できる", () => {
    const coordinator = createRunCoordinator();
    const first = coordinator.acquire("backup", "run-1");
    if (!first.ok) return expect.fail("獲得失敗");
    first.value.release();
    expect(coordinator.active()).toBeNull();

    const second = coordinator.acquire("upload", "run-2");
    expect(second.ok).toBe(true);
    expect(coordinator.active()).toBe("upload");
  });

  it("releaseの二重呼び出しは無害(後続のリースを誤って解放しない)", () => {
    const coordinator = createRunCoordinator();
    const first = coordinator.acquire("backup", "run-1");
    if (!first.ok) return expect.fail("獲得失敗");
    first.value.release();
    const second = coordinator.acquire("upload", "run-2");
    expect(second.ok).toBe(true);

    // 旧リースの再解放は現行リースへ影響しない
    first.value.release();
    expect(coordinator.active()).toBe("upload");
  });
});
