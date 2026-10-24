import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { StateStoreImpl, summarize } from "../src/services/stateStore.js";
import { StorageManagerImpl } from "../src/infra/storageManager.js";
import type { QiitaItem, RunSummary } from "../src/types/index.js";

const makeItem = (overrides: Partial<QiitaItem> & { id: string }): QiitaItem => ({
  title: `記事${overrides.id}`,
  body: "# 本文",
  url: `https://qiita.com/u/items/${overrides.id}`,
  createdAt: "2026-01-01T10:00:00+09:00",
  updatedAt: "2026-01-02T10:00:00+09:00",
  private: false,
  tags: [{ name: "test" }],
  commentsCount: 0,
  likesCount: 0,
  stocksCount: 0,
  ...overrides,
});

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const makeSummary = (runId: string): RunSummary => ({
  runId,
  mode: "diff",
  startedAt: "2026-07-12T10:00:00+09:00",
  finishedAt: "2026-07-12T10:05:00+09:00",
  total: 1,
  succeeded: 1,
  failed: 0,
  imageFailures: [],
  cancelled: false,
  commit: null,
});

describe("StateStore(3.2)", () => {
  let root: string;
  let storage: StorageManagerImpl;
  let store: StateStoreImpl;

  beforeEach(async () => {
    root = join(mkdtempSync(join(tmpdir(), "qbt-ss-")), "backup");
    storage = new StorageManagerImpl(root);
    store = new StateStoreImpl(storage);
    await store.loadIndex();
  });

  /** 記事をバックアップ済みとして登録し、実ファイルも作る */
  const backUp = async (item: QiitaItem, content = "# 保存済み本文"): Promise<void> => {
    const saved = await storage.saveArticle(item, content, []);
    if (!saved.ok) throw new Error("save failed");
    store.markBackedUp(item, saved.value, sha256(content));
  };

  describe("classify — 設計書の状態分類表(5.2)", () => {
    it("index.jsonに存在しない記事は「未バックアップ」", () => {
      const views = store.classify([makeItem({ id: "new1" })]);
      expect(views).toHaveLength(1);
      expect(views[0]!.status).toBe("notBackedUp");
      expect(views[0]!.lastBackupAt).toBeNull();
    });

    it("バックアップ済みで変更がない記事は「バックアップ済(最新)」(境界: updated_at同値)", async () => {
      const item = makeItem({ id: "a1" });
      await backUp(item);
      const views = store.classify([item]); // updatedAt が保存時と同値
      expect(views[0]!.status).toBe("upToDate");
      expect(views[0]!.folderName).toBe("記事a1_a1");
      expect(views[0]!.lastBackupAt).not.toBeNull();
    });

    it("Qiita側のupdated_atが新しい記事は「Qiita側更新あり」", async () => {
      const item = makeItem({ id: "a1", updatedAt: "2026-01-02T10:00:00+09:00" });
      await backUp(item);
      const newer = { ...item, updatedAt: "2026-01-03T09:00:00+09:00" };
      expect(store.classify([newer])[0]!.status).toBe("qiitaUpdated");
    });

    it("ローカルの閲覧用Markdownが変更されている記事は「ローカル変更あり」", async () => {
      const item = makeItem({ id: "a1" });
      await backUp(item, "# 元の本文");
      writeFileSync(join(root, "記事a1_a1", "記事a1.md"), "# 改変された本文", "utf8");
      expect(store.classify([item])[0]!.status).toBe("localModified");
    });

    it("ローカルの閲覧用Markdownが削除されている記事は「ローカル欠落」(再バックアップで復元可能 — upload-sync 2.3)", async () => {
      const item = makeItem({ id: "a1" });
      await backUp(item);
      unlinkSync(join(root, "記事a1_a1", "記事a1.md"));
      expect(store.classify([item])[0]!.status).toBe("localMissing");
    });

    it("Qiita側更新とローカル変更が同時なら「競合」(upload-sync 2.5)", async () => {
      const item = makeItem({ id: "a1" });
      await backUp(item, "# 元の本文");
      writeFileSync(join(root, "記事a1_a1", "記事a1.md"), "# 改変", "utf8");
      const newer = { ...item, updatedAt: "2027-01-01T00:00:00+09:00" };
      expect(store.classify([newer])[0]!.status).toBe("conflict");
    });

    it("欠落はQiita側更新の有無に関わらず「ローカル欠落」を優先する(決定木: 欠落→競合→改変)", async () => {
      const item = makeItem({ id: "a1" });
      await backUp(item);
      unlinkSync(join(root, "記事a1_a1", "記事a1.md"));
      const newer = { ...item, updatedAt: "2027-01-01T00:00:00+09:00" };
      expect(store.classify([newer])[0]!.status).toBe("localMissing");
    });

    it("ローカル変更のみ(Qiita側更新なし)は従来どおり「ローカル変更あり」(upload-sync 2.2)", async () => {
      const item = makeItem({ id: "a1" });
      await backUp(item, "# 元の本文");
      writeFileSync(join(root, "記事a1_a1", "記事a1.md"), "# 改変", "utf8");
      expect(store.classify([item])[0]!.status).toBe("localModified");
    });

    it("ローカル新規候補を一覧へ合流させる(upload-sync 1.2, 1.3)", () => {
      const views = store.classify(
        [makeItem({ id: "a1" })],
        [
          {
            key: "local:new-article",
            folderName: "new-article",
            mdFileName: "draft.md",
            title: "書きかけの記事",
            tags: ["test"],
            body: "# 本文",
            mtime: "2026-08-01T10:00:00.000Z",
            invalidReasons: [],
          },
          {
            key: "local:broken",
            folderName: "broken",
            mdFileName: "b.md",
            title: null,
            tags: [],
            body: "x",
            mtime: "2026-08-01T10:00:00.000Z",
            invalidReasons: ["frontmatterにtitleがありません"],
          },
        ],
      );
      expect(views).toHaveLength(3);
      const draft = views.find((v) => v.id === "local:new-article");
      expect(draft).toBeDefined();
      expect(draft!.status).toBe("localNew");
      expect(draft!.title).toBe("書きかけの記事");
      expect(draft!.folderName).toBe("new-article");
      expect(draft!.invalidReasons).toEqual([]);
      // 不備のある候補も理由付きで一覧に含まれる(1.3)
      const broken = views.find((v) => v.id === "local:broken");
      expect(broken!.status).toBe("localNew");
      expect(broken!.invalidReasons).toEqual(["frontmatterにtitleがありません"]);
    });

    it("indexに存在しQiita一覧にない記事は「Qiita側削除」として一覧に残る(5.6)", async () => {
      const item = makeItem({ id: "gone1", title: "削除された記事" });
      await backUp(item);
      const views = store.classify([makeItem({ id: "alive1" })]);
      const deleted = views.find((v) => v.id === "gone1");
      expect(deleted).toBeDefined();
      expect(deleted!.status).toBe("deletedOnQiita");
      expect(deleted!.title).toBe("削除された記事");
      // ローカルデータは削除されない
      expect(() => storage.findFolderById("gone1")).not.toThrow();
      expect(storage.findFolderById("gone1")).toBe("削除された記事_gone1");
    });

    it("集計値: 全記事数・未バックアップ数・要再バックアップ数を返す(5.7)", async () => {
      const a1 = makeItem({ id: "a1" });
      await backUp(a1);
      const views = store.classify([
        a1,
        makeItem({ id: "new1" }),
        makeItem({ id: "new2" }),
      ]);
      const agg = summarize(views);
      expect(agg.total).toBe(3);
      expect(agg.notBackedUp).toBe(2);
      expect(agg.upToDate).toBe(1);
      expect(agg.needsBackup).toBe(2); // 未バックアップ + Qiita側更新あり
    });

    it("集計値: アップロード候補数・競合数・欠落数を追加する(upload-sync 2.7)", async () => {
      // ローカル改変
      const modified = makeItem({ id: "m1" });
      await backUp(modified, "# 元の本文");
      writeFileSync(join(root, "記事m1_m1", "記事m1.md"), "# 改変", "utf8");
      // 競合
      const conflicted = makeItem({ id: "c1" });
      await backUp(conflicted, "# 元の本文");
      writeFileSync(join(root, "記事c1_c1", "記事c1.md"), "# 改変", "utf8");
      // 欠落
      const missing = makeItem({ id: "x1" });
      await backUp(missing);
      unlinkSync(join(root, "記事x1_x1", "記事x1.md"));

      const views = store.classify(
        [
          modified,
          { ...conflicted, updatedAt: "2027-01-01T00:00:00+09:00" },
          missing,
          makeItem({ id: "new1" }), // 未バックアップ
        ],
        [
          {
            key: "local:valid", folderName: "valid", mdFileName: "a.md", title: "有効",
            tags: ["t"], body: "b", mtime: "", invalidReasons: [],
          },
          {
            key: "local:broken", folderName: "broken", mdFileName: "b.md", title: null,
            tags: [], body: "b", mtime: "", invalidReasons: ["titleなし"],
          },
        ],
      );
      const agg = summarize(views);
      expect(agg.total).toBe(6);
      expect(agg.localModified).toBe(1);
      expect(agg.conflict).toBe(1);
      expect(agg.localMissing).toBe(1);
      expect(agg.localNew).toBe(2);
      // アップロード候補 = 有効なローカル新規(1) + ローカル改変(1)。不備・競合・欠落は含めない
      expect(agg.needsUpload).toBe(2);
      // 既存の要再バックアップ数の定義は不変(未バックアップ + Qiita側更新あり)
      expect(agg.needsBackup).toBe(1);
    });
  });

  describe("markUploaded — アップロード結果の反映(upload-sync 7.3, 7.4)", () => {
    it("書き込み成功レスポンスで管理情報を更新し、直後の再分類が「最新」になる", async () => {
      // ローカル改変状態の記事を作る
      const item = makeItem({ id: "u1" });
      await backUp(item, "# 元の本文");
      const editedContent = "# ユーザが編集した本文";
      writeFileSync(join(root, "記事u1_u1", "記事u1.md"), editedContent, "utf8");
      expect(store.classify([item])[0]!.status).toBe("localModified");

      // アップロード成功(レスポンスItemは updated_at が前進している)
      const responseItem = { ...item, updatedAt: "2026-08-02T15:00:00+09:00" };
      store.markUploaded(
        responseItem,
        {
          dir: join(root, "記事u1_u1"),
          viewMd: join(root, "記事u1_u1", "記事u1.md"),
          originalMd: join(root, "記事u1_u1", "original.md"),
          metaJson: join(root, "記事u1_u1", "meta.json"),
        },
        sha256(editedContent),
      );
      // レスポンスの updated_at で再分類しても「最新」(updated_at前進の誤分類なし)
      expect(store.classify([responseItem])[0]!.status).toBe("upToDate");
    });
  });

  describe("永続化と履歴(5.1, 5.8)", () => {
    it("markBackedUp→saveIndexで永続化し、別インスタンスから読み戻せる", async () => {
      const item = makeItem({ id: "a1" });
      await backUp(item, "# 本文A");
      const saved = await store.saveIndex();
      expect(saved.ok).toBe(true);

      const store2 = new StateStoreImpl(storage);
      await store2.loadIndex();
      expect(store2.classify([item])[0]!.status).toBe("upToDate");
    });

    it("バックアップ実行履歴を追記・参照でき、直近50件を保持する", async () => {
      for (let i = 0; i < 55; i++) {
        store.appendHistory(makeSummary(`run-${i}`));
      }
      const history = store.getHistory();
      expect(history).toHaveLength(50);
      // 新しい順
      expect(history[0]!.runId).toBe("run-54");
      expect(history[49]!.runId).toBe("run-5");
    });

    it("履歴もsaveIndexで永続化される", async () => {
      store.appendHistory(makeSummary("run-1"));
      await store.saveIndex();
      const store2 = new StateStoreImpl(storage);
      await store2.loadIndex();
      expect(store2.getHistory()[0]!.runId).toBe("run-1");
    });
  });
});
