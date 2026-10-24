/**
 * 統合テスト(タスク6.1)
 * モックQiitaサーバに対するRun一式のシナリオ検証。
 * (429待機→自動再開・中断時の部分保存はbackupService.test.tsでも検証済み)
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { BackupServiceImpl } from "../src/services/backupService.js";
import { UploadServiceImpl } from "../src/services/uploadService.js";
import { AuthServiceImpl } from "../src/services/authService.js";
import { StateStoreImpl } from "../src/services/stateStore.js";
import { createRunCoordinator } from "../src/services/runCoordinator.js";
import { createProgressBus, type ProgressEvent } from "../src/services/progressBus.js";
import { QiitaApiClientImpl } from "../src/infra/qiitaApiClient.js";
import { ImageDownloaderImpl } from "../src/infra/imageDownloader.js";
import { StorageManagerImpl, type StorageManager } from "../src/infra/storageManager.js";
import { LocalArticleScannerImpl } from "../src/infra/localArticleScanner.js";
import { createGitManager } from "../src/infra/gitManager.js";
import { createTokenStore } from "../src/config/tokenStore.js";
import { EnvFileConfig } from "../src/config/env.js";
import { err, type ArticleView } from "../src/types/index.js";
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

  const dir = mkdtempSync(join(tmpdir(), "qbt-it-"));
  const root = join(dir, "backup");
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
  const qiitaClient = new QiitaApiClientImpl(tokenStore, { baseUrl: mock.url });
  // バックアップ/アップロードのRun排他を共有する(upload-sync 8.4)
  const coordinator = createRunCoordinator();
  const scanner = new LocalArticleScannerImpl(storage);
  const authService = new AuthServiceImpl(qiitaClient, tokenStore, new EnvFileConfig(join(dir, ".env")));

  const backup = new BackupServiceImpl(
    {
      qiitaClient,
      imageDownloader: new ImageDownloaderImpl({ intervalMs: 0 }),
      storageManager: storage,
      gitManager,
      stateStore,
      progressBus: bus,
      runCoordinator: coordinator,
    },
    { listRetryDelayMs: 10 },
  );
  const upload = new UploadServiceImpl(
    {
      qiitaClient,
      storageManager: storage,
      gitManager,
      stateStore,
      progressBus: bus,
      runCoordinator: coordinator,
      scanner,
      authService,
    },
    { retryLimit: 1 },
  );

  /** 一覧再取得相当: Qiita一覧+走査結果を分類して両サービスのキャッシュへ反映する */
  const refreshViews = async (): Promise<ArticleView[]> => {
    const items = await qiitaClient.fetchAllItems();
    if (!items.ok) throw new Error("一覧取得失敗");
    const drafts = scanner.scan(stateStore.knownIds());
    if (!drafts.ok) throw new Error("走査失敗");
    const views = stateStore.classify(items.value, drafts.value);
    backup.updateArticleCache(views);
    upload.updateArticleCache(views);
    return views;
  };

  return { backup, upload, stateStore, storage, gitManager, scanner, authService, root, mock, bus, events, refreshViews };
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
        normalizeDraft: (d, i) => storage.normalizeDraft(d, i),
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

