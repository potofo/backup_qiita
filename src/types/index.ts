/**
 * 共有型定義 — 依存最下層(design.md「File Structure Plan」参照)
 */

// ---- Result 型 ----------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });

// ---- 設定 ----------------------------------------------------------------

export type AppConfig = {
  backupDir: string;
  serverPort: number;
  tokenFromEnv: string | null;
  /** テスト・開発用のQiita APIベースURL上書き(通常はnull) */
  apiBaseUrl: string | null;
};

export type EnvWriteError = { kind: "io"; message: string };

// ---- Qiita API -----------------------------------------------------------

export type AuthenticatedUser = { id: string; itemsCount: number };

export type QiitaItem = {
  id: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  private: boolean;
  tags: { name: string }[];
  commentsCount: number;
  likesCount: number;
  stocksCount: number;
};

export type ApiError =
  | { kind: "unauthorized" } // 401
  | { kind: "forbidden" } // 403
  | { kind: "rateLimited"; resetAt: Date } // 429 → 3.12
  | { kind: "network"; cause: string }
  | { kind: "server"; status: number };

// ---- 画像ダウンロード ------------------------------------------------------

export type ImageResult =
  | { url: string; ok: true; fileName: string }
  | { url: string; ok: false; reason: string };

export type ImageFailure = { articleId: string; articleTitle: string; url: string; reason: string };

// ---- ストレージ ------------------------------------------------------------

export type ArticlePaths = {
  dir: string;
  viewMd: string;
  originalMd: string;
  metaJson: string;
};

export type StorageError = {
  kind: "io" | "forbiddenPath" | "notFound";
  message: string;
};

export type ArticleMeta = {
  schemaVersion: 1;
  id: string;
  title: string;
  url: string;
  private: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
  likesCount: number;
  stocksCount: number;
  backedUpAt: string;
  images: ImageResult[];
};

// ---- Git 世代管理 ----------------------------------------------------------

export type CommitInfo = { hash: string; message: string; committedAt: string };

export type GitError = { kind: "unavailable" | "gitFailed"; message: string };

// ---- 状態管理 --------------------------------------------------------------

export type BackupStatus =
  | "notBackedUp"
  | "upToDate"
  | "qiitaUpdated"
  | "localModified"
  | "deletedOnQiita";

export type ArticleView = QiitaItem & {
  status: BackupStatus;
  lastBackupAt: string | null;
  folderName: string | null;
};

export type IndexArticleEntry = {
  title: string;
  folderName: string;
  url: string;
  private: boolean;
  qiitaUpdatedAt: string;
  lastBackupAt: string;
  contentHash: string;
};

export type IndexFile = {
  schemaVersion: 1;
  articles: Record<string, IndexArticleEntry>;
  history: RunSummary[];
};

// ---- バックアップ実行(Run) --------------------------------------------------

export type RunMode = "all" | "diff" | "selected";

export type RunSummary = {
  runId: string;
  mode: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  succeeded: number;
  failed: number;
  imageFailures: ImageFailure[];
  cancelled: boolean;
  commit: CommitInfo | null;
};

export type StartError =
  | { kind: "conflict" } // 実行中Runあり
  | { kind: "needsOverwriteConfirm"; articleIds: string[] } // 5.5
  | { kind: "invalidRequest"; message: string };

// ---- 接続状態 --------------------------------------------------------------

export type ConnectionStatus =
  | { state: "unchecked"; maskedToken: string | null }
  | { state: "connected"; userId: string; itemsCount: number; maskedToken: string | null }
  | { state: "invalid"; reason: "missing" | "unauthorized" | "forbidden"; maskedToken: string | null };

export type ConnectionOk = { userId: string; itemsCount: number; savedToEnv: boolean };

export type ConnectionError =
  | { kind: "missing" }
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "network"; cause: string }
  | { kind: "server"; status: number };
