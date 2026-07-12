import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { BackupServiceImpl } from "../src/services/backupService.js";
import { StateStoreImpl } from "../src/services/stateStore.js";
import { createProgressBus, type ProgressEvent } from "../src/services/progressBus.js";
import { QiitaApiClientImpl } from "../src/infra/qiitaApiClient.js";
import { ImageDownloaderImpl } from "../src/infra/imageDownloader.js";
import { StorageManagerImpl } from "../src/infra/storageManager.js";
import { createGitManager } from "../src/infra/gitManager.js";
import { createTokenStore } from "../src/config/tokenStore.js";
import { startMockQiita, makeRawItem, type MockQiitaServer, type MockQiitaOptions } from "./helpers/mockQiitaServer.js";
import { startMockImageHost, type MockImageHost } from "./helpers/mockImageHost.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

/** フルスタック(モックQiita+モック画像ホスト+実Git+一時フォルダ)を組み立てる */
async function buildStack(qiitaOptions: MockQiitaOptions, imageRoutes: Parameters<typeof startMockImageHost>[0] = {}) {
  const mock = await startMockQiita({ validToken: "tok", ...qiitaOptions });
  const imageHost = await startMockImageHost(imageRoutes);
  closers.push(mock.close, imageHost.close);

  const root = join(mkdtempSync(join(tmpdir(), "qbt-bk-")), "backup");
  const tokenStore = createTokenStore("tok");
  const storage = new StorageManagerImpl(root);
  const stateStore = new StateStoreImpl(storage);
  await stateStore.loadIndex();
  const gitManager = await createGitManager(root);
  const bus = createProgressBus();
  const events: ProgressEvent[] = [];
  bus.subscribe((e) => events.push(e));

  const backup = new BackupServiceImpl(
    {
      qiitaClient: new QiitaApiClientImpl(tokenStore, { baseUrl: mock.url }),
      imageDownloader: new ImageDownloaderImpl({ intervalMs: 0 }),
      storageManager: storage,
      gitManager,
      stateStore,
      progressBus: bus,
    },
    { listRetryDelayMs: 10 },
  );
  return { backup, stateStore, storage, root, mock, imageHost, bus, events };
}

