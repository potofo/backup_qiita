import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserImageUploaderImpl, type PlaywrightLike } from "../src/infra/browserImageUploader.js";
import { createQiitaEditorProfile } from "../src/infra/qiitaEditorProfile.js";

/** 起動・終了だけを検証するための偽 Playwright(実ブラウザを起動しない) */
const fakePlaywright = (failChannels: string[] = []) => {
  const launches: { userDataDir: string; channel: string | undefined; headless: boolean | undefined }[] = [];
  const gotos: string[] = [];
  let contextCloses = 0;
  const module: PlaywrightLike = {
    chromium: {
      async launchPersistentContext(userDataDir, options) {
        launches.push({ userDataDir, channel: options.channel, headless: options.headless });
        if (options.channel && failChannels.includes(options.channel)) throw new Error(`${options.channel} not found`);
        mkdirSync(join(userDataDir, "Default"), { recursive: true }); // ブラウザがプロファイルを書いた状態を再現
        const page = {
          async goto(url: string) {
            gotos.push(url);
            return { status: () => 200 };
          },
          url: () => gotos[gotos.length - 1] ?? "about:blank",
        };
        return {
          pages: () => [page],
          newPage: async () => page,
          on: () => undefined,
          close: async () => {
            contextCloses += 1;
          },
        } as unknown as Awaited<ReturnType<PlaywrightLike["chromium"]["launchPersistentContext"]>>;
      },
    },
  };
  return { module, launches, gotos, closes: () => contextCloses };
};

const profileDir = (): string => join(mkdtempSync(join(tmpdir(), "qbt-prof-")), "browser-profile");

describe("BrowserImageUploader — 起動と終了(image-upload-automation 1.3, 4.1, 5.1, 5.2, 11.1)", () => {
  it("ブラウザ操作ライブラリを読み込めない場合は利用不可と理由を返す", async () => {
    const uploader = new BrowserImageUploaderImpl({
      persistentProfileDir: profileDir(),
      loadPlaywright: async () => {
        throw new Error("Cannot find package 'playwright-core'");
      },
    });
    const availability = await uploader.availability();
    expect(availability.available).toBe(false);
    if (!availability.available) expect(availability.reason).toContain("playwright-core");

    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.kind).toBe("launchFailed");
  });

  it("画面ありで Edge を優先し、起動できなければ Chrome を試す", async () => {
    const fake = fakePlaywright(["msedge"]);
    const uploader = new BrowserImageUploaderImpl({ persistentProfileDir: profileDir(), loadPlaywright: async () => fake.module });
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    expect(opened.ok).toBe(true);
    expect(fake.launches.map((l) => l.channel)).toEqual(["msedge", "chrome"]);
    expect(fake.launches.every((l) => l.headless === false)).toBe(true);
    expect(fake.gotos).toEqual(["https://qiita.com/drafts/new"]);
    if (opened.ok) await opened.value.close();
  });

  it("セッションを保存しない場合は一時プロファイルを使い、終了時に削除する。終了は何度呼んでもよい", async () => {
    const fake = fakePlaywright();
    const persistent = profileDir();
    const uploader = new BrowserImageUploaderImpl({ persistentProfileDir: persistent, loadPlaywright: async () => fake.module });
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    if (!opened.ok) return expect.fail("open failed");
    const tempDir = fake.launches[0]!.userDataDir;
    expect(tempDir).not.toBe(persistent);
    expect(existsSync(tempDir)).toBe(true);

    await opened.value.close();
    await opened.value.close();
    expect(existsSync(tempDir)).toBe(false);
    expect(fake.closes()).toBe(1);
  });

  it("セッションを保存する場合は専用フォルダを使い、終了しても削除しない", async () => {
    const fake = fakePlaywright();
    const persistent = profileDir();
    const uploader = new BrowserImageUploaderImpl({ persistentProfileDir: persistent, loadPlaywright: async () => fake.module });
    const opened = await uploader.open({ persistSession: true, workDraftUrl: null });
    if (!opened.ok) return expect.fail("open failed");
    expect(fake.launches[0]!.userDataDir).toBe(persistent);
    await opened.value.close();
    expect(existsSync(persistent)).toBe(true);
  });

  it("記録済みの作業用下書きを開く。Qiitaのエディタ以外のURLは開かず新規作成画面を開く", async () => {
    const fake = fakePlaywright();
    const uploader = new BrowserImageUploaderImpl({ persistentProfileDir: profileDir(), loadPlaywright: async () => fake.module });
    const a = await uploader.open({ persistSession: false, workDraftUrl: "https://qiita.com/drafts/abc123/edit" });
    if (a.ok) await a.value.close();
    const b = await uploader.open({ persistSession: false, workDraftUrl: "https://evil.example.com/drafts/abc/edit" });
    if (b.ok) await b.value.close();
    expect(fake.gotos).toEqual(["https://qiita.com/drafts/abc123/edit", "https://qiita.com/drafts/new"]);
  });

  it("どのチャネルでも起動できなければ launchFailed を返し、一時プロファイルを残さない", async () => {
    const fake = fakePlaywright(["msedge", "chrome"]);
    const uploader = new BrowserImageUploaderImpl({
      persistentProfileDir: profileDir(),
      loadPlaywright: async () => fake.module,
      profile: createQiitaEditorProfile("https://qiita.com"),
    });
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.kind).toBe("launchFailed");
    expect(existsSync(fake.launches[0]!.userDataDir)).toBe(false);
  });
});