describe("検証: 相互排他・E2E(upload-sync 11.1)", () => {
  it("バックアップRun実行中はアップロード開始が競合エラーになる(8.4)", async () => {
    const stack = await buildStack({ qiita: { items: [makeRawItem({ id: "a1", title: "記事1" })] } });
    mkdirSync(join(stack.root, "draft-x"), { recursive: true });
    writeFileSync(join(stack.root, "draft-x", "d.md"), "---\ntitle: X\ntags: [t]\n---\nx", "utf8");
    await stack.refreshViews();

    const backupRun = stack.backup.start({ mode: "diff" });
    expect(backupRun.ok).toBe(true);

    const uploadDenied = stack.upload.start({ mode: "changes", confirmed: true });
    expect(uploadDenied.ok).toBe(false);
    if (!uploadDenied.ok && uploadDenied.error.kind === "conflict") {
      expect(uploadDenied.error.active).toBe("backup");
    } else {
      expect.fail(`conflict を期待したが: ${JSON.stringify(uploadDenied)}`);
    }

    if (backupRun.ok) await backupRun.value.done;
    // バックアップ完了後はアップロードを開始できる
    const uploadOk = stack.upload.start({ mode: "changes", confirmed: true });
    expect(uploadOk.ok).toBe(true);
    if (uploadOk.ok) await uploadOk.value.done;
  });

  it("アップロードRun実行中はバックアップ開始が競合エラーになる(逆方向 — 8.4)", async () => {
    const stack = await buildStack();
    mkdirSync(join(stack.root, "draft-y"), { recursive: true });
    writeFileSync(join(stack.root, "draft-y", "d.md"), "---\ntitle: Y\ntags: [t]\n---\ny", "utf8");
    await stack.refreshViews();

    const uploadRun = stack.upload.start({ mode: "changes", confirmed: true });
    expect(uploadRun.ok).toBe(true);

    const backupDenied = stack.backup.start({ mode: "diff" });
    expect(backupDenied.ok).toBe(false);
    if (!backupDenied.ok) expect(backupDenied.error.kind).toBe("conflict");

    if (uploadRun.ok) await uploadRun.value.done;
    const backupOk = stack.backup.start({ mode: "diff" });
    expect(backupOk.ok).toBe(true);
    if (backupOk.ok) await backupOk.value.done;
  });

  it("モックE2E: 新規作成→検出→アップロード→「最新」→以後の差分バックアップ対象化(2.7, 7.3)", async () => {
    const stack = await buildStack();

    // 1. ローカルで新規記事を作成 → 検出される(1.1, 1.2)
    mkdirSync(join(stack.root, "私の新記事"), { recursive: true });
    writeFileSync(
      join(stack.root, "私の新記事", "本文.md"),
      "---\ntitle: E2Eテスト記事\ntags: [e2e]\n---\n# 本文\n\n初版です。",
      "utf8",
    );
    let views = await stack.refreshViews();
    expect(views.find((v) => v.id === "local:私の新記事")?.status).toBe("localNew");

    // 2. アップロード(確認付き) → 限定共有で登録、フォルダ正規化
    const uploadRun = stack.upload.start({ mode: "changes", confirmed: true });
    if (!uploadRun.ok) return expect.fail(`アップロード開始失敗: ${JSON.stringify(uploadRun)}`);
    const uploadSummary = await uploadRun.value.done;
    expect(uploadSummary.succeeded).toBe(1);
    const articleId = "created0001";
    expect(existsSync(join(stack.root, `E2Eテスト記事_${articleId}`))).toBe(true);

    // 3. 再取得 → 「最新」へ遷移(7.3)
    views = await stack.refreshViews();
    const uploaded = views.find((v) => v.id === articleId);
    expect(uploaded?.status).toBe("upToDate");
    expect(uploaded?.private).toBe(true); // 限定共有(5.1)

    // 4. Qiita側で更新される → 「Qiita側更新」として差分バックアップ対象になる(2.7)
    const current = stack.mock.writeRequests[0]!.body;
    stack.mock.setItems([
      makeRawItem({
        id: articleId,
        title: "E2Eテスト記事",
        body: `${String(current["body"])}\n\nQiita上で追記`,
        private: true,
        updated_at: "2030-01-01T00:00:00+09:00",
      }),
    ]);
    views = await stack.refreshViews();
    expect(views.find((v) => v.id === articleId)?.status).toBe("qiitaUpdated");

    const backupRun = stack.backup.start({ mode: "diff" });
    if (!backupRun.ok) return expect.fail("差分バックアップ開始失敗");
    const backupSummary = await backupRun.value.done;
    expect(backupSummary.total).toBe(1);
    expect(backupSummary.succeeded).toBe(1);
    expect(
      readFileSync(join(stack.root, `E2Eテスト記事_${articleId}`, "E2Eテスト記事.md"), "utf8"),
    ).toContain("Qiita上で追記");

    // 5. 最終的に「最新」へ戻る
    views = await stack.refreshViews();
    expect(views.find((v) => v.id === articleId)?.status).toBe("upToDate");
  });
});
