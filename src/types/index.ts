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
  // 403: スコープ不足以外(不正なタグ名等)でも発生するため、Qiitaのmessageを保持する
  | { kind: "forbidden"; message?: string }
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
  /** アップロードした画像の対応表(image-upload-automation 7.4)。省略時は空として扱う(既存metaとの後方互換) */
  uploadedImages?: UploadedImageEntry[];
};

// ---- Git 世代管理 ----------------------------------------------------------

export type CommitInfo = { hash: string; message: string; committedAt: string };

export type GitError = { kind: "unavailable" | "gitFailed"; message: string };

// ---- 状態管理 --------------------------------------------------------------

/** 8状態分類(article-upload-sync 2.7): 既存5状態 + ローカル新規/競合/ローカル欠落 */
export type BackupStatus =
  | "notBackedUp"
  | "upToDate"
  | "qiitaUpdated"
  | "localModified"
  | "deletedOnQiita"
  | "localNew"
  | "conflict"
  | "localMissing";

export type ArticleView = QiitaItem & {
  status: BackupStatus;
  lastBackupAt: string | null;
  folderName: string | null;
  /** ローカル新規記事の規約不備理由(1.3)。空または未定義=アップロード可 */
  invalidReasons?: string[];
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

/** Runの方向(article-upload-sync 8.4): バックアップ=ダウンロード / アップロード */
export type RunKind = "backup" | "upload";

/** アップロードRunで失敗した記事の記録(9.4) */
export type UploadFailure = { id: string; title: string; reason: string };

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
  /** Runの方向。省略時は backup(既存履歴との後方互換 — article-upload-sync 7.6) */
  direction?: RunKind;
  /** アップロード失敗記事の一覧と理由(9.4) */
  failures?: UploadFailure[];
  /** 画像フェーズの集計(image-upload-automation 9.2, 10.3)。省略時は画像フェーズなし */
  imageUpload?: ImageUploadSummary;
};

export type StartError =
  | { kind: "conflict" } // 実行中Runあり
  | { kind: "needsOverwriteConfirm"; articleIds: string[] } // 5.5
  | { kind: "invalidRequest"; message: string };

// ---- アップロードRun(article-upload-sync) -----------------------------------

export type UploadMode = "changes" | "selected";

export type UploadStartRequest = {
  mode: UploadMode;
  /** selected時: Qiita記事ID または ローカル新規キー(local:{folderName}) */
  ids?: string[];
  /** 実行前確認(3.4, 3.5, 4.3, 8.3)への同意フラグ */
  confirmed?: boolean;
  /** ローカル画像のQiitaへのアップロードを承認する(image-upload-automation 3.3)。省略時 false */
  uploadImages?: boolean;
};

/** 実行前確認情報(4.3, 3.4, 3.5, 8.3) */
export type UploadConfirmInfo = {
  targets: { key: string; title: string; kind: "create" | "update" }[];
  /** 公開中記事への即時反映の対象(3.4) */
  publicUpdates: { id: string; title: string }[];
  /** 競合記事(選択+明示承認時のみ許容 — 3.5) */
  conflicts: { id: string; title: string }[];
  /** 対応表で復元できないローカル画像参照の警告(8.3) */
  imageWarnings: { key: string; title: string; refs: string[] }[];
  /** 画像アップロードの計画(image-upload-automation 3.1)。機能が無効・利用不可・送る画像なしの場合は省略 */
  imagePlan?: ImageUploadPlan;
};

export type UploadStartError =
  | { kind: "conflict"; active: RunKind } // 8.4
  | { kind: "writeAccessDenied" } // 6.2 既知の権限不足
  | { kind: "needsUploadConfirm"; info: UploadConfirmInfo } // 3.4, 3.5, 4.3, 8.3
  | { kind: "invalidTargets"; details: { key: string; reason: string }[] } // 3.6, 1.3
  | { kind: "invalidRequest"; message: string };

// ---- ローカル新規記事(article-upload-sync 1.1〜1.3) --------------------------

export type LocalDraft = {
  /** 一覧・アップロード要求で使う識別子: "local:{folderName}" */
  key: string;
  folderName: string;
  mdFileName: string;
  /** frontmatter title(欠落時 null) */
  title: string | null;
  /** frontmatter tags */
  tags: string[];
  /** frontmatter除去後の本文 */
  body: string;
  /** 本文ファイルの最終更新日時(表示用) */
  mtime: string;
  /** 空=アップロード可。例: "titleがありません" */
  invalidReasons: string[];
};

// ---- Qiita API 書き込み(article-upload-sync 3.2, 3.3, 5.1, 5.3) --------------

export type CreateItemInput = {
  title: string;
  body: string;
  /** 1件以上(API必須) */
  tags: { name: string }[];
  /** 5.1: 新規は常に限定共有(非公開)。型レベルで固定する */
  private: true;
  tweet: false;
};

