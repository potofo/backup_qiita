/**
 * 状態管理ストア(3.2)
 * - backups/index.json の永続管理(5.1)、5状態分類(5.2〜5.4, 5.6)、実行履歴(5.8)
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
  /** Qiita一覧と管理情報を突合し、5状態のビューを返す(Qiita側削除の記事も含む) */
  classify(qiitaItems: QiitaItem[]): ArticleView[];
  markBackedUp(item: QiitaItem, files: ArticlePaths, hash: string): void;
  appendHistory(run: RunSummary): void;
  getHistory(): RunSummary[];
  saveIndex(): Promise<Result<void, StorageError>>;
}

/** 状態集計値(5.7) */
export type StatusAggregate = {
  total: number;
  notBackedUp: number;
  upToDate: number;
  qiitaUpdated: number;
  localModified: number;
  deletedOnQiita: number;
  /** 要再バックアップ数 = 未バックアップ + Qiita側更新あり */
  needsBackup: number;
};

export const summarize = (views: ArticleView[]): StatusAggregate => {
  const count = (status: BackupStatus): number => views.filter((v) => v.status === status).length;
  const notBackedUp = count("notBackedUp");
  const qiitaUpdated = count("qiitaUpdated");
  return {
    total: views.length,
    notBackedUp,
    upToDate: count("upToDate"),
    qiitaUpdated,
    localModified: count("localModified"),
    deletedOnQiita: count("deletedOnQiita"),
    needsBackup: notBackedUp + qiitaUpdated,
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

  classify(qiitaItems: QiitaItem[]): ArticleView[] {
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
    return views;
  }

  /** 状態分類表(design.md)の優先順: ローカル変更 → Qiita側更新 → 最新 */
  private classifyExisting(
    item: QiitaItem,
    qiitaUpdatedAt: string,
    folderName: string,
    contentHash: string,
  ): BackupStatus {
    const viewMdName = `${folderName.slice(0, -(item.id.length + 1))}.md`;
    const viewMdPath = join(this.storage.root, folderName, viewMdName);
    if (!existsSync(viewMdPath)) return "localModified"; // ファイル欠落(5.4)
    try {
      const current = sha256(readFileSync(viewMdPath, "utf8"));
      if (current !== contentHash) return "localModified"; // ハッシュ不一致(5.4)
    } catch {
      return "localModified";
    }
    if (new Date(item.updatedAt).getTime() > new Date(qiitaUpdatedAt).getTime()) {
      return "qiitaUpdated"; // 5.3
    }
    return "upToDate";
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
