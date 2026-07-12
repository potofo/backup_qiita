/**
 * 統合テスト(タスク6.1)
 * モックQiitaサーバに対するRun一式のシナリオ検証。
 * (429待機→自動再開・中断時の部分保存はbackupService.test.tsでも検証済み)
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { BackupServiceImpl } from "../src/services/backupService.js";
import { StateStoreImpl } from "../src/services/stateStore.js";
import { createProgressBus, type ProgressEvent } from "../src/services/progressBus.js";
import { QiitaApiClientImpl } from "../src/infra/qiitaApiClient.js";
import { ImageDownloaderImpl } from "../src/infra/imageDownloader.js";
import { StorageManagerImpl, type StorageManager } from "../src/infra/storageManager.js";
import { createGitManager } from "../src/infra/gitManager.js";
import { createTokenStore } from "../src/config/tokenStore.js";
import { err } from "../src/types/index.js";
import {
  startMockQiita,
  makeRawItem,
  type MockQiitaServer,
  type MockQiitaOptions,
} from "./helpers/mockQiitaServer.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

type StackOptions = {
  qiita?: MockQiitaOptions;
  gitBinary?: string;
  wrapStorage?: (storage: StorageManager) => StorageManager;
};

async function buildStack(options: StackOptions = {}) {
  const mock = await startMockQiita({ validToken: "tok", ...options.qiita });
  closers.push(mock.close);

  const root = join(mkdtempSync(join(tmpdir(), "qbt-it-")), "backup");
  const tokenStore = createTokenStore("tok");
  const realStorage = new StorageManagerImpl(root);
  const storage = options.wrapStorage ? options.wrapStorage(realStorage) : realStorage;
  const stateStore = new StateStoreImpl(storage);
  await stateStore.loadIndex();
  const gitManager = await createGitManager(
    root,
    undefined,
    options.gitBinary ? { gitBinary: options.gitBinary } : {},
  );
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
  return { backup, stateStore, storage, gitManager, root, mock, bus, events };
}

const runToCompletion = async (backup: BackupServiceImpl, mode: "all" | "diff" | "selected", ids?: string[]) => {
  const started = backup.start({ mode, ids, confirmOverwrite: true });
  if (!started.ok) throw new Error(`Run開始に失敗: ${JSON.stringify(started.error)}`);
  return started.value.done;
};

describe("統合テスト(6.1)", () => {
  it("差分判定→保存→管理情報更新→コミットのRun一式(未/更新/最新の混在)", async () => {
    const stack = await buildStack();
    // 1回目: 2記事をバックアップ
    stack.mock.setItems([
      makeRawItem({ id: "a1", title: "既存記事", updated_at: "2026-01-01T10:00:00+09:00" }),
      makeRawItem({ id: "a2", title: "更新される記事", updated_at: "2026-01-01T10:00:00+09:00" }),
    ]);
    const first = await runToCompletion(stack.backup, "all");
    expect(first.succeeded).toBe(2);

    // 2回目: a2がQiita側で更新され、a3が新規追加された
    stack.mock.setItems([
      makeRawItem({ id: "a1", title: "既存記事", updated_at: "2026-01-01T10:00:00+09:00" }),
      makeRawItem({ id: "a2", title: "更新される記事", body: "# 更新後の本文", updated_at: "2026-02-01T10:00:00+09:00" }),
      makeRawItem({ id: "a3", title: "新規記事" }),
    ]);
    const second = await runToCompletion(stack.backup, "diff");

    // 差分対象はa2(Qiita側更新)とa3(未バックアップ)のみ
    expect(second.total).toBe(2);
    expect(second.succeeded).toBe(2);
    expect(readFileSync(join(stack.root, "更新される記事_a2", "更新される記事.md"), "utf8")).toBe("# 更新後の本文");

    // 管理情報が更新されている
    const index = JSON.parse(readFileSync(join(stack.root, "index.json"), "utf8"));
    expect(Object.keys(index.articles).sort()).toEqual(["a1", "a2", "a3"]);
    expect(index.articles.a2.qiitaUpdatedAt).toBe("2026-02-01T10:00:00+09:00");
    expect(index.history.length).toBeGreaterThanOrEqual(2);

    // Runごとにコミットが積まれる
    const log = await simpleGit(stack.root).log();
    expect(log.total).toBe(2);
  });

  it("Git不在環境: 警告状態(available=false)のまま世代管理なしでバックアップを継続する(6.6)", async () => {
    const stack = await buildStack({
      qiita: { items: [makeRawItem({ id: "a1", title: "記事1" })] },
      gitBinary: "C:\\nonexistent\\git-not-installed.exe",
    });
    expect(stack.gitManager.available).toBe(false); // UIはこれを見て警告を表示する

    const summary = await runToCompletion(stack.backup, "diff");
    expect(summary.succeeded).toBe(1);
    expect(summary.commit).toBeNull(); // 世代管理なし

    // バックアップ自体は成功し、.gitは作られない
    expect(existsSync(join(stack.root, "記事1_a1", "記事1.md"))).toBe(true);
    expect(existsSync(join(stack.root, "index.json"))).toBe(true);
    expect(existsSync(join(stack.root, ".git"))).toBe(false);
  });

  it("記事単位リトライ上限超過: 当該記事を失敗記録し、他の記事の処理を継続する(9.2)", async () => {
    let badArticleAttempts = 0;
    const stack = await buildStack({
      qiita: {
        items: [
          makeRawItem({ id: "bad1", title: "保存に失敗する記事" }),
          makeRawItem({ id: "good1", title: "正常な記事" }),
        ],
      },
      wrapStorage: (storage) => ({
        get root() {
          return storage.root;
        },
        prepareArticleDir: (a) => storage.prepareArticleDir(a),
        saveArticle: async (article, md, images) => {
          if (article.id === "bad1") {
            badArticleAttempts += 1;
            return err({ kind: "io" as const, message: "ディスク書き込みエラー(注入)" });
          }
          return storage.saveArticle(article, md, images);
        },
        writeJsonAtomic: (p, d) => storage.writeJsonAtomic(p, d),
        readJson: (p) => storage.readJson(p),
        openFolder: (id) => storage.openFolder(id),
        findFolderById: (id) => storage.findFolderById(id),
        imagesDirFor: (a) => storage.imagesDirFor(a),
      }),
    });

    const summary = await runToCompletion(stack.backup, "all");

    // リトライ上限(初回+2回=3試行)まで試みてから失敗記録
    expect(badArticleAttempts).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(1); // 他の記事は継続処理された
    expect(existsSync(join(stack.root, "正常な記事_good1", "正常な記事.md"))).toBe(true);

    // 失敗記事はarticle-doneイベントでok=falseとして通知される
    const failEvent = stack.events.find((e) => e.type === "article-done" && !e.ok);
    expect(failEvent).toBeDefined();

    // indexには成功記事のみ記録される
    const index = JSON.parse(readFileSync(join(stack.root, "index.json"), "utf8"));
    expect(Object.keys(index.articles)).toEqual(["good1"]);
  });

  it("ローカル変更ありの記事をconfirmOverwrite付きで再バックアップするとQiita側の内容で上書きされる(5.5)", async () => {
    const stack = await buildStack({
      qiita: { items: [makeRawItem({ id: "a1", title: "記事1", body: "# Qiita側の本文" })] },
    });
    await runToCompletion(stack.backup, "all");

    // ローカルで改変する
    const mdPath = join(stack.root, "記事1_a1", "記事1.md");
    writeFileSync(mdPath, "# ローカルで改変した本文", "utf8");

    // 一覧再取得相当: 分類してキャッシュを更新すると localModified になる
    const itemsResult = await new QiitaApiClientImpl(createTokenStore("tok"), {
      baseUrl: stack.mock.url,
    }).fetchAllItems();
    if (!itemsResult.ok) throw new Error("一覧取得失敗");
    const views = stack.stateStore.classify(itemsResult.value);
    expect(views[0]!.status).toBe("localModified");
    stack.backup.updateArticleCache(views);

    // 確認なしは拒否される
    const denied = stack.backup.start({ mode: "all" });
    expect(denied.ok).toBe(false);

    // 確認ありで上書きされる
    const summary = await runToCompletion(stack.backup, "all");
    expect(summary.succeeded).toBe(1);
    expect(readFileSync(mdPath, "utf8")).toBe("# Qiita側の本文");
  });
});