export type UpdateItemInput = {
  /** PATCH必須(ローカル管理情報の現在値を送信) */
  title: string;
  body: string;
  /** 現在値を送信(同期対象外のため変更しない — 3.3) */
  tags: { name: string }[];
  /** 5.3: 現在の公開範囲を明示送信(省略時挙動が未文書のため) */
  private: boolean;
};

// ---- 書き込み権限(article-upload-sync 6.1〜6.4) ------------------------------

/** 実績ベースの書き込み権限種別(スコープ照会APIが存在しないため) */
export type WriteAccess = "unknown" | "granted" | "denied";

// ---- 接続状態 --------------------------------------------------------------

export type ConnectionStatus =
  | { state: "unchecked"; maskedToken: string | null; writeAccess: WriteAccess }
  | {
      state: "connected";
      userId: string;
      itemsCount: number;
      maskedToken: string | null;
      writeAccess: WriteAccess;
    }
  | {
      state: "invalid";
      reason: "missing" | "unauthorized" | "forbidden";
      maskedToken: string | null;
      writeAccess: WriteAccess;
    };

export type ConnectionOk = { userId: string; itemsCount: number; savedToEnv: boolean };

export type ConnectionError =
  | { kind: "missing" }
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "network"; cause: string }
  | { kind: "server"; status: number };

// ---- 画像アップロード(image-upload-automation) ------------------------------

/** 画像↔Qiita画像URLの対応表の1件(7.4)。sha256 が同一性のキー */
export type UploadedImageEntry = {
  sha256: string;
  /** 記事フォルダ基準の相対パス(スラッシュ区切り)。同じ内容を複数の参照が指すことがある */
  paths: string[];
  url: string;
  bytes: number;
  uploadedAt: string;
};

/** 新規記事フォルダの補助ファイル .image-uploads.json(7.5 — 記事ID確定前の対応表) */
export type DraftImageUploads = { schemaVersion: 1; entries: UploadedImageEntry[] };

/** 機能設定 .image-upload/settings.json(1.1, 1.4, 5.1, 9.1) */
export type ImageUploadSettings = {
  schemaVersion: 1;
  enabled: boolean;
  consentedAt: string | null;
  persistSession: boolean;
  workDraftUrl: string | null;
};

export type ImageUploadSettingsPatch = {
  enabled?: boolean;
  /** 初回有効化時の同意(1.4) */
  consent?: true;
  persistSession?: boolean;
  workDraftUrl?: string | null;
};

export type ImageUploadSettingsError =
  | { kind: "consentRequired" } // 1.4: 同意なしの有効化
  | { kind: "invalidWorkDraftUrl" } // Qiitaの下書き編集画面以外
  | { kind: "io"; message: string };

/** 画面・APIへ返す設定(利用可否・保存済みセッションの有無を含む) */
export type ImageUploadSettingsView = ImageUploadSettings & {
  available: boolean;
  unavailableReason: string | null;
  hasSavedSession: boolean;
};

export type ImagePlanStatus =
  | { kind: "upload" }
  | { kind: "reuse"; url: string }
  | { kind: "missing" } // 2.3
  | { kind: "outsideFolder" } // 2.4
  | { kind: "unsupported"; reason: string }; // 2.5

export type ImagePlanEntry = {
  /** 本文に書かれたままの参照 */
  ref: string;
  /** 記事フォルダ基準の正規化パス(解決できた場合) */
  path: string | null;
  /** 実体の絶対パス(送信対象・再利用の場合) */
  absPath: string | null;
  bytes: number | null;
  sha256: string | null;
  status: ImagePlanStatus;
};

export type ArticleImagePlan = {
  key: string;
  title: string;
  folderName: string;
  entries: ImagePlanEntry[];
};

/** アップロード計画(3.1)。枚数・容量は内容ハッシュ単位 */
export type ImageUploadPlan = {
  articles: ArticleImagePlan[];
  uploadCount: number;
  uploadBytes: number;
  reuseCount: number;
};

export type ImageFailureEntry = {
  articleKey: string;
  articleTitle: string;
  ref: string;
  reason: string;
};

/** 画像フェーズ全体の中止理由(4.4, 4.5, 6.6, 8.1, 8.5, 1.3) */
export type ImagePhaseAbortKind =
  | "browserUnavailable"
  | "loginTimeout"
  | "browserClosed"
  | "cancelledBeforeUpload"
  | "editorUnavailable"
  | "cancelled"
  | "unexpected";

/** 実行履歴に載せる画像フェーズの集計(9.2, 10.3) */
export type ImageUploadSummary = {
  uploaded: number;
  reused: number;
  failed: ImageFailureEntry[];
  workDraftUrl: string | null;
  aborted: ImagePhaseAbortKind | null;
  /** 中止時の案内文(画面表示用) */
  abortMessage?: string;
};

/** 中断指示の参照(画像フェーズ・ログイン待機で区切りごとに確認する — 4.5, 6.6) */
export type CancelToken = { readonly cancelled: boolean };
