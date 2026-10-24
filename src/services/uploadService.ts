/**
 * アップロード実行サービス(article-upload-sync 3, 4, 5, 6.2〜6.3, 7, 8.1, 8.3, 9)
 * - 変更点全件(changes)/選択(selected)の2モードのアップロードRunを統括する
 * - 実行前確認(対象一覧・公開反映・競合・ローカル画像警告)なしでは書き込みを一切行わない(8.1)
 * - 記事を1件ずつ直列処理: 新規は限定共有で登録→フォルダ正規化、更新は本文更新→原本更新(7.3, 7.4)
 * - 429待機・記事単位リトライ・401/403即時中止(9.1〜9.3)。どの終了経路でもindex保存+Gitコミット(7.5)
 * - 画像アップロード(image-upload-automation 1.2, 3.x, 7.1, 7.3, 8.2〜8.4, 9.2, 10.x): 機能が有効なら実行前確認に画像計画を載せ、
 *   承認されたら記事の処理より前に画像フェーズを実行する。置換するのは送信本文だけで、閲覧用mdには書き戻さない
 */
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ArticleMeta,
  ArticleView,
  CancelToken,
  CreateItemInput,
  ImagePhaseAbortKind,
  ImageResult,
  ImageUploadPlan,
  ImageUploadSummary,
  LocalDraft,
  Result,
  RunSummary,
  UpdateItemInput,
  UploadConfirmInfo,
  UploadFailure,
  UploadStartError,
  UploadStartRequest,
} from "../types/index.js";
import { ok, err } from "../types/index.js";
import type { QiitaApiClient } from "../infra/qiitaApiClient.js";
import type { StorageManager } from "../infra/storageManager.js";
import type { GitManager } from "../infra/gitManager.js";
import type { LocalArticleScanner } from "../infra/localArticleScanner.js";
import type { StateStore } from "./stateStore.js";
import type { ProgressBus } from "./progressBus.js";
import type { RunCoordinator, RunLease } from "./runCoordinator.js";
import type { AuthService } from "./authService.js";
import { restoreImageRefs, type RunHandle } from "./backupService.js";
import { extractLocalImageRefs, rewriteImageRefs } from "./imageRefRewriter.js";
import type { ImageUploadPlanner } from "./imageUploadPlanner.js";
import type { ImagePhaseError, ImagePhaseResult, ImageUploadService } from "./imageUploadService.js";
import type { Logger } from "../config/logger.js";

export interface UploadService {
  start(req: UploadStartRequest): Result<RunHandle, UploadStartError>;
  cancel(): void; // 7.2
  /** ダッシュボードの一覧取得結果を共有し、対象選定・確認情報の生成に使う */
  updateArticleCache(views: ArticleView[]): void;
}

type Deps = {
  qiitaClient: QiitaApiClient;
  storageManager: StorageManager;
  gitManager: GitManager;
  stateStore: StateStore;
  progressBus: ProgressBus;
  runCoordinator: RunCoordinator;
  scanner: LocalArticleScanner;
  authService: AuthService;
  /** 画像アップロード機能(image-upload-automation)。未指定なら従来どおりの挙動(1.2) */
  imageUpload?: ImageUploadFeature;
  logger?: Logger;
};

export type ImageUploadFeature = {
  planner: ImageUploadPlanner;
  service: ImageUploadService;
  /** 有効化済みかつ実行環境が利用可能か(1.1, 1.3) */
  isEnabled(): boolean;
};

/** 記事ごとの画像の扱い: 置換して送る / 画像の失敗で送らない */
type ImageDecision = { send: true; mapping: Map<string, string> } | { send: false; reason: string };

/** Runの画像に関する前提(実行前確認で提示した計画と、画像フェーズを実行するか) */
type ImageRunContext = { plan: ImageUploadPlan | null; runPhase: boolean };

