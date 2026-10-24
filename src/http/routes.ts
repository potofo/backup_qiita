/**
 * HTTP API ルーティング(タスク4 / article-upload-sync 3.1, 4.3, 6.4, 7.1, 8.1)
 * - 設計書のAPIコントラクト表(design.md)どおりのREST+SSEを提供する
 * - Qiitaへの書き込みは POST /api/upload への明示的リクエスト経由に限定する(8.1)
 * - エラーは統一形式 { error: { code, message } }(日本語メッセージ)へ変換する
 * - 画像アップロード機能の設定API(image-upload-automation 1.4, 5.3)。Run実行中の変更は拒否する
 */
import { Router, type Request, type Response } from "express";
import type {
  ArticleView,
  ImageUploadSettingsPatch,
  ImageUploadSettingsView,
  RunMode,
  UploadStartRequest,
} from "../types/index.js";
import type { ImageUploadSettingsStore } from "../infra/imageUploadSettingsStore.js";
import type { UploaderAvailability } from "../infra/browserImageUploader.js";
import type { AuthService } from "../services/authService.js";
import type { StateStore } from "../services/stateStore.js";
import { summarize } from "../services/stateStore.js";
import type { BackupService } from "../services/backupService.js";
import type { UploadService } from "../services/uploadService.js";
import type { StorageManager } from "../infra/storageManager.js";
import type { LocalArticleScanner } from "../infra/localArticleScanner.js";
import type { GitManager } from "../infra/gitManager.js";
import type { QiitaApiClient } from "../infra/qiitaApiClient.js";
import type { ProgressBus } from "../services/progressBus.js";
import type { Logger } from "../config/logger.js";

export type ApiDeps = {
  authService: AuthService;
  stateStore: StateStore;
  backupService: BackupService;
  uploadService: UploadService;
  scanner: LocalArticleScanner;
  storageManager: StorageManager;
  gitManager: GitManager;
  qiitaClient: QiitaApiClient;
  progressBus: ProgressBus;
  logger?: Logger;
  /** 画像アップロード機能(未指定なら設定APIは「利用不可」を返す) */
  imageUpload?: {
    settingsStore: ImageUploadSettingsStore;
    /** 起動時に確かめた実行環境の利用可否(1.3) */
    availability(): UploaderAvailability;
  };
};

const sendError = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ error: { code, message } });
};

/** レスポンスからbody(本文)を除いた軽量ビューを作る */
const toListItem = (view: ArticleView): Omit<ArticleView, "body"> => {
  const { body: _body, ...rest } = view;
  return rest;
};

