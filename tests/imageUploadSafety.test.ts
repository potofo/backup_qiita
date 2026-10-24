/**
 * 画像アップロード機能の安全性の検証(image-upload-automation タスク6.2 — 5.4, 11.1, 11.2, 11.3)
 * - 依存の閉じ込め(playwright-core を読むのは1ファイルだけ・ブラウザ操作部品はトークンに依存しない)
 * - ログにセッション情報・画像の内容が出ないこと
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileLogger } from "../src/config/logger.js";
import { BrowserImageUploaderImpl } from "../src/infra/browserImageUploader.js";
import { createQiitaEditorProfile } from "../src/infra/qiitaEditorProfile.js";
import { StorageManagerImpl } from "../src/infra/storageManager.js";
import { ImageMapStoreImpl } from "../src/infra/imageMapStore.js";
import { ImageUploadSettingsStoreImpl } from "../src/infra/imageUploadSettingsStore.js";
import { ImageUploadPlannerImpl } from "../src/services/imageUploadPlanner.js";
import { ImageUploadServiceImpl } from "../src/services/imageUploadService.js";
import { createProgressBus } from "../src/services/progressBus.js";
import { createFakeUploader } from "./helpers/fakeEditorImageUploader.js";
import { startMockQiitaEditor } from "./helpers/mockQiitaEditor.js";

const SRC = join(import.meta.dirname, "..", "src");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

describe("依存の閉じ込め(steering tech.md / 11.2)", () => {
  it("playwright-core を参照するのは browserImageUploader.ts だけ", () => {
    const users = sourceFiles(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("playwright-core"))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"));
    expect(users).toEqual(["infra/browserImageUploader.ts"]);
  });

  it("ブラウザ操作部品はアクセストークン・認証ヘッダ・設定(.env)に依存しない", () => {
    const source = readFileSync(join(SRC, "infra", "browserImageUploader.ts"), "utf8");
    expect(source).not.toMatch(/tokenStore|TokenStore|config\/env|Authorization|QIITA_ACCESS_TOKEN/);
  });
});

const PNG_SECRET = "PNG-CONTENT-SHOULD-NOT-BE-LOGGED";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(PNG_SECRET)]);

describe("ログの規律(11.3)", () => {
  it("画像フェーズのログは画像名・URL・結果に限られ、画像の内容を含まない", async () => {
    const base = mkdtempSync(join(tmpdir(), "qbt-safe-"));
    const root = join(base, "backup");
    mkdirSync(join(root, "d"), { recursive: true });
    writeFileSync(join(root, "d", "a.png"), PNG);
    const logger = createFileLogger(join(base, "logs"));
    const storage = new StorageManagerImpl(root);
    const mapStore = new ImageMapStoreImpl(storage);
    const fake = createFakeUploader();
    const service = new ImageUploadServiceImpl({
      uploader: fake.uploader,
      imageMapStore: mapStore,
      progressBus: createProgressBus(),
      settingsStore: new ImageUploadSettingsStoreImpl(join(base, ".image-upload")),
      logger,
    });
    const plan = new ImageUploadPlannerImpl({ storageManager: storage, imageMapStore: mapStore }).plan([
      { key: "local:d", title: "D", folderName: "d", body: "![a](a.png)" },
    ]);
    if (!plan.ok) return expect.fail(plan.error.message);
    await service.run(plan.value, { cancelled: false });
    await logger.flush();

    const log = readFileSync(join(base, "logs", "app.log"), "utf8");
    expect(log).toContain("a.png");
    expect(log).not.toContain(PNG_SECRET);
  });
});

const browserAvailable = await (async () => {
  try {
    const { chromium } = await import("playwright-core");
    for (const channel of ["msedge", "chrome"]) {
      try {
        const browser = await chromium.launch({ channel, headless: true });
        await browser.close();
        return true;
      } catch {
        // 次のチャネルを試す
      }
    }
  } catch {
    // playwright-core 未導入
  }
  return false;
})();

describe.skipIf(!browserAvailable)("実ブラウザでのログと遷移先(5.4, 11.1, 11.3)", () => {
  it("ログイン〜投入〜終了の間、ログにCookie・セッションの値が出ず、一時プロファイルも残らない", async () => {
    const base = mkdtempSync(join(tmpdir(), "qbt-safe-b-"));
    const logger = createFileLogger(join(base, "logs"));
    const editor = await startMockQiitaEditor({ requireLogin: true });
    const uploader = new BrowserImageUploaderImpl({
      persistentProfileDir: join(base, "browser-profile"),
      profile: createQiitaEditorProfile(editor.origin),
      headless: true,
      logger,
    });
    const image = join(base, "a.png");
    writeFileSync(image, PNG);
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    if (!opened.ok) return expect.fail(JSON.stringify(opened.error));
    const session = opened.value;
    try {
      const waiting = session.waitUntilReady(15_000, { cancelled: false });
      await session.debugPage().click("#login"); // 利用者のログイン操作(Cookie mock_session=1 が設定される)
      expect((await waiting).ok).toBe(true);
      expect((await session.uploadImage(image, 10_000)).ok).toBe(true);
      // ツール自身が開いたのは模擬エディタ(=Qiita相当)のオリジンの画面だけ
      expect(session.debugPage().url().startsWith(editor.origin)).toBe(true);
    } finally {
      await session.close();
      await editor.close();
    }
    await logger.flush();
    const log = readFileSync(join(base, "logs", "app.log"), "utf8");
    expect(log).toContain("ブラウザを起動しました");
    expect(log).not.toMatch(/mock_session|cookie/i);
    expect(log).not.toContain(PNG_SECRET);
    expect(existsSync(join(base, "browser-profile"))).toBe(false); // 保存なしでは専用フォルダも作らない
  }, 60_000);
});