type Options = {
  /** 記事単位リトライの上限(既定2回 — 9.2) */
  retryLimit?: number;
  /** network/5xx時のリトライ間隔ms */
  retryDelayMs?: number;
};

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** ローカル画像参照の抽出は imageRefRewriter へ移設(image-upload-automation 2.1)。既存の呼び出し元のため再エクスポートする */
export { extractLocalImageRefs };

/** 記事1件の処理エラー(abortRun=trueは401/403 — 残り全件を中止する) */
type ArticleError = { reason: string; abortRun: boolean; forbidden: boolean };

/** 更新対象の本文ソース(閲覧用md+meta対応表による逆書換結果) */
type UpdateSource = { content: string; restored: string; images: ImageResult[] };

export class UploadServiceImpl implements UploadService {
  private lease: RunLease | null = null;
  private cancelled = false;
  private articleCache: ArticleView[] | null = null;
  private readonly retryLimit: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly deps: Deps,
    options: Options = {},
  ) {
    this.retryLimit = options.retryLimit ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  updateArticleCache(views: ArticleView[]): void {
    this.articleCache = views;
  }

  start(req: UploadStartRequest): Result<RunHandle, UploadStartError> {
    if (req.mode !== "changes" && req.mode !== "selected") {
      return err({ kind: "invalidRequest", message: "モードは changes / selected のいずれかを指定してください。" });
    }
    if (req.mode === "selected" && (!req.ids || req.ids.length === 0)) {
      return err({ kind: "invalidRequest", message: "選択アップロードには対象の指定が必要です。" });
    }
    const active = this.deps.runCoordinator.active();
    if (active !== null) return err({ kind: "conflict", active }); // 8.4
    if (this.deps.authService.writeAccess() === "denied") {
      return err({ kind: "writeAccessDenied" }); // 6.2 既知の権限不足は開始前に拒否
    }
    if (!this.articleCache) {
      return err({ kind: "invalidRequest", message: "記事一覧を取得してから実行してください。" });
    }

    // 対象選定(4.1, 4.2 / 3.1, 3.5, 3.6)
    const selected = this.selectTargets(this.articleCache, req);
    if (!selected.ok) return selected;
    const targets = selected.value;
    if (targets.length === 0) {
      return err({ kind: "invalidRequest", message: "アップロード対象の変更がありません。" });
    }

    // 実行前確認(3.4, 3.5, 4.3, 8.3)— 確認なしでは書き込みを一切行わない(8.1)
    const imagePlan = this.planImages(targets);
    const info = this.buildConfirmInfo(targets, imagePlan);
    if (!req.confirmed) return err({ kind: "needsUploadConfirm", info });
    // 画像の送信は、確認情報で計画を提示したうえで明示的に承認された場合だけ(image-upload-automation 3.3)
    const image: ImageRunContext = {
      plan: imagePlan,
      runPhase: req.uploadImages === true && imagePlan !== null && imagePlan.uploadCount > 0,
    };

    const runId = `run-${randomUUID()}`;
    const acquired = this.deps.runCoordinator.acquire("upload", runId);
    if (!acquired.ok) return err({ kind: "conflict", active: acquired.error.active });
    this.lease = acquired.value;
    this.cancelled = false;
    const done = this.executeRun(runId, req.mode, targets, image).finally(() => {
      this.lease?.release();
      this.lease = null;
    });
    return ok({ runId, done });
  }

  cancel(): void {
    if (this.lease) {
      this.cancelled = true;
      this.deps.logger?.info("アップロードの中断が指示されました");
    }
  }

  /** 対象選定: changes=ローカル新規(有効)+ローカル改変全件 / selected=検証付きの選択分 */
  private selectTargets(
    views: ArticleView[],
    req: UploadStartRequest,
  ): Result<ArticleView[], UploadStartError> {
    if (req.mode === "changes") {
      // 競合・欠落・削除済み・規約不備は常に除外する(4.2)
      return ok(
        views.filter(
          (v) =>
            (v.status === "localNew" && (v.invalidReasons ?? []).length === 0) ||
            v.status === "localModified",
        ),
      );
    }

    const targets: ArticleView[] = [];
    const invalid: { key: string; reason: string }[] = [];
    for (const id of req.ids ?? []) {
      const view = views.find((v) => v.id === id);
      if (!view) {
        invalid.push({ key: id, reason: "一覧に存在しません。一覧を再取得してください。" });
        continue;
      }
      switch (view.status) {
        case "localNew": {
          const reasons = view.invalidReasons ?? [];
          if (reasons.length > 0) {
            invalid.push({ key: id, reason: reasons.join(" / ") }); // 1.3
          } else {
            targets.push(view);
          }
          break;
        }
        case "localModified":
        case "conflict": // 3.5: 選択+明示承認時のみ許容(確認情報で警告する)
          targets.push(view);
          break;
        case "deletedOnQiita":
          invalid.push({ key: id, reason: "Qiita側で削除された記事はアップロードできません(再登録は行いません)。" }); // 3.6
          break;
        case "localMissing":
          invalid.push({ key: id, reason: "本文ファイルがローカルにありません(再バックアップで復元できます)。" }); // 3.6
          break;
        default:
          invalid.push({ key: id, reason: "アップロード対象の状態ではありません(ローカル新規・ローカル変更ありのみ対象)。" });
      }
    }
    if (invalid.length > 0) return err({ kind: "invalidTargets", details: invalid });
    return ok(targets);
  }

  /** 実行前確認情報の生成(4.3, 3.4, 3.5, 8.3) */
  private buildConfirmInfo(targets: ArticleView[], imagePlan: ImageUploadPlan | null): UploadConfirmInfo {
    const info: UploadConfirmInfo = {
      targets: targets.map((v) => ({
        key: v.id,
        title: v.title,
        kind: v.status === "localNew" ? "create" : "update",
      })),
      publicUpdates: targets
        .filter((v) => v.status !== "localNew" && !v.private)
        .map((v) => ({ id: v.id, title: v.title })),
      conflicts: targets
        .filter((v) => v.status === "conflict")
        .map((v) => ({ id: v.id, title: v.title })),
      imageWarnings: [],
    };

    for (const view of targets) {
      let refs: string[];
      if (view.status === "localNew") {
        refs = extractLocalImageRefs(view.body); // 新規は対応表がなく全相対参照が警告対象
      } else {
        const source = this.readUpdateSource(view);
        refs = source.ok ? extractLocalImageRefs(source.value.restored) : [];
      }
      // 対応表で再利用できる画像は送信時に置換されるため警告しない(image-upload-automation 2.6)
      const reused = new Set(
        imagePlan?.articles
          .find((a) => a.key === view.id)
          ?.entries.filter((e) => e.status.kind === "reuse")
          .map((e) => e.ref) ?? [],
      );
      const unresolved = refs.filter((ref) => !reused.has(ref));
      if (unresolved.length > 0) {
        info.imageWarnings.push({ key: view.id, title: view.title, refs: unresolved });
      }
    }
    // 送る必要のある画像があるときだけ画像計画を提示する(image-upload-automation 3.1)
    if (imagePlan && imagePlan.uploadCount > 0) info.imagePlan = imagePlan;
    return info;
  }

  /** 画像アップロード機能が有効なら、対象記事の送信予定本文から計画を作る(無効なら null — 1.2) */
  private planImages(targets: ArticleView[]): ImageUploadPlan | null {
    const feature = this.deps.imageUpload;
    if (!feature || !feature.isEnabled()) return null;
    const planTargets = targets.flatMap((view) => {
      if (!view.folderName) return [];
      if (view.status === "localNew") {
        return [{ key: view.id, title: view.title, folderName: view.folderName, body: view.body }];
      }
      const source = this.readUpdateSource(view);
      return source.ok ? [{ key: view.id, title: view.title, folderName: view.folderName, body: source.value.restored }] : [];
    });
    const plan = feature.planner.plan(planTargets);
    if (!plan.ok) {
      this.deps.logger?.warn("画像アップロードの計画を作成できませんでした", { message: plan.error.message });
      return null;
    }
    return plan.value;
  }

  /** 更新対象の閲覧用Markdownを読み、meta.jsonの対応表で画像参照を元URLへ復元する */
  private readUpdateSource(view: ArticleView): Result<UpdateSource, string> {
    const folderName = view.folderName;
    if (!folderName) return err("記事フォルダが不明です。");
    const viewMdName = `${folderName.slice(0, -(view.id.length + 1))}.md`;
    const viewMdPath = join(this.deps.storageManager.root, folderName, viewMdName);
    if (!existsSync(viewMdPath)) {
      return err("本文ファイルがローカルにありません(再バックアップで復元できます)。");
    }
    let content: string;
    try {
      content = readFileSync(viewMdPath, "utf8");
    } catch (cause) {
      return err(`本文ファイルの読み込みに失敗しました: ${String(cause)}`);
    }
    const metaResult = this.deps.storageManager.readJson<ArticleMeta>(join(folderName, "meta.json"));
    const images = metaResult.ok ? metaResult.value.images : [];
    return ok({ content, restored: restoreImageRefs(content, images), images });
  }

  /** Run本体: 1件ずつ直列処理し、どの終了経路でもindex保存+Gitコミットする(7.5) */
  private async executeRun(
    runId: string,
    mode: string,
    targets: ArticleView[],
    image: ImageRunContext,
  ): Promise<RunSummary> {
    const { progressBus, stateStore, gitManager, scanner, authService, logger } = this.deps;
    const startedAt = new Date().toISOString();
    progressBus.emit({ type: "run-start", runId, mode, direction: "upload" });

    // ローカル新規の実体をRun開始時に再走査する(TOCTOU対策 — 一覧表示後の変更に備える)
    const scanResult = scanner.scan(stateStore.knownIds());
    const draftsByKey = new Map<string, LocalDraft>(
      (scanResult.ok ? scanResult.value : []).map((d) => [d.key, d]),
    );

    let succeeded = 0;
    let failed = 0;
    const failures: UploadFailure[] = [];

    // 画像フェーズは記事の処理より前に、同じRunのリース内で行う(image-upload-automation 10.1)
    const imagePhase = await this.runImagePhase(image);
    let aborted = imagePhase.stopAll;
    if (imagePhase.stopAll && !this.cancelled) {
      // 画像フェーズ全体の中止(4.4, 8.5)では記事を1件も送らない。理由を記事ごとに記録する
      for (const article of targets) {
        failures.push({ id: article.id, title: article.title, reason: imagePhase.summary?.abortMessage ?? "" });
      }
      failed = targets.length;
    }

    progressBus.emit({ type: "progress", done: 0, total: targets.length, currentTitle: "" });

    for (let i = 0; i < targets.length; i++) {
      if (this.cancelled || aborted) break; // 中断は処理中記事の完了を待って停止(7.2)
      const article = targets[i]!;
      progressBus.emit({ type: "progress", done: i, total: targets.length, currentTitle: article.title });

      const decision = imagePhase.decisions.get(article.id);
      if (decision && !decision.send) {
        // 画像が1枚でも欠けた記事は送らない(8.2)。他の記事は続ける(8.4)
        failed += 1;
        failures.push({ id: article.id, title: article.title, reason: decision.reason });
        progressBus.emit({ type: "article-done", id: article.id, title: article.title, ok: false, imageFailed: 0, reason: decision.reason });
        progressBus.emit({ type: "progress", done: i + 1, total: targets.length, currentTitle: article.title });
        continue;
      }

      const result = await this.processTarget(article, draftsByKey, decision?.send ? decision.mapping : new Map());
      if (result.ok) {
        succeeded += 1;
        authService.reportWriteResult("granted"); // 実績: 書き込み可(6.4)
        progressBus.emit({ type: "article-done", id: article.id, title: article.title, ok: true, imageFailed: 0 });
      } else {
        failed += 1;
        failures.push({ id: article.id, title: article.title, reason: result.error.reason }); // 9.4
        progressBus.emit({
          type: "article-done",
          id: article.id,
          title: article.title,
          ok: false,
          imageFailed: 0,
          reason: result.error.reason,
        });
        logger?.error("記事のアップロードに失敗しました", {
          articleId: article.id,
          reason: result.error.reason,
        });
        if (result.error.abortRun) {
          // 401/403: 残り全件を中止して原因と対処を案内する(6.3, 9.3)
          aborted = true;
          if (result.error.forbidden) authService.reportWriteResult("denied");
          progressBus.emit({
            type: "run-error",
            code: "UPLOAD_AUTH_ERROR",
            message:
              "認証エラーのためアップロードを中止しました。トークンのスコープ(read_qiita / write_qiita)を確認するか、トークンを再発行してください。",
          });
        }
      }
      progressBus.emit({ type: "progress", done: i + 1, total: targets.length, currentTitle: article.title });
    }

    // どの終了経路でも管理情報の保存とGitコミットを行う(7.5)
    const summary: RunSummary = {
      runId,
      mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      total: targets.length,
      succeeded,
      failed,
      imageFailures: [],
      cancelled: this.cancelled,
      commit: null,
      direction: "upload",
      failures,
      ...(imagePhase.summary ? { imageUpload: imagePhase.summary } : {}),
    };
    stateStore.appendHistory(summary);
    const saveResult = await stateStore.saveIndex();
    if (!saveResult.ok) {
      logger?.error("index.jsonの保存に失敗しました", { message: saveResult.error.message });
    }
    const commitResult = await gitManager.commitRun(summary);
    if (commitResult.ok && commitResult.value) {
      summary.commit = commitResult.value;
      await stateStore.saveIndex(); // 履歴にコミット情報を反映(コミット失敗はRun失敗にしない)
    }

    progressBus.emit({ type: "run-done", summary });
    logger?.info("アップロードRunが終了しました", {
      runId,
      total: summary.total,
      succeeded,
      failed,
      cancelled: summary.cancelled,
    });
    return summary;
  }

  /** 記事1件の処理: 新規=登録→正規化、更新=本文更新→原本更新。いずれも管理情報を「最新」へ(7.3, 7.4) */
  private async processTarget(
    view: ArticleView,
    draftsByKey: Map<string, LocalDraft>,
    /** 画像参照 → Qiita画像URL。送信本文だけを置換する(image-upload-automation 7.1, 7.3) */
    imageMapping: ReadonlyMap<string, string>,
  ): Promise<Result<void, ArticleError>> {
    const { qiitaClient, storageManager, stateStore } = this.deps;

    if (view.status === "localNew") {
      const draft = draftsByKey.get(view.id);
      if (!draft || draft.invalidReasons.length > 0 || !draft.title) {
        return err({
          reason: "新規記事の規約を満たしていません。一覧を再取得して内容を確認してください。",
          abortRun: false,
          forbidden: false,
        });
      }
      const input: CreateItemInput = {
        title: draft.title,
        body: rewriteImageRefs(draft.body, imageMapping),
        tags: draft.tags.map((name) => ({ name })),
        private: true, // 5.1: 常に限定共有
        tweet: false,
      };
      const created = await this.callWithRetry(() => qiitaClient.createItem(input));
      if (!created.ok) return created;

      const normalized = await storageManager.normalizeDraft(draft, created.value);
      if (!normalized.ok) {
        // Qiita側には記事が存在するため、URLを含めて手動確認を案内する(取り消しは行わない — 8.2)
        return err({
          reason: `Qiitaへは登録済み(${created.value.url})ですが、ローカルフォルダの正規化に失敗しました: ${normalized.error.message}。フォルダを手動で確認してください。`,
          abortRun: false,
          forbidden: false,
        });
      }
      stateStore.markUploaded(created.value, normalized.value, sha256(draft.body));
      return ok(undefined);
    }

    // 更新(localModified / 承認済みconflict)
    const source = this.readUpdateSource(view);
    if (!source.ok) return err({ reason: source.error, abortRun: false, forbidden: false });

    const input: UpdateItemInput = {
      title: view.title, // PATCH必須。タイトル・タグは同期対象外のため現在値を送信(3.3)
      body: rewriteImageRefs(source.value.restored, imageMapping),
      tags: view.tags,
      private: view.private, // 5.3: 現在の公開範囲を明示送信
    };
    const updated = await this.callWithRetry(() => qiitaClient.updateItem(view.id, input));
    if (!updated.ok) return updated;

    // 原本更新+meta更新(閲覧用mdはユーザ編集内容のまま保存し、ハッシュを一致させる)
    const saved = await storageManager.saveArticle(updated.value, source.value.content, source.value.images);
    if (!saved.ok) {
      return err({
        reason: `Qiita側は更新済み(${updated.value.url})ですが、ローカルへの反映に失敗しました: ${saved.error.message}。再バックアップで整合させてください。`,
        abortRun: false,
        forbidden: false,
      });
    }
    stateStore.markUploaded(updated.value, saved.value, sha256(source.value.content));
    return ok(undefined);
  }

  /**
   * 画像フェーズを実行し、記事ごとの扱いと集計を返す(image-upload-automation 5.2)
   * - 計画なし(機能無効): 何もしない(1.2)
   * - 承認なし: 再利用できる画像だけを置換し、送る必要のある画像は参照を変えない(3.4)
   * - 全体の中止(ログイン失敗・ブラウザを閉じた・中断・起動失敗・予期しないエラー): 記事を1件も送らない(4.4, 4.5, 6.6, 8.5)
   * - 画面要素の不在: 新しい画像が不要な記事だけ送る(8.1, 8.4)
   */
  private async runImagePhase(
    image: ImageRunContext,
  ): Promise<{ decisions: Map<string, ImageDecision>; stopAll: boolean; summary?: ImageUploadSummary }> {
    const decisions = new Map<string, ImageDecision>();
    const feature = this.deps.imageUpload;
    if (!image.plan || !feature) return { decisions, stopAll: false };

    if (!image.runPhase) {
      for (const article of image.plan.articles) {
        const mapping = new Map<string, string>();
        for (const entry of article.entries) {
          if (entry.status.kind === "reuse") mapping.set(entry.ref, entry.status.url);
        }
        decisions.set(article.key, { send: true, mapping });
      }
      return { decisions, stopAll: false };
    }

    // 中断の指示(cancel())を画像フェーズが区切りごとに参照できるようにする(4.5, 6.6)
    const isCancelled = (): boolean => this.cancelled;
    const cancelToken: CancelToken = {
      get cancelled() {
        return isCancelled();
      },
    };
    const result = await feature.service.run(image.plan, cancelToken);
    if (result.ok) {
      this.applyImageResults(result.value, decisions);
      return { decisions, stopAll: false, summary: imageSummary(result.value, null) };
    }

    const error = result.error;
    const partial = "partial" in error ? error.partial : null;
    const message = imageAbortMessage(error);
    const cancelledByUser = error.kind === "cancelled" || error.kind === "cancelledBeforeUpload";
    if (!cancelledByUser) {
      this.deps.progressBus.emit({ type: "run-error", code: "IMAGE_UPLOAD_ABORTED", message });
      this.deps.logger?.warn("画像アップロードを中止しました", { kind: error.kind });
    }
    const summary = { ...imageSummary(partial, error.kind), abortMessage: message };
    if (error.kind === "editorUnavailable" && partial) {
      this.applyImageResults(partial, decisions);
      return { decisions, stopAll: false, summary };
    }
    return { decisions, stopAll: true, summary };
  }

  private applyImageResults(result: ImagePhaseResult, decisions: Map<string, ImageDecision>): void {
    for (const [key, article] of result.articles) {
      decisions.set(
        key,
        article.ok
          ? { send: true, mapping: article.mapping }
          : { send: false, reason: `画像のアップロードに失敗したため記事をアップロードしていません(${article.failedRefs.join(", ")})` },
      );
    }
  }

  /** API呼び出しの共通制御: 429は待機して同一記事から再開(9.1)、network/5xxは上限付きリトライ(9.2) */
  private async callWithRetry<T>(
    call: () => Promise<Result<T, import("../types/index.js").ApiError>>,
  ): Promise<Result<T, ArticleError>> {
    let attempts = 0;
    for (;;) {
      const result = await call();
      if (result.ok) return result;
      const error = result.error;

      if (error.kind === "rateLimited") {
        const resumeAt = error.resetAt.toISOString();
        this.deps.progressBus.emit({ type: "waiting-rate-limit", resumeAt });
        this.deps.logger?.info("レート制限のため待機します(9.1)", { resumeAt });
        await delay(Math.max(0, error.resetAt.getTime() - Date.now()) + 100);
        continue; // リトライ回数を消費せず自動再開
      }
      if ((error.kind === "network" || error.kind === "server") && attempts < this.retryLimit) {
        attempts += 1;
        await delay(this.retryDelayMs);
        continue;
      }
      if (error.kind === "unauthorized" || error.kind === "forbidden") {
        const qiitaMessage =
          error.kind === "forbidden" && error.message ? `(Qiita応答: ${error.message})` : "";
        return err({
          reason:
            error.kind === "forbidden"
              ? `書き込みがQiitaに拒否されました(403)${qiitaMessage}。write_qiitaスコープの不足、またはタグ名・本文の不備の可能性があります。`
              : "認証に失敗しました(401)。トークンを確認してください。",
          abortRun: true, // 9.3: 残り全件を中止
          forbidden: error.kind === "forbidden",
        });
      }
      const reason =
        error.kind === "network"
          ? `ネットワークエラー: ${error.cause}`
          : `サーバエラー(HTTP ${error.kind === "server" ? error.status : "?"})`;
      return err({ reason: `${reason}(リトライ上限超過)`, abortRun: false, forbidden: false });
    }
  }
}

