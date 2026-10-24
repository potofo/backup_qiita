import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { simpleGit } from "simple-git";
import { UploadServiceImpl } from "../src/services/uploadService.js";
import { StateStoreImpl } from "../src/services/stateStore.js";
import { AuthServiceImpl } from "../src/services/authService.js";
import { createProgressBus, type ProgressEvent } from "../src/services/progressBus.js";
import { createRunCoordinator } from "../src/services/runCoordinator.js";
import { QiitaApiClientImpl } from "../src/infra/qiitaApiClient.js";
import { StorageManagerImpl } from "../src/infra/storageManager.js";
import { LocalArticleScannerImpl } from "../src/infra/localArticleScanner.js";
import { createGitManager } from "../src/infra/gitManager.js";
import { createTokenStore } from "../src/config/tokenStore.js";
import { EnvFileConfig } from "../src/config/env.js";
import type { ArticleView, ImageResult, QiitaItem } from "../src/types/index.js";
import { startMockQiita, makeRawItem, type MockQiitaOptions } from "./helpers/mockQiitaServer.js";
import { ImageMapStoreImpl } from "../src/infra/imageMapStore.js";
import { ImageUploadSettingsStoreImpl } from "../src/infra/imageUploadSettingsStore.js";
import { ImageUploadPlannerImpl } from "../src/services/imageUploadPlanner.js";
import { ImageUploadServiceImpl } from "../src/services/imageUploadService.js";
import { createFakeUploader, uploadedNames, type FakeUploaderScenario } from "./helpers/fakeEditorImageUploader.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const makeItem = (overrides: Partial<QiitaItem> & { id: string }): QiitaItem => ({
  title: `記事${overrides.id}`,
  body: "# 本文",
  url: `https://qiita.com/testuser/items/${overrides.id}`,
  createdAt: "2026-01-01T10:00:00+09:00",
  updatedAt: "2026-01-01T10:00:00+09:00",
  private: false,
  tags: [{ name: "test" }],
  commentsCount: 0,
  likesCount: 0,
  stocksCount: 0,
  ...overrides,
});

/** フルスタック(モックQiita+実Git+一時フォルダ)を組み立てる */
async function buildStack(
  qiitaOptions: MockQiitaOptions = {},
  options: { retryLimit?: number; image?: { scenario?: FakeUploaderScenario; enabled?: boolean } } = {},
) {
  const mock = await startMockQiita({ validToken: "tok", ...qiitaOptions });
  closers.push(mock.close);

  const dir = mkdtempSync(join(tmpdir(), "qbt-up-"));
  const root = join(dir, "backup");
  const tokenStore = createTokenStore("tok");
  const qiitaClient = new QiitaApiClientImpl(tokenStore, { baseUrl: mock.url });
  const storage = new StorageManagerImpl(root);
  const stateStore = new StateStoreImpl(storage);
  await stateStore.loadIndex();
  const gitManager = await createGitManager(root);
  const bus = createProgressBus();
  const events: ProgressEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const coordinator = createRunCoordinator();
  const scanner = new LocalArticleScannerImpl(storage);
  const authService = new AuthServiceImpl(qiitaClient, tokenStore, new EnvFileConfig(join(dir, ".env")));

  // 画像アップロード機能(image-upload-automation)。指定時のみ組み込む
  const fake = createFakeUploader(options.image?.scenario);
  const imageMapStore = new ImageMapStoreImpl(storage);
  const settingsStore = new ImageUploadSettingsStoreImpl(join(dir, ".image-upload"));
  if (options.image && options.image.enabled !== false) settingsStore.update({ enabled: true, consent: true });
  const imageUpload = options.image
    ? {
        planner: new ImageUploadPlannerImpl({ storageManager: storage, imageMapStore }),
        service: new ImageUploadServiceImpl(
          { uploader: fake.uploader, imageMapStore, progressBus: bus, settingsStore },
          { loginTimeoutMs: 2_000, imageTimeoutMs: 1_000 },
        ),
        isEnabled: () => settingsStore.get().enabled,
      }
    : undefined;

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
      ...(imageUpload ? { imageUpload } : {}),
    },
    { retryLimit: options.retryLimit ?? 1 },
  );

  /** Qiita一覧+走査結果を分類してアップロードサービスのキャッシュへ反映する */
  const refreshViews = async (): Promise<ArticleView[]> => {
    const items = await qiitaClient.fetchAllItems();
    if (!items.ok) throw new Error("fetchAllItems failed");
    const drafts = scanner.scan(stateStore.knownIds());
    if (!drafts.ok) throw new Error("scan failed");
    const views = stateStore.classify(items.value, drafts.value);
    upload.updateArticleCache(views);
    return views;
  };

  /** 記事をバックアップ済みとして登録し、実ファイルも作る */
  const backUpItem = async (item: QiitaItem, content: string, images: ImageResult[] = []): Promise<void> => {
    const saved = await storage.saveArticle(item, content, images);
    if (!saved.ok) throw new Error("saveArticle failed");
    stateStore.markBackedUp(item, saved.value, sha256(content));
  };

  /** 新規記事フォルダを作る */
  const makeDraft = (folder: string, mdName: string, content: string): void => {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, mdName), content, "utf8");
  };

  return {
    mock,
    root,
    upload,
    stateStore,
    storage,
    authService,
    coordinator,
    bus,
    events,
    refreshViews,
    backUpItem,
    makeDraft,
    qiitaClient,
    fake,
    imageMapStore,
  };
}