export function createApiRouter(deps: ApiDeps): Router {
  const router = Router();
  // 一覧のキャッシュ(refresh=trueまたは初回のみQiitaへアクセスする)
  let cachedViews: ArticleView[] | null = null;

  // ---- 接続確認(1.2〜1.8) ----------------------------------------------

  router.get("/connection", (_req, res) => {
    res.json(deps.authService.status());
  });

  router.post("/connection/verify", async (req, res) => {
    const { token, save } = (req.body ?? {}) as { token?: string; save?: boolean };
    const result = await deps.authService.verify({ token, save });
    if (result.ok) {
      res.json(result.value);
      return;
    }
    switch (result.error.kind) {
      case "missing":
        sendError(res, 401, "TOKEN_MISSING", "アクセストークンが設定されていません。トークンを入力してください。");
        return;
      case "unauthorized":
        sendError(res, 401, "TOKEN_INVALID", "アクセストークンが無効です。トークンを確認するか再発行してください。");
        return;
      case "forbidden":
        sendError(res, 403, "TOKEN_FORBIDDEN", "アクセス権限が不足しています。read_qiitaスコープ付きのトークンを発行してください。");
        return;
      default:
        sendError(res, 502, "QIITA_UNREACHABLE", "Qiitaへの接続に失敗しました。ネットワークを確認してください。");
        return;
    }
  });

  // ---- 記事一覧(2.1〜2.5) ------------------------------------------------

  router.get("/articles", async (req, res) => {
    const refresh = req.query["refresh"] === "true";
    if (refresh || cachedViews === null) {
      const result = await deps.qiitaClient.fetchAllItems();
      if (!result.ok) {
        switch (result.error.kind) {
          case "unauthorized":
          case "forbidden":
            sendError(res, 401, "TOKEN_INVALID", "認証に失敗しました。接続確認画面でトークンを確認してください。");
            return;
          case "rateLimited":
            sendError(res, 429, "RATE_LIMITED", `レート制限中です。${result.error.resetAt.toLocaleString("ja-JP")} 以降に再試行してください。`);
            return;
          default:
            sendError(res, 502, "QIITA_UNREACHABLE", "Qiitaから記事一覧を取得できませんでした。");
            return;
        }
      }
      // ローカル新規記事の走査結果を合流させる(upload-sync 1.1, 1.2)
      const scanResult = deps.scanner.scan(deps.stateStore.knownIds());
      if (!scanResult.ok) {
        deps.logger?.warn("ローカル新規記事の走査に失敗しました", { message: scanResult.error.message });
      }
      cachedViews = deps.stateStore.classify(result.value, scanResult.ok ? scanResult.value : []);
      deps.backupService.updateArticleCache(cachedViews);
      deps.uploadService.updateArticleCache(cachedViews);
    }
    res.json({
      articles: cachedViews.map(toListItem),
      aggregate: summarize(cachedViews),
      gitAvailable: deps.gitManager.available,
    });
  });

  router.post("/articles/:id/open-folder", (req, res) => {
    const result = deps.storageManager.openFolder(req.params.id);
    if (!result.ok) {
      sendError(res, 404, "FOLDER_NOT_FOUND", "記事フォルダが見つかりません。先にバックアップを実行してください。");
      return;
    }
    res.status(204).end();
  });

  // ---- バックアップ実行(3.1〜3.12) ---------------------------------------

  router.post("/backup", (req, res) => {
    const { mode, ids, confirmOverwrite } = (req.body ?? {}) as {
      mode?: RunMode;
      ids?: string[];
      confirmOverwrite?: boolean;
    };
    if (mode !== "all" && mode !== "diff" && mode !== "selected") {
      sendError(res, 400, "INVALID_MODE", "モードは all / diff / selected のいずれかを指定してください。");
      return;
    }
    const result = deps.backupService.start({ mode, ids, confirmOverwrite });
    if (!result.ok) {
      switch (result.error.kind) {
        case "conflict":
          sendError(res, 409, "RUN_IN_PROGRESS", "バックアップが実行中です。完了または中断してから再実行してください。");
          return;
        case "needsOverwriteConfirm":
          res.status(400).json({
            error: {
              code: "OVERWRITE_CONFIRM_REQUIRED",
              message: "ローカル変更のある記事が含まれています。上書きしてよいか確認してください。",
            },
            articleIds: result.error.articleIds,
          });
          return;
        case "invalidRequest":
          sendError(res, 400, "INVALID_REQUEST", result.error.message);
          return;
      }
    }
    // Run完了時に一覧キャッシュを無効化する(次回GETで再分類)
    result.value.done.then(() => {
      cachedViews = null;
    });
    res.json({ runId: result.value.runId });
  });

  // ---- アップロード実行(upload-sync 3.1, 4.3, 8.1) -------------------------
  // 書き込みはこの明示的操作経由に限定する(自動同期の導線を設けない)

  router.post("/upload", (req, res) => {
    const { mode, ids, confirmed, uploadImages } = (req.body ?? {}) as UploadStartRequest;
    if (mode !== "changes" && mode !== "selected") {
      sendError(res, 400, "INVALID_MODE", "モードは changes / selected のいずれかを指定してください。");
      return;
    }
    const result = deps.uploadService.start({ mode, ids, confirmed, uploadImages: uploadImages === true });
    if (!result.ok) {
      switch (result.error.kind) {
        case "conflict": {
          const kindLabel = result.error.active === "upload" ? "アップロード" : "バックアップ";
          sendError(res, 409, "RUN_IN_PROGRESS", `${kindLabel}が実行中です。完了または中断してから再実行してください。`);
          return;
        }
        case "writeAccessDenied":
          sendError(
            res,
            403,
            "WRITE_ACCESS_DENIED",
            "トークンに書き込み権限(write_qiita)がありません。read_qiita / write_qiita スコープ付きのトークンを発行してください。",
          );
          return;
        case "needsUploadConfirm":
          // 428: 実行前確認が必要(確認情報を返す — 4.3)
          res.status(428).json({
            error: {
              code: "UPLOAD_CONFIRM_REQUIRED",
              message: "アップロード内容の確認が必要です。対象を確認のうえ confirmed: true で再送してください。",
            },
            info: result.error.info,
          });
          return;
        case "invalidTargets":
          res.status(400).json({
            error: {
              code: "INVALID_TARGETS",
              message: "アップロードできない記事が含まれています。",
            },
            details: result.error.details,
          });
          return;
        case "invalidRequest":
          sendError(res, 400, "INVALID_REQUEST", result.error.message);
          return;
      }
    }
    // Run完了時に一覧キャッシュを無効化する(次回GETで再分類)
    result.value.done.then(() => {
      cachedViews = null;
    });
    res.status(202).json({ runId: result.value.runId });
  });

  router.post("/upload/cancel", (_req, res) => {
    deps.uploadService.cancel();
    res.status(204).end();
  });

  router.post("/backup/cancel", (_req, res) => {
    if (!deps.progressBus.snapshot().running) {
      sendError(res, 404, "NO_ACTIVE_RUN", "実行中のバックアップはありません。");
      return;
    }
    deps.backupService.cancel();
    res.status(202).json({ accepted: true });
  });

  router.get("/backup/status", (_req, res) => {
    res.json(deps.progressBus.snapshot());
  });

  // SSEストリーム(3.9)。再接続時は /api/backup/status のスナップショットで回復する
  router.get("/backup/events", (req: Request, res: Response) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // 接続直後に現在のスナップショットを送る
    send("snapshot", deps.progressBus.snapshot());
    const unsubscribe = deps.progressBus.subscribe((event) => {
      send(event.type, event);
    });
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---- 画像アップロードの設定(image-upload-automation 1.4, 5.3) ------------------

  const settingsView = (): ImageUploadSettingsView | null => {
    const feature = deps.imageUpload;
    if (!feature) return null;
    const availability = feature.availability();
    return {
      ...feature.settingsStore.get(),
      available: availability.available,
      unavailableReason: availability.available ? null : availability.reason,
      hasSavedSession: feature.settingsStore.hasSavedSession(),
    };
  };

  router.get("/image-upload/settings", (_req, res) => {
    const view = settingsView();
    if (!view) {
      sendError(res, 503, "IMAGE_UPLOAD_UNAVAILABLE", "画像アップロード機能は組み込まれていません。");
      return;
    }
    res.json(view);
  });

  router.put("/image-upload/settings", (req, res) => {
    const feature = deps.imageUpload;
    if (!feature) {
      sendError(res, 503, "IMAGE_UPLOAD_UNAVAILABLE", "画像アップロード機能は組み込まれていません。");
      return;
    }
    if (deps.progressBus.snapshot().running) {
      sendError(res, 409, "RUN_IN_PROGRESS", "実行中は画像アップロードの設定を変更できません。完了または中断してから操作してください。");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: ImageUploadSettingsPatch = {};
    if (typeof body["enabled"] === "boolean") patch.enabled = body["enabled"];
    if (body["consent"] === true) patch.consent = true;
    if (typeof body["persistSession"] === "boolean") patch.persistSession = body["persistSession"];

    const availability = feature.availability();
    if (patch.enabled === true && !availability.available) {
      sendError(res, 503, "IMAGE_UPLOAD_UNAVAILABLE", `画像アップロード機能を利用できません: ${availability.reason}`);
      return;
    }
    const updated = feature.settingsStore.update(patch);
    if (!updated.ok) {
      if (updated.error.kind === "consentRequired") {
        sendError(res, 400, "CONSENT_REQUIRED", "画像アップロード機能を有効にするには、注意事項への同意が必要です。");
      } else {
        sendError(res, 500, "SETTINGS_WRITE_FAILED", "画像アップロードの設定を保存できませんでした。");
      }
      return;
    }
    res.json(settingsView());
  });

  router.delete("/image-upload/session", (_req, res) => {
    const feature = deps.imageUpload;
    if (!feature) {
      sendError(res, 503, "IMAGE_UPLOAD_UNAVAILABLE", "画像アップロード機能は組み込まれていません。");
      return;
    }
    if (deps.progressBus.snapshot().running) {
      sendError(res, 409, "RUN_IN_PROGRESS", "実行中は保存済みのログイン状態を削除できません。完了または中断してから操作してください。");
      return;
    }
    const cleared = feature.settingsStore.clearSession();
    if (!cleared.ok) {
      sendError(res, 500, "SESSION_CLEAR_FAILED", "保存済みのログイン状態を削除できませんでした。ブラウザを閉じてから再度お試しください。");
      return;
    }
    res.status(204).end();
  });

  // ---- 実行履歴(5.8) -----------------------------------------------------

  router.get("/history", (_req, res) => {
    res.json({
      history: deps.stateStore.getHistory(),
      gitAvailable: deps.gitManager.available,
    });
  });

  return router;
}
