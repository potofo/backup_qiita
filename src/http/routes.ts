/**
 * HTTP API ルーティング(タスク4)
 * - 設計書のAPIコントラクト表(design.md)どおりのREST+SSEを提供する
 * - エラーは統一形式 { error: { code, message } }(日本語メッセージ)へ変換する
 */
import { Router, type Request, type Response } from "express";
import type { ArticleView, RunMode } from "../types/index.js";
import type { AuthService } from "../services/authService.js";
import type { StateStore } from "../services/stateStore.js";
import { summarize } from "../services/stateStore.js";
import type { BackupService } from "../services/backupService.js";
import type { StorageManager } from "../infra/storageManager.js";
import type { GitManager } from "../infra/gitManager.js";
import type { QiitaApiClient } from "../infra/qiitaApiClient.js";
import type { ProgressBus } from "../services/progressBus.js";
import type { Logger } from "../config/logger.js";

export type ApiDeps = {
  authService: AuthService;
  stateStore: StateStore;
  backupService: BackupService;
  storageManager: StorageManager;
  gitManager: GitManager;
  qiitaClient: QiitaApiClient;
  progressBus: ProgressBus;
  logger?: Logger;
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
      cachedViews = deps.stateStore.classify(result.value);
      deps.backupService.updateArticleCache(cachedViews);
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

  // ---- 実行履歴(5.8) -----------------------------------------------------

  router.get("/history", (_req, res) => {
    res.json({
      history: deps.stateStore.getHistory(),
      gitAvailable: deps.gitManager.available,
    });
  });

  return router;
}