const VALID_DRAFT = "---\ntitle: 新しい記事\ntags: [typescript, qiita]\n---\n# 新規本文\n\nこんにちは。";

describe("UploadService — 開始前の検証と確認フロー(upload-sync 7.1)", () => {
  it("確認フラグなしの開始は確認要求エラーを返し、書き込みが1件も発生しない(3.4, 4.3, 8.1)", async () => {
    const stack = await buildStack();
    stack.makeDraft("my-draft", "draft.md", VALID_DRAFT);
    await stack.refreshViews();

    const result = stack.upload.start({ mode: "changes" });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "needsUploadConfirm") {
      expect(result.error.info.targets).toHaveLength(1);
      expect(result.error.info.targets[0]).toEqual({
        key: "local:my-draft",
        title: "新しい記事",
        kind: "create",
      });
    } else {
      expect.fail(`needsUploadConfirm を期待したが: ${JSON.stringify(result)}`);
    }
    // 書き込みリクエストは1件も送信されていない
    expect(stack.mock.writeRequests).toHaveLength(0);
  });

  it("公開中記事の更新は確認情報にpublicUpdatesとして列挙される(3.4)", async () => {
    const stack = await buildStack({ items: [makeRawItem({ id: "a1", title: "公開記事", private: false })] });
    const item = makeItem({ id: "a1", title: "公開記事" });
    await stack.backUpItem(item, "# 元本文");
    writeFileSync(join(stack.root, "公開記事_a1", "公開記事.md"), "# 編集済み", "utf8");
    await stack.refreshViews();

    const result = stack.upload.start({ mode: "changes" });
    if (result.ok || result.error.kind !== "needsUploadConfirm") {
      return expect.fail(`needsUploadConfirm を期待したが: ${JSON.stringify(result)}`);
    }
    expect(result.error.info.publicUpdates).toEqual([{ id: "a1", title: "公開記事" }]);
  });

  it("対応表にないローカル画像参照は確認情報のimageWarningsに列挙される(8.3)", async () => {
    const imageUrl = "https://img.example/photo.png";
    const stack = await buildStack({ items: [makeRawItem({ id: "a1", title: "画像記事" })] });
    const item = makeItem({ id: "a1", title: "画像記事" });
    await stack.backUpItem(item, `![図](images/001_photo.png)`, [
      { url: imageUrl, ok: true, fileName: "001_photo.png" },
    ]);
    // ユーザ編集: 既知画像はそのまま + 対応表にない画像を追加
    writeFileSync(
      join(stack.root, "画像記事_a1", "画像記事.md"),
      `![図](images/001_photo.png)\n\n![新規](images/new-image.png)\n\n追記`,
      "utf8",
    );
    await stack.refreshViews();

    const result = stack.upload.start({ mode: "changes" });
    if (result.ok || result.error.kind !== "needsUploadConfirm") {
      return expect.fail(`needsUploadConfirm を期待したが: ${JSON.stringify(result)}`);
    }
    const warnings = result.error.info.imageWarnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.key).toBe("a1");
    expect(warnings[0]!.refs).toEqual(["images/new-image.png"]); // 復元可能な参照は警告しない
  });

  it("既知の書き込み権限不足の場合はRunを開始せず案内を返す(6.2, 6.3)", async () => {
    const stack = await buildStack();
    stack.makeDraft("my-draft", "draft.md", VALID_DRAFT);
    await stack.refreshViews();
    stack.authService.reportWriteResult("denied");

    const result = stack.upload.start({ mode: "changes", confirmed: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("writeAccessDenied");
    expect(stack.mock.writeRequests).toHaveLength(0);
  });

  it("選択アップロード: 削除済み・欠落・規約不備の記事は理由付きで拒否される(3.6, 1.3)", async () => {
    const stack = await buildStack({ items: [makeRawItem({ id: "a1", title: "記事a1" })] });
    // Qiita側削除: indexにあるが一覧にない
    await stack.backUpItem(makeItem({ id: "gone1", title: "削除済み" }), "# x");
    // ローカル欠落
    const missing = makeItem({ id: "a1", title: "記事a1" });
    await stack.backUpItem(missing, "# y");
    unlinkSync(join(stack.root, "記事a1_a1", "記事a1.md"));
    // 規約不備ドラフト
    stack.makeDraft("broken", "b.md", "# frontmatterなし");
    await stack.refreshViews();

    const result = stack.upload.start({
      mode: "selected",
      ids: ["gone1", "a1", "local:broken"],
      confirmed: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "invalidTargets") {
      expect(result.error.details).toHaveLength(3);
      const keys = result.error.details.map((d) => d.key);
      expect(keys).toContain("gone1");
      expect(keys).toContain("a1");
      expect(keys).toContain("local:broken");
    } else {
      expect.fail(`invalidTargets を期待したが: ${JSON.stringify(result)}`);
    }
    expect(stack.mock.writeRequests).toHaveLength(0);
  });

  it("競合記事は変更点全件アップロードから除外され、選択+承認時のみ対象になる(2.5, 3.5)", async () => {
    const stack = await buildStack({
      items: [makeRawItem({ id: "c1", title: "競合記事", updated_at: "2027-01-01T00:00:00+09:00" })],
    });
    const item = makeItem({ id: "c1", title: "競合記事" });
    await stack.backUpItem(item, "# 元本文");
    writeFileSync(join(stack.root, "競合記事_c1", "競合記事.md"), "# ローカル編集", "utf8");
    await stack.refreshViews();

    // changes モード: 競合のみでは対象なし
    const changes = stack.upload.start({ mode: "changes", confirmed: true });
    expect(changes.ok).toBe(false);
    if (!changes.ok) expect(changes.error.kind).toBe("invalidRequest");

    // selected モード: 確認情報に競合警告が含まれる
    const selected = stack.upload.start({ mode: "selected", ids: ["c1"] });
    if (selected.ok || selected.error.kind !== "needsUploadConfirm") {
      return expect.fail(`needsUploadConfirm を期待したが: ${JSON.stringify(selected)}`);
    }
    expect(selected.error.info.conflicts).toEqual([{ id: "c1", title: "競合記事" }]);

    // 明示承認(confirmed)で実行できる
    const approved = stack.upload.start({ mode: "selected", ids: ["c1"], confirmed: true });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      const summary = await approved.value.done;
      expect(summary.succeeded).toBe(1);
    }
  });
});

