import { describe, it, expect } from "vitest";
import {
  QIITA_EDITOR_PROFILE,
  createQiitaEditorProfile,
  detectImageType,
  isAllowedImageUrl,
  isEditorUrl,
  isQiitaUrl,
} from "../src/infra/qiitaEditorProfile.js";

describe("QiitaEditorProfile(image-upload-automation 6.3, 8.1, 11.1)", () => {
  it("Qiitaのドメインだけを自動操作の遷移先として認める", () => {
    expect(isQiitaUrl(QIITA_EDITOR_PROFILE, "https://qiita.com/drafts/new")).toBe(true);
    expect(isQiitaUrl(QIITA_EDITOR_PROFILE, "https://qiita.com.evil.example/drafts/new")).toBe(false);
    expect(isQiitaUrl(QIITA_EDITOR_PROFILE, "http://qiita.com/drafts/new")).toBe(false);
    expect(isQiitaUrl(QIITA_EDITOR_PROFILE, "https://github.com/login")).toBe(false);
    expect(isQiitaUrl(QIITA_EDITOR_PROFILE, "not a url")).toBe(false);
  });

  it("エディタ画面(新規作成・下書き編集)のURLを判定する", () => {
    expect(isEditorUrl(QIITA_EDITOR_PROFILE, "https://qiita.com/drafts/new")).toBe(true);
    expect(isEditorUrl(QIITA_EDITOR_PROFILE, "https://qiita.com/drafts/981084b3cd7294a3e8a5/edit")).toBe(true);
    expect(isEditorUrl(QIITA_EDITOR_PROFILE, "https://qiita.com/login?redirect_to=%2Fdrafts%2Fnew")).toBe(false);
    expect(isEditorUrl(QIITA_EDITOR_PROFILE, "https://qiita.com/drafts")).toBe(false);
  });

  it("テスト用に接続先を差し替えたプロファイルでも同じ判定ができる", () => {
    const profile = createQiitaEditorProfile("http://127.0.0.1:4567");
    expect(isEditorUrl(profile, "http://127.0.0.1:4567/drafts/new")).toBe(true);
    expect(isQiitaUrl(profile, "http://127.0.0.1:4567/login")).toBe(true);
    expect(isQiitaUrl(profile, "https://qiita.com/drafts/new")).toBe(false);
  });

  it("画像URLはQiitaの画像配信ホスト(https)だけを許可する", () => {
    expect(isAllowedImageUrl("https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/3764962/f8.png")).toBe(true);
    expect(isAllowedImageUrl("https://qiita-image-store.s3.amazonaws.com/0/1/x.png")).toBe(true);
    expect(isAllowedImageUrl("http://qiita-image-store.s3.amazonaws.com/0/1/x.png")).toBe(false);
    expect(isAllowedImageUrl("https://qiita-image-store.s3.amazonaws.com.evil.example/x.png")).toBe(false);
    expect(isAllowedImageUrl("https://evil-qiita-image-store.s3.amazonaws.com/x.png")).toBe(false);
    expect(isAllowedImageUrl("https://example.com/x.png")).toBe(false);
  });

  it("画像の形式を拡張子と先頭バイトの両方で判定する", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const gif = Buffer.from("GIF89a");
    expect(detectImageType("a.png", png)).toEqual({ ok: true, value: "png" });
    expect(detectImageType("a.JPG", jpeg)).toEqual({ ok: true, value: "jpeg" });
    expect(detectImageType("a.gif", gif)).toEqual({ ok: true, value: "gif" });
    expect(detectImageType("a.svg", Buffer.from("<svg>")).ok).toBe(false);
    expect(detectImageType("fake.png", Buffer.from("text")).ok).toBe(false); // 拡張子と中身が一致しない
  });
});
