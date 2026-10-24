import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageUploadSettingsStoreImpl } from "../src/infra/imageUploadSettingsStore.js";

const makeDir = (): string => join(mkdtempSync(join(tmpdir(), "qbt-set-")), ".image-upload");

describe("ImageUploadSettingsStore(image-upload-automation 1.1, 1.4, 5.1〜5.3, 9.1)", () => {
  it("設定ファイルがなければ無効・同意なし・セッション保存なしを既定とする", () => {
    const store = new ImageUploadSettingsStoreImpl(makeDir());
    expect(store.get()).toEqual({
      schemaVersion: 1,
      enabled: false,
      consentedAt: null,
      persistSession: false,
      workDraftUrl: null,
    });
    expect(store.hasSavedSession()).toBe(false);
  });

  it("同意が記録されていない状態での有効化を拒否する", () => {
    const store = new ImageUploadSettingsStoreImpl(makeDir());
    const result = store.update({ enabled: true });
    expect(result).toEqual({ ok: false, error: { kind: "consentRequired" } });
    expect(store.get().enabled).toBe(false);
  });

  it("同意と同時の有効化は成功し、同意日時と設定がファイルに保存される", () => {
    const dir = makeDir();
    const store = new ImageUploadSettingsStoreImpl(dir, { now: () => new Date("2026-10-25T00:00:00.000Z") });
    const result = store.update({ enabled: true, consent: true });
    expect(result.ok && result.value.enabled).toBe(true);
    expect(result.ok && result.value.consentedAt).toBe("2026-10-25T00:00:00.000Z");

    // 別インスタンスからも読める(永続化)
    const reloaded = new ImageUploadSettingsStoreImpl(dir).get();
    expect(reloaded.enabled).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).consentedAt).toBe("2026-10-25T00:00:00.000Z");
  });

  it("一度同意した後は、無効化と再有効化に同意を求めない", () => {
    const store = new ImageUploadSettingsStoreImpl(makeDir());
    store.update({ enabled: true, consent: true });
    expect(store.update({ enabled: false }).ok).toBe(true);
    expect(store.update({ enabled: true }).ok).toBe(true);
  });

  it("作業用下書きURLを記録できる(Qiitaの下書き編集画面以外は記録しない)", () => {
    const store = new ImageUploadSettingsStoreImpl(makeDir());
    store.update({ workDraftUrl: "https://qiita.com/drafts/abc123/edit" });
    expect(store.get().workDraftUrl).toBe("https://qiita.com/drafts/abc123/edit");
    const bad = store.update({ workDraftUrl: "https://evil.example.com/drafts/x/edit" });
    expect(bad.ok).toBe(false);
    expect(store.get().workDraftUrl).toBe("https://qiita.com/drafts/abc123/edit");
  });

  it("保存済みセッションを削除し、セッション保存を無効に戻す", () => {
    const dir = makeDir();
    const store = new ImageUploadSettingsStoreImpl(dir);
    store.update({ persistSession: true });
    const profile = store.profileDir();
    mkdirSync(join(profile, "Default", "Network"), { recursive: true });
    writeFileSync(join(profile, "Default", "Network", "Cookies"), "secret", "utf8");
    expect(store.hasSavedSession()).toBe(true);

    expect(store.clearSession().ok).toBe(true);
    expect(existsSync(profile)).toBe(false);
    expect(store.hasSavedSession()).toBe(false);
    expect(store.get().persistSession).toBe(false);
  });

  it("壊れた設定ファイルは既定値として扱う", () => {
    const dir = makeDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{ broken", "utf8");
    expect(new ImageUploadSettingsStoreImpl(dir).get().enabled).toBe(false);
  });
});