describe("UploadService — Runの実行(upload-sync 7.2)", () => {
  it("新規登録Run: 限定共有で登録→フォルダ正規化→管理情報反映→状態「最新」→Gitコミット(3.2, 5.1, 7.3, 7.5)", async () => {
    const stack = await buildStack();
    stack.makeDraft("my-draft", "draft.md", VALID_DRAFT);
    await stack.refreshViews();

    const started = stack.upload.start({ mode: "changes", confirmed: true });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const summary = await started.value.done;

    expect(summary.direction).toBe("upload");
    expect(summary.total).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);

    // 送信ペイロード: 常に限定共有・SNS投稿なし(5.1)
    const req = stack.mock.writeRequests[0]!;
    expect(req.method).toBe("POST");
    expect(req.body["private"]).toBe(true);
    expect(req.body["tweet"]).toBe(false);
    expect(req.body["title"]).toBe("新しい記事");
    expect(req.body["tags"]).toEqual([{ name: "typescript" }, { name: "qiita" }]);
    expect(String(req.body["body"])).toContain("# 新規本文");

    // フォルダが正規化されている(7.3)
    expect(existsSync(join(stack.root, "my-draft"))).toBe(false);
    const dir = join(stack.root, "新しい記事_created0001");
    expect(existsSync(join(dir, "新しい記事.md"))).toBe(true);
    expect(existsSync(join(dir, "original.md"))).toBe(true);
    expect(existsSync(join(dir, "meta.json"))).toBe(true);

    // 再分類が「最新」になり、以後の通常バックアップ対象になる(7.3)
    const views = await stack.refreshViews();
    const uploaded = views.find((v) => v.id === "created0001");
    expect(uploaded).toBeDefined();
    expect(uploaded!.status).toBe("upToDate");

    // Run方向を含むメッセージでGitコミットされる(7.5)
    const message = await simpleGit(stack.root).raw(["log", "-1", "--format=%B"]);
    expect(message).toContain("アップロード");
    // 実行履歴にRun方向が記録される(7.6)
    expect(stack.stateStore.getHistory()[0]!.direction).toBe("upload");
  });

  it("更新Run: 画像参照を元URLへ復元して本文更新→原本更新→状態「最新」(3.3, 5.3, 7.4)", async () => {
    const imageUrl = "https://img.example/photo.png";
    const stack = await buildStack({
      items: [makeRawItem({ id: "a1", title: "画像記事", private: true, body: `![図](${imageUrl})` })],
    });
    const item = makeItem({ id: "a1", title: "画像記事", private: true, body: `![図](${imageUrl})` });
    await stack.backUpItem(item, `![図](images/001_photo.png)`, [
      { url: imageUrl, ok: true, fileName: "001_photo.png" },
    ]);
    const edited = `![図](images/001_photo.png)\n\n追記した本文`;
    writeFileSync(join(stack.root, "画像記事_a1", "画像記事.md"), edited, "utf8");
    await stack.refreshViews();

    const started = stack.upload.start({ mode: "changes", confirmed: true });
    if (!started.ok) return expect.fail(`開始失敗: ${JSON.stringify(started)}`);
    const summary = await started.value.done;
    expect(summary.succeeded).toBe(1);

    // PATCH: 画像参照が元URLへ復元され、公開範囲が明示送信される(5.3)
    const req = stack.mock.writeRequests[0]!;
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe("/api/v2/items/a1");
    expect(String(req.body["body"])).toContain(imageUrl);
    expect(String(req.body["body"])).not.toContain("images/001_photo.png");
    expect(String(req.body["body"])).toContain("追記した本文");
    expect(req.body["private"]).toBe(true);
    expect(req.body["title"]).toBe("画像記事");

    // 原本が更新後の本文になり、閲覧用はユーザ編集のまま
    const original = readFileSync(join(stack.root, "画像記事_a1", "original.md"), "utf8");
    expect(original).toContain(imageUrl);
    expect(readFileSync(join(stack.root, "画像記事_a1", "画像記事.md"), "utf8")).toBe(edited);

    // 再分類が「最新」(7.4)
    const views = await stack.refreshViews();
    expect(views.find((v) => v.id === "a1")!.status).toBe("upToDate");
  });

  it("403(スコープ不足): 最初の書き込みで残り全件を中止し、writeAccess=deniedを記録して案内する(6.3, 9.3)", async () => {
    const stack = await buildStack({ writeForbidden: true });
    stack.makeDraft("draft-a", "a.md", "---\ntitle: A\ntags: [t]\n---\nA");
    stack.makeDraft("draft-b", "b.md", "---\ntitle: B\ntags: [t]\n---\nB");
    await stack.refreshViews();

    const started = stack.upload.start({ mode: "changes", confirmed: true });
    if (!started.ok) return expect.fail("開始失敗");
    const summary = await started.value.done;

    expect(summary.succeeded).toBe(0);
    // 書き込みは1件も成立していない(1記事目の403で全体中止)
    expect(stack.mock.writeRequests).toHaveLength(1);
    expect(stack.authService.writeAccess()).toBe("denied");

    // 案内を含むrun-errorが発行される
    const runError = stack.events.find((e) => e.type === "run-error");
    expect(runError).toBeDefined();
    if (runError?.type === "run-error") {
      expect(runError.message).toContain("スコープ");
    }

    // 以後のアップロード開始は事前拒否される(6.2)
    const next = stack.upload.start({ mode: "changes", confirmed: true });
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.error.kind).toBe("writeAccessDenied");
  }, 15_000);

  it("429: リセット時刻まで待機して同一記事から再開する(9.1)", async () => {
    const stack = await buildStack({ writeRateLimitFirstN: { count: 1, resetAfterSec: 1 } });
    stack.makeDraft("my-draft", "draft.md", VALID_DRAFT);
    await stack.refreshViews();

    const started = stack.upload.start({ mode: "changes", confirmed: true });
    if (!started.ok) return expect.fail("開始失敗");
    const summary = await started.value.done;

    expect(summary.succeeded).toBe(1);
    expect(stack.events.some((e) => e.type === "waiting-rate-limit")).toBe(true);
    expect(stack.mock.writeRequests).toHaveLength(2); // 429 → 待機 → 再送
  }, 15_000);

  it("サーバエラー(5xx): 記事単位で上限付きリトライし、超過時は失敗記録して残りを継続する(9.2, 9.4)", async () => {
    // retryLimit=1 → 1記事目は2回(初回+リトライ)失敗して打ち切り、2記事目は成功
    const stack = await buildStack({ writeFailFirstN: { count: 2, status: 500 } });
    stack.makeDraft("draft-a", "a.md", "---\ntitle: 記事A\ntags: [t]\n---\nA");
    stack.makeDraft("draft-b", "b.md", "---\ntitle: 記事B\ntags: [t]\n---\nB");
    await stack.refreshViews();

    const started = stack.upload.start({ mode: "changes", confirmed: true });
    if (!started.ok) return expect.fail("開始失敗");
    const summary = await started.value.done;

    expect(summary.total).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(1);
    // 失敗記事の一覧と理由が記録される(9.4)
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures![0]!.title).toBe("記事A");
    expect(summary.failures![0]!.reason).toBeTruthy();
  }, 15_000);

  it("中断: 処理中記事の完了を待って停止し、index保存+Gitコミットを行う(7.2, 7.5)", async () => {
    const stack = await buildStack();
    stack.makeDraft("draft-a", "a.md", "---\ntitle: 記事A\ntags: [t]\n---\nA");
    stack.makeDraft("draft-b", "b.md", "---\ntitle: 記事B\ntags: [t]\n---\nB");
    await stack.refreshViews();

    stack.bus.subscribe((e) => {
      if (e.type === "article-done") stack.upload.cancel();
    });
    const started = stack.upload.start({ mode: "changes", confirmed: true });
    if (!started.ok) return expect.fail("開始失敗");
    const summary = await started.value.done;

    expect(summary.cancelled).toBe(true);
    expect(summary.succeeded).toBe(1);
    expect(summary.total).toBe(2);

    // 処理済み分は管理情報に反映され、コミットされている
    const index = JSON.parse(readFileSync(join(stack.root, "index.json"), "utf8"));
    expect(Object.keys(index.articles)).toHaveLength(1);
    const log = await simpleGit(stack.root).log();
    expect(log.total).toBe(1);
  });

  it("選択アップロード: 選択された記事のみをアップロードする(3.1)", async () => {
    const stack = await buildStack();
    stack.makeDraft("draft-a", "a.md", "---\ntitle: 記事A\ntags: [t]\n---\nA");
    stack.makeDraft("draft-b", "b.md", "---\ntitle: 記事B\ntags: [t]\n---\nB");
    await stack.refreshViews();

    const started = stack.upload.start({ mode: "selected", ids: ["local:draft-a"], confirmed: true });
    if (!started.ok) return expect.fail(`開始失敗: ${JSON.stringify(started)}`);
    const summary = await started.value.done;

    expect(summary.total).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(stack.mock.writeRequests).toHaveLength(1);
    expect(stack.mock.writeRequests[0]!.body["title"]).toBe("記事A");
    // 未選択のドラフトはそのまま残る
    expect(existsSync(join(stack.root, "draft-b", "b.md"))).toBe(true);
  });

  it("書き込み成功でwriteAccess=grantedが記録される(6.4)", async () => {
    const stack = await buildStack();
    stack.makeDraft("my-draft", "draft.md", VALID_DRAFT);
    await stack.refreshViews();
    expect(stack.authService.writeAccess()).toBe("unknown");

    const started = stack.upload.start({ mode: "changes", confirmed: true });
    if (!started.ok) return expect.fail("開始失敗");
    await started.value.done;
    expect(stack.authService.writeAccess()).toBe("granted");
  });
});

