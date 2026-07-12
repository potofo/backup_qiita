/**
 * バックアップ実行サービス(3.3)
 * - 全件/差分(既定)/選択の3モードのRunを統括し、同時実行は1件に制限する(3.1〜3.3)
 * - 記事ごと: 画像取得→相対パス書換→保存→状態更新、進捗イベント発行(3.4〜3.9)
 * - 中断は処理中記事の完了を待って停止し、いずれの終了でもindex保存+Gitコミット(3.10, 6.3)
 * - 429は再開時刻まで待機して自動再開(3.12)、記事単位の上限付きリトライ(9.2)
 */
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ArticleView,
  ImageFailure,
  ImageResult,
  QiitaItem,
  Result,
  RunMode,
  RunSummary,
  StartError,
} from "../types/index.js";
import { ok, err } from "../types/index.js";
import type { QiitaApiClient } from "../infra/qiitaApiClient.js";
import type { ImageDownloader } from "../infra/imageDownloader.js";
import type { StorageManager } from "../infra/storageManager.js";
import type { GitManager } from "../infra/gitManager.js";
import type { StateStore } from "./stateStore.js";
import type { ProgressBus } from "./progressBus.js";
import type { Logger } from "../config/logger.js";

export type RunHandle = {
  runId: string;
  /** Runの完了(中断・エラー終了含む)を待てるPromise */
  done: Promise<RunSummary>;
};

export interface BackupService {
  start(req: {
    mode: RunMode;
    ids?: string[];
    confirmOverwrite?: boolean;
  }): Result<RunHandle, StartError>;
  cancel(): void; // 3.10
  /** ダッシュボードの一覧取得結果を共有し、上書き確認判定(5.5)に使う */
  updateArticleCache(views: ArticleView[]): void;
}

type Deps = {
  qiitaClient: QiitaApiClient;
  imageDownloader: ImageDownloader;
  storageManager: StorageManager;
  gitManager: GitManager;
  stateStore: StateStore;
  progressBus: ProgressBus;
  logger?: Logger;
};

type Options = {
  /** 記事単位リトライの上限(既定2回 — 9.2) */
  retryLimit?: number;
  /** 一覧取得失敗(network/server)時のリトライ間隔ms */
  listRetryDelayMs?: number;
};

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** 閲覧用Markdown: ダウンロード成功画像の参照を images/ への相対パスへ書き換える(3.6) */
export const rewriteImageRefs = (markdown: string, images: ImageResult[]): string => {
  let out = markdown;
  for (const image of images) {
    if (image.ok) {
      out = out.split(image.url).join(`images/${image.fileName}`);
    }
    // 失敗した画像は元URLのまま残す(3.8)
  }
  return out;
};

export class BackupServiceImpl implements BackupService {
  private running = false;
  private cancelled = false;
  private articleCache: ArticleView[] | null = null;
  private readonly retryLimit: number;
  private readonly listRetryDelayMs: number;

  constructor(
    private readonly deps: Deps,
    options: Options = {},
  ) {
    this.retryLimit = options.retryLimit ?? 2;
    this.listRetryDelayMs = options.listRetryDelayMs ?? 1000;
  }

  updateArticleCache(views: ArticleView[]): void {
    this.articleCache = views;
  }

  start(req: {
    mode: RunMode;
    ids?: string[];
    confirmOverwrite?: boolean;
  }): Result<RunHandle, StartError> {
    if (this.running) return err({ kind: "conflict" }); // 同時実行は1件(排他)
    if (req.mode === "selected" && (!req.ids || req.ids.length === 0)) {
      return err({ kind: "invalidRequest", message: "選択バックアップには記事IDの指定が必要です" });
    }

    // 「ローカル変更あり」記事を含むRunは上書き確認済みフラグを要求する(5.5)
    if (!req.confirmOverwrite && this.articleCache) {
      const targets = this.selectTargets(this.articleCache, req.mode, req.ids);
      const modified = targets.filter((t) => t.status === "localModified").map((t) => t.id);
      if (modified.length > 0) {
        return err({ kind: "needsOverwriteConfirm", articleIds: modified });
      }
    }

    this.running = true;
    this.cancelled = false;
    const runId = `run-${randomUUID()}`;
    const done = this.executeRun(runId, req).finally(() => {
      this.running = false;
    });
    return ok({ runId, done });
  }

