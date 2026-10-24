/**
 * 状態管理ストア(3.2 / article-upload-sync 2.1〜2.7, 7.3, 7.4)
 * - backups/index.json の永続管理(5.1)、8状態分類(5.2〜5.4, 5.6 + localNew/conflict/localMissing)、実行履歴(5.8)
 * - 分類の決定木: 欠落 → 競合 → ローカル改変 → Qiita側更新 → 最新(article-upload-sync design.md)
 * - 保存は write-then-rename のアトミック方式(9.3 — StorageManagerに委譲)
 */
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import type {
  ArticlePaths,
  ArticleView,
  BackupStatus,
  IndexFile,
  LocalDraft,
  QiitaItem,
  Result,
  RunSummary,
  StorageError,
} from "../types/index.js";
import type { StorageManager } from "../infra/storageManager.js";
import type { Logger } from "../config/logger.js";

const INDEX_FILE = "index.json";
const HISTORY_LIMIT = 50;

export interface StateStore {
  loadIndex(): Promise<IndexFile>;
  /**
   * Qiita一覧・管理情報・ローカル新規候補を突合し、8状態のビューを返す
   * (Qiita側削除の記事・ローカル新規記事も含む — upload-sync 1.2, 2.7)
   */
  classify(qiitaItems: QiitaItem[], localDrafts?: LocalDraft[]): ArticleView[];
  markBackedUp(item: QiitaItem, files: ArticlePaths, hash: string): void;
  /**
   * 書き込み成功の反映(upload-sync 7.3, 7.4)。
   * レスポンスItemの updated_at・本文ハッシュで管理情報を即時更新し、直後の再分類を「最新」にする
   */
  markUploaded(item: QiitaItem, files: ArticlePaths, hash: string): void;
  /** index登録済みの記事ID集合(ローカル新規候補の除外判定に使う — upload-sync 1.1) */
  knownIds(): ReadonlySet<string>;
  appendHistory(run: RunSummary): void;
  getHistory(): RunSummary[];
  saveIndex(): Promise<Result<void, StorageError>>;
}

/** 状態集計値(5.7 / upload-sync 2.7) */
export type StatusAggregate = {
  total: number;
  notBackedUp: number;
  upToDate: number;
  qiitaUpdated: number;
  localModified: number;
  deletedOnQiita: number;
  localNew: number;
  conflict: number;
  localMissing: number;
  /** 要再バックアップ数 = 未バックアップ + Qiita側更新あり(既存定義のまま) */
  needsBackup: number;
  /** アップロード候補数 = 有効なローカル新規 + ローカル改変(upload-sync 4.1) */
  needsUpload: number;
};

export const summarize = (views: ArticleView[]): StatusAggregate => {
  const count = (status: BackupStatus): number => views.filter((v) => v.status === status).length;
  const notBackedUp = count("notBackedUp");
  const qiitaUpdated = count("qiitaUpdated");
  const localModified = count("localModified");
  const validLocalNew = views.filter(
    (v) => v.status === "localNew" && (v.invalidReasons ?? []).length === 0,
  ).length;
  return {
    total: views.length,
    notBackedUp,
    upToDate: count("upToDate"),
    qiitaUpdated,
    localModified,
    deletedOnQiita: count("deletedOnQiita"),
    localNew: count("localNew"),
    conflict: count("conflict"),
    localMissing: count("localMissing"),
    needsBackup: notBackedUp + qiitaUpdated,
    needsUpload: validLocalNew + localModified,
  };
};

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const emptyIndex = (): IndexFile => ({ schemaVersion: 1, articles: {}, history: [] });

export class StateStoreImpl implements StateStore {
  private index: IndexFile = emptyIndex();

  constructor(
    private readonly storage: StorageManager,
    private readonly logger?: Logger,
  ) {}

  async loadIndex(): Promise<IndexFile> {
    const result = this.storage.readJson<IndexFile>(INDEX_FILE);
    if (result.ok && result.value.schemaVersion === 1) {
      this.index = result.value;
    } else {
      if (!result.ok && result.error.kind !== "notFound") {
        this.logger?.warn("index.jsonの読み込みに失敗したため新規作成します", {
          message: result.error.message,
        });
      }
      this.index = emptyIndex();
    }
    return this.index;
  }