// ---- 画像アップロードの組み込み(image-upload-automation 5.1, 5.2) ----------------

const PNG = (seed: string): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);
const IMAGE_DRAFT = "---\ntitle: 画像記事\ntags: [qiita]\n---\n# 画像\n\n![図](images/a.png)";
const FAKE_URL_0 = "https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/1/fake-0.png";

/** 画像付きの新規記事フォルダを作る */
const makeImageDraft = (stack: Awaited<ReturnType<typeof buildStack>>, folder = "img-draft", body = IMAGE_DRAFT): void => {
  stack.makeDraft(folder, "draft.md", body);
  mkdirSync(join(stack.root, folder, "images"), { recursive: true });
  writeFileSync(join(stack.root, folder, "images", "a.png"), PNG(folder));
};

const createBodies = (stack: Awaited<ReturnType<typeof buildStack>>): string[] =>
  stack.mock.writeRequests.filter((r) => r.method === "POST").map((r) => String(r.body["body"]));

describe("UploadService — 実行前確認と承認の分岐(image-upload-automation 5.1)", () => {
  it("機能が無効なら確認情報に画像計画を付けず、従来どおりローカル画像警告だけを返す(1.2)", async () => {
    const stack = await buildStack({}, { image: { enabled: false } });
    makeImageDraft(stack);
    await stack.refreshViews();
    const result = stack.upload.start({ mode: "changes" });
    if (result.ok || result.error.kind !== "needsUploadConfirm") return expect.fail(JSON.stringify(result));
    expect(result.error.info.imagePlan).toBeUndefined();
    expect(result.error.info.imageWarnings).toEqual([{ key: "local:img-draft", title: "画像記事", refs: ["images/a.png"] }]);
  });

  it("機能が有効で送る画像があれば、確認情報に画像計画(枚数・容量)を付ける(3.1)", async () => {
    const stack = await buildStack({}, { image: {} });
    makeImageDraft(stack);
    await stack.refreshViews();
    const result = stack.upload.start({ mode: "changes" });
    if (result.ok || result.error.kind !== "needsUploadConfirm") return expect.fail(JSON.stringify(result));
    const plan = result.error.info.imagePlan;
    expect(plan?.uploadCount).toBe(1);
    expect(plan?.uploadBytes).toBe(PNG("img-draft").length);
    expect(plan?.articles[0]?.entries[0]?.status).toEqual({ kind: "upload" });
  });

  it("画像アップロードを承認しなければブラウザを開かず、参照を変えずに従来どおり送る(3.3, 3.4)", async () => {
    const stack = await buildStack({}, { image: {} });
    makeImageDraft(stack);
    await stack.refreshViews();
    const started = stack.upload.start({ mode: "changes", confirmed: true });
    if (!started.ok) return expect.fail(JSON.stringify(started.error));
    const summary = await started.value.done;
    expect(summary.succeeded).toBe(1);
    expect(stack.fake.calls.opened).toHaveLength(0);
    expect(createBodies(stack)).toEqual(["# 画像\n\n![図](images/a.png)"]);
    expect(summary.imageUpload).toBeUndefined();
  });
});