// ---- 実ブラウザ+模擬エディタ画面(タスク2.6)。Edge/Chrome がない環境ではスキップする ----

import { writeFileSync } from "node:fs";
import { startMockQiitaEditor, type MockEditorOptions } from "./helpers/mockQiitaEditor.js";

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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe.skipIf(!browserAvailable)("BrowserImageUploader — 模擬エディタ画面での実ブラウザ操作(2.6)", () => {
  const setup = async (options: MockEditorOptions = {}) => {
    const editor = await startMockQiitaEditor(options);
    const uploader = new BrowserImageUploaderImpl({
      persistentProfileDir: profileDir(),
      profile: createQiitaEditorProfile(editor.origin),
      headless: true,
    });
    const imageDir = mkdtempSync(join(tmpdir(), "qbt-img-"));
    const image = (name: string): string => {
      const path = join(imageDir, name);
      writeFileSync(path, PNG);
      return path;
    };
    return { editor, uploader, image };
  };

  it("ログイン済みならすぐ準備完了になり、画像1枚のURLを取得して本文を空に戻す(6.1, 6.2, 9.3)", async () => {
    const { editor, uploader, image } = await setup();
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    if (!opened.ok) return expect.fail(JSON.stringify(opened.error));
    const session = opened.value;
    try {
      expect((await session.waitUntilReady(10_000, { cancelled: false })).ok).toBe(true);
      const first = await session.uploadImage(image("hero.png"), 10_000);
      expect(first.ok && first.value).toMatch(/^https:\/\/qiita-image-store\.s3\.ap-northeast-1\.amazonaws\.com\/0\/1\/mock-/);
      const second = await session.uploadImage(image("hero.png"), 10_000);
      expect(second.ok && second.value).not.toBe(first.ok && first.value); // 同名でも新しいURLを取り違えない
      expect(await session.editorText()).toBe(""); // 作業用下書きに記事内容を残さない
      expect(session.currentDraftUrl()).toBe(`${editor.origin}/drafts/mockdraft0001/edit`);
    } finally {
      await session.close();
      await editor.close();
    }
  }, 60_000);

  it("EditorView(cmView)に届く画面でも、URLを取得して本文を空に戻す", async () => {
    const { editor, uploader, image } = await setup({ exposeCmView: true });
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    if (!opened.ok) return expect.fail(JSON.stringify(opened.error));
    try {
      expect((await opened.value.waitUntilReady(10_000, { cancelled: false })).ok).toBe(true);
      const url = await opened.value.uploadImage(image("a.png"), 10_000);
      expect(url.ok).toBe(true);
      expect(await opened.value.editorText()).toBe("");
    } finally {
      await opened.value.close();
      await editor.close();
    }
  }, 60_000);

  it("ログイン画面にいる間は待機し、利用者がログインすると準備完了になる(4.3)", async () => {
    const { editor, uploader } = await setup({ requireLogin: true });
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    if (!opened.ok) return expect.fail(JSON.stringify(opened.error));
    const session = opened.value;
    try {
      const waiting = session.waitUntilReady(15_000, { cancelled: false });
      // 利用者の操作を再現: ログインボタンを押す(ID・パスワード欄にツールは触れない)
      await session.debugPage().click("#login");
      expect((await waiting).ok).toBe(true);
    } finally {
      await session.close();
      await editor.close();
    }
  }, 60_000);

  it("ログインが時間内に終わらなければ timeout、中断が指示されれば cancelled を返す(4.4, 4.5)", async () => {
    const { editor, uploader } = await setup({ requireLogin: true });
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    if (!opened.ok) return expect.fail(JSON.stringify(opened.error));
    try {
      expect(await opened.value.waitUntilReady(1_500, { cancelled: false })).toEqual({ ok: false, error: { kind: "timeout" } });
      expect(await opened.value.waitUntilReady(10_000, { cancelled: true })).toEqual({ ok: false, error: { kind: "cancelled" } });
    } finally {
      await opened.value.close();
      await editor.close();
    }
  }, 60_000);

  it("利用者がブラウザを閉じたら closedByUser を返す(4.4)", async () => {
    const { editor, uploader } = await setup({ requireLogin: true });
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    if (!opened.ok) return expect.fail(JSON.stringify(opened.error));
    try {
      const waiting = opened.value.waitUntilReady(15_000, { cancelled: false });
      await opened.value.debugPage().close();
      expect(await waiting).toEqual({ ok: false, error: { kind: "closedByUser" } });
    } finally {
      await opened.value.close();
      await editor.close();
    }
  }, 60_000);

  it("画像投入欄がない画面では editorElementMissing を返す(8.1)", async () => {
    const { editor, uploader } = await setup({ omitFileInput: true });
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    if (!opened.ok) return expect.fail(JSON.stringify(opened.error));
    try {
      const ready = await opened.value.waitUntilReady(10_000, { cancelled: false });
      expect(ready.ok).toBe(false);
      if (!ready.ok) expect(ready.error).toEqual({ kind: "editorElementMissing", element: 'input[type="file"]' });
    } finally {
      await opened.value.close();
      await editor.close();
    }
  }, 60_000);

  it("URLが挿入されなければ1枚の時間切れとして timeout を返す(6.4)", async () => {
    const { editor, uploader, image } = await setup({ neverInsert: true });
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    if (!opened.ok) return expect.fail(JSON.stringify(opened.error));
    try {
      expect((await opened.value.waitUntilReady(10_000, { cancelled: false })).ok).toBe(true);
      expect(await opened.value.uploadImage(image("a.png"), 1_500)).toEqual({ ok: false, error: { kind: "timeout" } });
    } finally {
      await opened.value.close();
      await editor.close();
    }
  }, 60_000);

  it("投稿ボタンには触れない(6.7)", async () => {
    const { editor, uploader, image } = await setup();
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    if (!opened.ok) return expect.fail(JSON.stringify(opened.error));
    try {
      await opened.value.waitUntilReady(10_000, { cancelled: false });
      await opened.value.uploadImage(image("a.png"), 10_000);
      // 模擬画面はリクエストのパスを記録する。投稿・保存の画面遷移やAPI呼び出しが一切ない
      expect(editor.requestedPaths.every((p) => p === "/drafts/new" || p === "/favicon.ico")).toBe(true);
    } finally {
      await opened.value.close();
      await editor.close();
    }
  }, 60_000);
});