  classify(qiitaItems: QiitaItem[], localDrafts: LocalDraft[] = []): ArticleView[] {
    const views: ArticleView[] = qiitaItems.map((item) => {
      const entry = this.index.articles[item.id];
      if (!entry) {
        return { ...item, status: "notBackedUp", lastBackupAt: null, folderName: null };
      }
      const status = this.classifyExisting(item, entry.qiitaUpdatedAt, entry.folderName, entry.contentHash);
      return { ...item, status, lastBackupAt: entry.lastBackupAt, folderName: entry.folderName };
    });

    // indexに存在するがQiita一覧に存在しない → Qiita側削除(5.6: ローカルデータは削除しない)
    const liveIds = new Set(qiitaItems.map((i) => i.id));
    for (const [id, entry] of Object.entries(this.index.articles)) {
      if (liveIds.has(id)) continue;
      views.push({
        id,
        title: entry.title,
        body: "",
        url: entry.url,
        createdAt: "",
        updatedAt: entry.qiitaUpdatedAt,
        private: entry.private,
        tags: [],
        commentsCount: 0,
        likesCount: 0,
        stocksCount: 0,
        status: "deletedOnQiita",
        lastBackupAt: entry.lastBackupAt,
        folderName: entry.folderName,
      });
    }

    // ローカル新規候補を一覧へ合流させる(upload-sync 1.2, 1.3 — 不備も理由付きで表示)
    for (const draft of localDrafts) {
      views.push({
        id: draft.key,
        title: draft.title ?? draft.folderName,
        body: draft.body,
        url: "",
        createdAt: "",
        updatedAt: draft.mtime,
        private: true, // 登録時は常に限定共有(5.1)
        tags: draft.tags.map((name) => ({ name })),
        commentsCount: 0,
        likesCount: 0,
        stocksCount: 0,
        status: "localNew",
        lastBackupAt: null,
        folderName: draft.folderName,
        invalidReasons: draft.invalidReasons,
      });
    }
    return views;
  }

  /** 分類の決定木(upload-sync design.md): 欠落 → 競合 → ローカル改変 → Qiita側更新 → 最新 */
  private classifyExisting(
    item: QiitaItem,
    qiitaUpdatedAt: string,
    folderName: string,
    contentHash: string,
  ): BackupStatus {
    const qiitaNewer =
      new Date(item.updatedAt).getTime() > new Date(qiitaUpdatedAt).getTime(); // 既存判定(5.3)

    const viewMdName = `${folderName.slice(0, -(item.id.length + 1))}.md`;
    const viewMdPath = join(this.storage.root, folderName, viewMdName);
    if (!existsSync(viewMdPath)) return "localMissing"; // 欠落: 再バックアップで復元可能(upload-sync 2.3)
    let hashMismatch: boolean;
    try {
      hashMismatch = sha256(readFileSync(viewMdPath, "utf8")) !== contentHash;
    } catch {
      return "localMissing"; // 読み取り不能も欠落として扱う(失われる変更は検知できない)
    }
    if (hashMismatch) {
      return qiitaNewer ? "conflict" : "localModified"; // 競合は双方更新(upload-sync 2.5)
    }
    return qiitaNewer ? "qiitaUpdated" : "upToDate";
  }

  markBackedUp(item: QiitaItem, files: ArticlePaths, hash: string): void {
    this.index.articles[item.id] = {
      title: item.title,
      folderName: basename(files.dir),
      url: item.url,
      private: item.private,
      qiitaUpdatedAt: item.updatedAt,
      lastBackupAt: new Date().toISOString(),
      contentHash: hash,
    };
  }

  markUploaded(item: QiitaItem, files: ArticlePaths, hash: string): void {
    // 書き込みレスポンスの updated_at・ハッシュで即時更新 → 再分類が「最新」になる(7.3, 7.4)
    this.markBackedUp(item, files, hash);
  }

  knownIds(): ReadonlySet<string> {
    return new Set(Object.keys(this.index.articles));
  }

  appendHistory(run: RunSummary): void {
    this.index.history.unshift(run);
    if (this.index.history.length > HISTORY_LIMIT) {
      this.index.history = this.index.history.slice(0, HISTORY_LIMIT);
    }
  }

  getHistory(): RunSummary[] {
    return this.index.history;
  }

  async saveIndex(): Promise<Result<void, StorageError>> {
    return this.storage.writeJsonAtomic(INDEX_FILE, this.index);
  }
}