describe("BackupService(3.3)", () => {
  it("差分Run一式: 取得→画像→書換→保存→状態更新→コミットまで完了する", async () => {
    const stack = await buildStack({}, { "/img/photo.png": { contentType: "image/png" } });
    const imageUrl = `${stack.imageHost.origin}/img/photo.png`;
    stack.mock.setItems([
      makeRawItem({
        id: "new1",
        title: "新規記事",
        body: `# 新規\n\n![図](${imageUrl})`,
      }),
    ]);

    const started = stack.backup.start({ mode: "diff" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const summary = await started.value.done;

    expect(summary.total).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.cancelled).toBe(false);
    expect(summary.commit).not.toBeNull();

    // 閲覧用Markdownは相対パスへ書換済み、original.mdは元URLのまま(3.6, 3.7)
    const dir = join(stack.root, "新規記事_new1");
    expect(readFileSync(join(dir, "新規記事.md"), "utf8")).toContain("images/001_photo.png");
    expect(readFileSync(join(dir, "original.md"), "utf8")).toContain(imageUrl);
    expect(existsSync(join(dir, "images", "001_photo.png"))).toBe(true);

    // 状態は最新になる
    const views = stack.stateStore.classify([
      {
        id: "new1", title: "新規記事", body: "", url: "", createdAt: "",
        updatedAt: "2026-01-01T10:00:00+09:00", private: false, tags: [],
        commentsCount: 0, likesCount: 0, stocksCount: 0,
      },
    ]);
    expect(views[0]!.status).toBe("upToDate");

    // Gitコミットが1件でき、メッセージに件数が含まれる(6.3)
    const log = await simpleGit(stack.root).log();
    expect(log.total).toBe(1);
    const fullMessage = await simpleGit(stack.root).raw(["log", "-1", "--format=%B"]);
    expect(fullMessage).toContain("成功: 1件");

    // イベント: run-start → progress → article-done → run-done の順序
    const types = stack.events.map((e) => e.type);
    expect(types[0]).toBe("run-start");
    expect(types).toContain("article-done");
    expect(types[types.length - 1]).toBe("run-done");

    // 差分モード: 変更がなければ2回目のRunは対象0件・コミットなし
    const second = stack.backup.start({ mode: "diff" });
    if (!second.ok) return expect.fail("2回目のRunが開始できない");
    const summary2 = await second.value.done;
    expect(summary2.total).toBe(0);
    expect(summary2.commit).toBeNull();
  });

  it("実行中の開始要求は競合エラーになる(排他制御)", async () => {
    const stack = await buildStack({});
    stack.mock.setItems([makeRawItem({ id: "a1" })]);
    const first = stack.backup.start({ mode: "all" });
    expect(first.ok).toBe(true);
    const second = stack.backup.start({ mode: "all" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.kind).toBe("conflict");
    if (first.ok) await first.value.done;
    // Run終了後は再び開始できる
    const third = stack.backup.start({ mode: "diff" });
    expect(third.ok).toBe(true);
    if (third.ok) await third.value.done;
  });

  it("中断時: 処理済み記事を保持したままindex保存+コミットを行う(3.10, 6.3)", async () => {
    const stack = await buildStack({});
    stack.mock.setItems([
      makeRawItem({ id: "a1", title: "記事1" }),
      makeRawItem({ id: "a2", title: "記事2" }),
      makeRawItem({ id: "a3", title: "記事3" }),
    ]);
    // 最初の記事完了直後に中断を指示する
    stack.bus.subscribe((e) => {
      if (e.type === "article-done") stack.backup.cancel();
    });

    const started = stack.backup.start({ mode: "all" });
    if (!started.ok) return expect.fail("開始失敗");
    const summary = await started.value.done;

    expect(summary.cancelled).toBe(true);
    expect(summary.succeeded).toBe(1);
    expect(summary.total).toBe(3);

    // 処理済み記事は保存済み・index.jsonにも記録済み
    expect(existsSync(join(stack.root, "記事1_a1", "記事1.md"))).toBe(true);
    expect(existsSync(join(stack.root, "記事2_a2", "記事2.md"))).toBe(false);
    const index = JSON.parse(readFileSync(join(stack.root, "index.json"), "utf8"));
    expect(Object.keys(index.articles)).toEqual(["a1"]);
    // 中断でもコミットされる(6.3)
    const log = await simpleGit(stack.root).log();
    expect(log.total).toBe(1);
    expect(await simpleGit(stack.root).raw(["log", "-1", "--format=%B"])).toContain("中断");
  });

  it("429受信時は再開時刻まで待機して自動再開する(3.12)", async () => {
    const stack = await buildStack({
      items: [makeRawItem({ id: "a1", title: "記事1" })],
      rateLimitFirstN: { count: 1, resetAfterSec: 1 },
    });
    const started = stack.backup.start({ mode: "diff" });
    if (!started.ok) return expect.fail("開始失敗");
    const summary = await started.value.done;

    expect(summary.succeeded).toBe(1);
    const types = stack.events.map((e) => e.type);
    expect(types).toContain("waiting-rate-limit");
    // 429の後に自動再開して2回目の一覧リクエストが行われた
    expect(stack.mock.itemRequestCount()).toBe(2);
  }, 15_000);

  it("「ローカル変更あり」記事を含むRunは上書き確認済みフラグを要求する(5.5)", async () => {
    const stack = await buildStack({});
    stack.backup.updateArticleCache([
      {
        id: "m1", title: "改変記事", body: "", url: "", createdAt: "",
        updatedAt: "", private: false, tags: [], commentsCount: 0, likesCount: 0,
        stocksCount: 0, status: "localModified", lastBackupAt: "2026-01-01T00:00:00Z",
        folderName: "改変記事_m1",
      },
    ]);
    const denied = stack.backup.start({ mode: "all" });
    expect(denied.ok).toBe(false);
    if (!denied.ok && denied.error.kind === "needsOverwriteConfirm") {
      expect(denied.error.articleIds).toEqual(["m1"]);
    } else {
      expect.fail(`needsOverwriteConfirm を期待したが: ${JSON.stringify(denied)}`);
    }

    // confirmOverwrite=true なら開始できる
    stack.mock.setItems([makeRawItem({ id: "m1", title: "改変記事" })]);
    const allowed = stack.backup.start({ mode: "all", confirmOverwrite: true });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) await allowed.value.done;
  });
});