describe("UploadService — 画像フェーズの組み込み(image-upload-automation 5.2)", () => {
  it("承認ありでは画像をアップロードし、置換した本文で登録する。閲覧用mdは相対参照のまま(7.1, 7.3)", async () => {
    const stack = await buildStack({}, { image: {} });
    makeImageDraft(stack);
    await stack.refreshViews();
    const started = stack.upload.start({ mode: "changes", confirmed: true, uploadImages: true });
    if (!started.ok) return expect.fail(JSON.stringify(started.error));
    const summary = await started.value.done;

    expect(summary.succeeded).toBe(1);
    expect(createBodies(stack)).toEqual([`# 画像\n\n![図](${FAKE_URL_0})`]);
    const folder = readdirNames(stack.root).find((n) => n.startsWith("画像記事_"))!;
    expect(readFileSync(join(stack.root, folder, "画像記事.md"), "utf8")).toBe("# 画像\n\n![図](images/a.png)");
    const meta = JSON.parse(readFileSync(join(stack.root, folder, "meta.json"), "utf8"));
    expect(meta.uploadedImages.map((e: { url: string }) => e.url)).toEqual([FAKE_URL_0]);
    expect(summary.imageUpload).toMatchObject({ uploaded: 1, reused: 0, failed: [], aborted: null });
    expect(summary.imageUpload?.workDraftUrl).toBe("https://qiita.com/drafts/fakedraft01/edit");
  });

  it("既存記事の更新では、ダウンロード済み画像の復元とアップロードした画像の置換を両方行う", async () => {
    const stack = await buildStack({ items: [makeRawItem({ id: "e1", title: "既存記事", private: true })] }, { image: {} });
    const item = makeItem({ id: "e1", title: "既存記事", private: true });
    const downloaded: ImageResult[] = [{ url: "https://qiita-image-store.s3.amazonaws.com/old.png", ok: true, fileName: "001_old.png" }];
    await stack.backUpItem(item, "![旧](images/001_old.png)", downloaded);
    const dir = join(stack.root, "既存記事_e1");
    writeFileSync(join(dir, "images", "new.png"), PNG("new"));
    const edited = "![旧](images/001_old.png)\n![新](images/new.png)";
    writeFileSync(join(dir, "既存記事.md"), edited, "utf8");
    await stack.refreshViews();

    const started = stack.upload.start({ mode: "changes", confirmed: true, uploadImages: true });
    if (!started.ok) return expect.fail(JSON.stringify(started.error));
    const summary = await started.value.done;
    expect(summary.succeeded).toBe(1);
    const patch = stack.mock.writeRequests.find((r) => r.method === "PATCH")!;
    expect(patch.body["body"]).toBe(`![旧](https://qiita-image-store.s3.amazonaws.com/old.png)\n![新](${FAKE_URL_0})`);
    expect(readFileSync(join(dir, "既存記事.md"), "utf8")).toBe(edited); // 閲覧用mdは書き換えない

    const views = await stack.refreshViews();
    expect(views.find((v) => v.id === "e1")?.status).toBe("upToDate");
  });

  it("画像が1枚でも失敗した記事は送らず失敗とし、他の記事は送る(8.2, 8.3, 8.4)", async () => {
    const stack = await buildStack(
      {},
      { image: { scenario: { uploadResult: (p, i) => (p.includes("bad-draft") ? { ok: false, error: { kind: "timeout" } } : { ok: true, value: `https://qiita-image-store.s3.amazonaws.com/0/1/ok-${i}.png` }) } } },
    );
    makeImageDraft(stack, "bad-draft", IMAGE_DRAFT.replace("画像記事", "失敗する記事"));
    makeImageDraft(stack, "good-draft");
    await stack.refreshViews();
    const started = stack.upload.start({ mode: "changes", confirmed: true, uploadImages: true });
    if (!started.ok) return expect.fail(JSON.stringify(started.error));
    const summary = await started.value.done;

    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures?.[0]?.title).toBe("失敗する記事");
    expect(summary.failures?.[0]?.reason).toContain("images/a.png");
    expect(createBodies(stack)).toHaveLength(1);
    expect(summary.imageUpload?.failed.map((f) => f.articleTitle)).toEqual(["失敗する記事"]);
  });

  it("ログインの時間切れでは記事を1件も送らず、中止理由を記録する(4.4)", async () => {
    const stack = await buildStack({}, { image: { scenario: { readyError: { kind: "timeout" } } } });
    makeImageDraft(stack);
    stack.makeDraft("plain", "p.md", "---\ntitle: 画像なし\ntags: [x]\n---\n本文");
    await stack.refreshViews();
    const started = stack.upload.start({ mode: "changes", confirmed: true, uploadImages: true });
    if (!started.ok) return expect.fail(JSON.stringify(started.error));
    const summary = await started.value.done;

    expect(stack.mock.writeRequests).toHaveLength(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.imageUpload?.aborted).toBe("loginTimeout");
    expect(stack.events.some((e) => e.type === "run-error")).toBe(true);
  });

  it("画面要素がない場合は、新しい画像が不要な記事だけを送る(8.1, 8.4)", async () => {
    const stack = await buildStack({}, { image: { scenario: { readyError: { kind: "editorElementMissing", element: 'input[type="file"]' } } } });
    makeImageDraft(stack);
    stack.makeDraft("plain", "p.md", "---\ntitle: 画像なし\ntags: [x]\n---\n本文");
    await stack.refreshViews();
    const started = stack.upload.start({ mode: "changes", confirmed: true, uploadImages: true });
    if (!started.ok) return expect.fail(JSON.stringify(started.error));
    const summary = await started.value.done;

    expect(createBodies(stack)).toEqual(["本文"]);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.imageUpload?.aborted).toBe("editorUnavailable");
    expect(summary.imageUpload?.abortMessage).toContain("手動");
  });

  it("画像フェーズ中の中断では記事を送らず、中断として記録する(6.6)", async () => {
    let upload: UploadServiceImpl | null = null;
    const stack = await buildStack({}, { image: { scenario: { beforeUpload: () => upload?.cancel() } } });
    upload = stack.upload;
    makeImageDraft(stack, "d1");
    makeImageDraft(stack, "d2", IMAGE_DRAFT.replace("画像記事", "二つ目"));
    await stack.refreshViews();
    const started = stack.upload.start({ mode: "changes", confirmed: true, uploadImages: true });
    if (!started.ok) return expect.fail(JSON.stringify(started.error));
    const summary = await started.value.done;

    expect(stack.mock.writeRequests).toHaveLength(0);
    expect(summary.cancelled).toBe(true);
    expect(summary.imageUpload).toMatchObject({ uploaded: 1, aborted: "cancelled" });
    expect(stack.fake.calls.closed).toBe(1);
  });
});