/** 実行履歴に載せる画像フェーズの集計(image-upload-automation 9.2, 10.3) */
const imageSummary = (result: ImagePhaseResult | null, aborted: ImagePhaseAbortKind | null): ImageUploadSummary => ({
  uploaded: result?.uploaded ?? 0,
  reused: result?.reused ?? 0,
  failed: result?.failed ?? [],
  workDraftUrl: result?.workDraftUrl ?? null,
  aborted,
});

/** 画像フェーズの中止理由ごとの案内文 */
const imageAbortMessage = (error: ImagePhaseError): string => {
  switch (error.kind) {
    case "browserUnavailable":
      return `画像アップロード用のブラウザを起動できませんでした(${error.message})。記事はアップロードしていません。画像のアップロードを選ばずに実行すれば、記事だけを従来どおりアップロードできます。`;
    case "loginTimeout":
      return "Qiitaへのログインが時間内に完了しなかったため、画像アップロードを中止しました。記事はアップロードしていません。もう一度実行してください。";
    case "browserClosed":
      return "ブラウザが閉じられたため、画像アップロードを中止しました。記事はアップロードしていません。";
    case "cancelledBeforeUpload":
    case "cancelled":
      return "画像アップロードを中断しました。記事はアップロードしていません。取得済みの画像URLは次回に再利用します。";
    case "editorUnavailable":
      return `Qiitaのエディタ画面で必要な要素(${error.missing})が見つからないため、画像アップロードを中止しました。Qiitaの画面が変更された可能性があります。画像はQiitaのエディタで手動でアップロードし、本文の画像URLを差し替えてください。新しい画像が不要な記事はアップロードを続けました。`;
    case "unexpected":
      return `画像アップロード中に予期しないエラーが発生したため中止しました(${error.message})。記事はアップロードしていません。`;
  }
};