  cancel(): void {
    if (this.running) {
      this.cancelled = true;
      this.deps.logger?.info("バックアップの中断が指示されました");
    }
  }

  private selectTargets(views: ArticleView[], mode: RunMode, ids?: string[]): ArticleView[] {
    // Qiita側削除の記事は取得できないため常に対象外(5.6: ローカルは保持)
    const backupable = views.filter((v) => v.status !== "deletedOnQiita");
    if (mode === "all") return backupable;
    if (mode === "selected") {
      const idSet = new Set(ids ?? []);
      return backupable.filter((v) => idSet.has(v.id));
    }
    // diff(既定): 未バックアップ + Qiita側更新あり(3.3)
    return backupable.filter((v) => v.status === "notBackedUp" || v.status === "qiitaUpdated");
  }

  private async executeRun(
    runId: string,
    req: { mode: RunMode; ids?: string[]; confirmOverwrite?: boolean },
  ): Promise<RunSummary> {
    const { progressBus, stateStore, gitManager, logger } = this.deps;
    const startedAt = new Date().toISOString();
    progressBus.emit({ type: "run-start", runId, mode: req.mode });

    let succeeded = 0;
    let failed = 0;
    let targets: ArticleView[] = [];
    const imageFailures: ImageFailure[] = [];

    // 記事一覧の取得(429は待機して自動再開 — 3.12)
    const itemsResult = await this.fetchItemsWithWait();
    if (!itemsResult.ok) {
      progressBus.emit({ type: "run-error", code: itemsResult.error.code, message: itemsResult.error.message });
      logger?.error("記事一覧の取得に失敗したためRunを中断します", { code: itemsResult.error.code });
    } else {
      const views = stateStore.classify(itemsResult.value);
      this.articleCache = views;
      targets = this.selectTargets(views, req.mode, req.ids);

      // サーバ側の安全網: 未確認の「ローカル変更あり」上書きを拒否する(5.5)
      if (!req.confirmOverwrite && targets.some((t) => t.status === "localModified")) {
        progressBus.emit({
          type: "run-error",
          code: "OVERWRITE_CONFIRM_REQUIRED",
          message: "ローカル変更のある記事が含まれています。上書きを確認してから再実行してください。",
        });
        targets = [];
      }

      progressBus.emit({ type: "progress", done: 0, total: targets.length, currentTitle: "" });

      for (let i = 0; i < targets.length; i++) {
        if (this.cancelled) break; // 中断: 処理中記事の完了を待って停止(3.10)
        const article = targets[i]!;
        progressBus.emit({ type: "progress", done: i, total: targets.length, currentTitle: article.title });

        const result = await this.processArticleWithRetry(article);
        if (result.ok) {
          succeeded += 1;
          const failedImages = result.value.filter((r) => !r.ok);
          for (const image of failedImages) {
            if (!image.ok) {
              imageFailures.push({
                articleId: article.id,
                articleTitle: article.title,
                url: image.url,
                reason: image.reason,
              });
            }
          }
          progressBus.emit({
            type: "article-done",
            id: article.id,
            title: article.title,
            ok: true,
            imageFailed: failedImages.length,
          });
        } else {
          failed += 1;
          progressBus.emit({
            type: "article-done",
            id: article.id,
            title: article.title,
            ok: false,
            imageFailed: 0,
            reason: result.error,
          });
        }
        progressBus.emit({
          type: "progress",
          done: i + 1,
          total: targets.length,
          currentTitle: article.title,
        });
      }
    }

    // 中断・完了のいずれでも管理情報保存とGitコミットを実行する(6.3)
    const summary: RunSummary = {
      runId,
      mode: req.mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      total: targets.length,
      succeeded,
      failed,
      imageFailures,
      cancelled: this.cancelled,
      commit: null,
    };
    stateStore.appendHistory(summary);
    // 処理実績のないRun(対象0件)は index.json 保存とコミットを行わない(6.4: 変更ゼロならコミットしない)
    const workAttempted = succeeded > 0 || failed > 0 || this.cancelled;
    if (workAttempted) {
      const saveResult = await stateStore.saveIndex();
      if (!saveResult.ok) {
        logger?.error("index.jsonの保存に失敗しました", { message: saveResult.error.message });
      }

      const commitResult = await gitManager.commitRun(summary);
      if (commitResult.ok && commitResult.value) {
        summary.commit = commitResult.value;
        await stateStore.saveIndex(); // 履歴にコミット情報を反映(コミット失敗はRun失敗にしない — 6.6)
      }
    }

    progressBus.emit({ type: "run-done", summary });
    logger?.info("バックアップRunが終了しました", {
      runId,
      total: summary.total,
      succeeded,
      failed,
      cancelled: summary.cancelled,
    });
    return summary;
  }