const readdirNames = (dir: string): string[] => readdirSync(dir);

describe("画像アップロードの一連の流れ(image-upload-automation 6.1)", () => {
  it("新規登録 → 対応表が meta へ移る → 次の更新では同じ画像を送らず再利用する(2.6, 7.4, 7.5, 7.7)", async () => {
    const stack = await buildStack({}, { image: {} });
    makeImageDraft(stack);
    await stack.refreshViews();
    const first = stack.upload.start({ mode: "changes", confirmed: true, uploadImages: true });
    if (!first.ok) return expect.fail(JSON.stringify(first.error));
    await first.value.done;
    expect(stack.fake.calls.uploaded).toHaveLength(1);

    // 登録後のフォルダで本文を編集し、同じ画像を参照したまま更新する
    const folder = readdirNames(stack.root).find((n) => n.startsWith("画像記事_"))!;
    expect(existsSync(join(stack.root, folder, ".image-uploads.json"))).toBe(false);
    writeFileSync(join(stack.root, folder, "画像記事.md"), "# 画像(追記)\n\n![図](images/a.png)", "utf8");
    const views = await stack.refreshViews();
    expect(views.find((v) => v.folderName === folder)?.status).toBe("localModified");

    const confirm = stack.upload.start({ mode: "changes" });
    if (confirm.ok || confirm.error.kind !== "needsUploadConfirm") return expect.fail(JSON.stringify(confirm));
    expect(confirm.error.info.imagePlan).toBeUndefined(); // 送る画像がない
    expect(confirm.error.info.imageWarnings).toEqual([]); // 再利用で置換されるため警告しない

    const second = stack.upload.start({ mode: "changes", confirmed: true });
    if (!second.ok) return expect.fail(JSON.stringify(second.error));
    const summary = await second.value.done;
    expect(summary.succeeded).toBe(1);
    expect(stack.fake.calls.uploaded).toHaveLength(1); // 再アップロードしていない
    const patch = stack.mock.writeRequests.find((r) => r.method === "PATCH")!;
    expect(patch.body["body"]).toBe(`# 画像(追記)\n\n![図](${FAKE_URL_0})`);
    const after = await stack.refreshViews();
    expect(after.find((v) => v.folderName === folder)?.status).toBe("upToDate");
  });

  it("画像フェーズを中断した後の再実行では、取得済みのURLを再利用して残りだけを送る(6.6, 7.7)", async () => {
    let upload: UploadServiceImpl | null = null;
    let cancelOnce = true;
    const stack = await buildStack(
      {},
      {
        image: {
          scenario: {
            beforeUpload: () => {
              if (cancelOnce) upload?.cancel(); // 1回目のRunでは1枚目の処理中に中断する
              cancelOnce = false;
            },
          },
        },
      },
    );
    upload = stack.upload;
    stack.makeDraft("two-images", "draft.md", "---\ntitle: 二枚の記事\ntags: [qiita]\n---\n![a](a.png)\n![b](b.png)");
    writeFileSync(join(stack.root, "two-images", "a.png"), PNG("a"));
    writeFileSync(join(stack.root, "two-images", "b.png"), PNG("b"));
    await stack.refreshViews();

    const first = stack.upload.start({ mode: "changes", confirmed: true, uploadImages: true });
    if (!first.ok) return expect.fail(JSON.stringify(first.error));
    const cancelled = await first.value.done;
    expect(cancelled.cancelled).toBe(true);
    expect(stack.mock.writeRequests).toHaveLength(0);

    await stack.refreshViews();
    const retry = stack.upload.start({ mode: "changes", confirmed: true, uploadImages: true });
    if (!retry.ok) return expect.fail(JSON.stringify(retry.error));
    const summary = await retry.value.done;
    expect(summary.succeeded).toBe(1);
    expect(summary.imageUpload).toMatchObject({ uploaded: 1, reused: 1 });
    expect(uploadedNames(stack.fake.calls)).toEqual(["a.png", "b.png"]);
    expect(createBodies(stack)).toEqual([
      "![a](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/1/fake-0.png)\n![b](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/1/fake-1.png)",
    ]);
  });
});