  /** 一覧取得。429は待機して再試行、network/serverは上限付きリトライ */
  private async fetchItemsWithWait(): Promise<
    Result<QiitaItem[], { code: string; message: string }>
  > {
    let networkRetries = 0;
    for (;;) {
      const result = await this.deps.qiitaClient.fetchAllItems();
      if (result.ok) return result;
      const error = result.error;
      if (error.kind === "rateLimited") {
        const resumeAt = error.resetAt.toISOString();
        this.deps.progressBus.emit({ type: "waiting-rate-limit", resumeAt });
        this.deps.logger?.info("レート制限のため待機します(3.12)", { resumeAt });
        await delay(Math.max(0, error.resetAt.getTime() - Date.now()) + 100);
        continue; // 自動再開
      }
      if ((error.kind === "network" || error.kind === "server") && networkRetries < this.retryLimit) {
        networkRetries += 1;
        await delay(this.listRetryDelayMs);
        continue;
      }
      if (error.kind === "unauthorized" || error.kind === "forbidden") {
        return err({
          code: error.kind.toUpperCase(),
          message: "認証に失敗しました。接続確認画面でトークンを確認してください。",
        });
      }
      return err({
        code: "LIST_FETCH_FAILED",
        message: "記事一覧の取得に失敗しました。時間をおいて再実行してください。",
      });
    }
  }

  /** 記事単位の処理を上限付きリトライで包む(9.2)。成功時は画像結果を返す */
  private async processArticleWithRetry(
    article: QiitaItem,
  ): Promise<Result<ImageResult[], string>> {
    let lastError = "";
    for (let attempt = 0; attempt <= this.retryLimit; attempt++) {
      try {
        const images = await this.processArticle(article);
        return ok(images);
      } catch (cause) {
        lastError = cause instanceof Error ? cause.message : String(cause);
        this.deps.logger?.warn("記事の処理に失敗しました(リトライします)", {
          articleId: article.id,
          attempt,
          cause: lastError,
        });
      }
    }
    this.deps.logger?.error("記事の処理がリトライ上限を超過しました(失敗記録して継続 — 9.2)", {
      articleId: article.id,
      cause: lastError,
    });
    return err(lastError);
  }

  /** 本文取得済みの記事1件: フォルダ準備→画像取得→書換→保存→状態更新(3.4〜3.7) */
  private async processArticle(article: QiitaItem): Promise<ImageResult[]> {
    const { imageDownloader, storageManager, stateStore } = this.deps;

    // リネーム(4.6)を先に済ませ、画像のダウンロード先を確定させる
    const prepared = await storageManager.prepareArticleDir(article);
    if (!prepared.ok) throw new Error(prepared.error.message);

    const urls = imageDownloader.extractImageUrls(article.body);
    const images = await imageDownloader.downloadAll(urls, storageManager.imagesDirFor(article));
    const rewritten = rewriteImageRefs(article.body, images);

    const saved = await storageManager.saveArticle(article, rewritten, images);
    if (!saved.ok) throw new Error(saved.error.message);

    stateStore.markBackedUp(article, saved.value, sha256(rewritten));
    return images;
  }
}
