import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../src/http/app.js";
import { createApiRouter } from "../src/http/routes.js";
import { startServer } from "../src/http/server.js";
import { createFileLogger } from "../src/config/logger.js";
import { createTokenStore } from "../src/config/tokenStore.js";
import { EnvFileConfig } from "../src/config/env.js";
import { QiitaApiClientImpl } from "../src/infra/qiitaApiClient.js";
import { ImageDownloaderImpl } from "../src/infra/imageDownloader.js";
import { StorageManagerImpl } from "../src/infra/storageManager.js";
import { LocalArticleScannerImpl } from "../src/infra/localArticleScanner.js";
import { createGitManager } from "../src/infra/gitManager.js";
import { AuthServiceImpl } from "../src/services/authService.js";
import { StateStoreImpl } from "../src/services/stateStore.js";
import { BackupServiceImpl } from "../src/services/backupService.js";
import { UploadServiceImpl } from "../src/services/uploadService.js";
import { createRunCoordinator } from "../src/services/runCoordinator.js";
import { createProgressBus } from "../src/services/progressBus.js";
import { startMockQiita, makeRawItem, type MockQiitaServer } from "./helpers/mockQiitaServer.js";

describe("HTTP API(タスク4)", () => {
  let server: Server;
  let baseUrl: string;
  let mock: MockQiitaServer;
  let root: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "qbt-api-"));
    root = join(dir, "backup");
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>", "utf8");

    mock = await startMockQiita({
      items: [
        makeRawItem({ id: "a1", title: "記事1" }),
        makeRawItem({ id: "a2", title: "記事2", private: true }),
      ],
      userId: "potofo",
      validToken: "tok",
    });

    const logger = createFileLogger(join(dir, "logs"));
    const tokenStore = createTokenStore("tok");
    const envConfig = new EnvFileConfig(join(dir, ".env"));
    const qiitaClient = new QiitaApiClientImpl(tokenStore, { baseUrl: mock.url });
    const storageManager = new StorageManagerImpl(root);
    const gitManager = await createGitManager(root);
    const authService = new AuthServiceImpl(qiitaClient, tokenStore, envConfig);
    const stateStore = new StateStoreImpl(storageManager);
    await stateStore.loadIndex();
    const progressBus = createProgressBus();
    const runCoordinator = createRunCoordinator();
    const scanner = new LocalArticleScannerImpl(storageManager);
    const backupService = new BackupServiceImpl({
      qiitaClient,
      imageDownloader: new ImageDownloaderImpl({ intervalMs: 0 }),
      storageManager,
      gitManager,
      stateStore,
      progressBus,
      runCoordinator,
    });
    const uploadService = new UploadServiceImpl({
      qiitaClient,
      storageManager,
      gitManager,
      stateStore,
      progressBus,
      runCoordinator,
      scanner,
      authService,
    });

    const apiRouter = createApiRouter({
      authService,
      stateStore,
      backupService,
      uploadService,
      scanner,
      storageManager,
      gitManager,
      qiitaClient,
      progressBus,
      logger,
    });
    const app = createApp({ publicDir: dir, logger, apiRouter });
    server = await startServer(app, 0, logger);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server?.close();
    await mock.close();
  });

  it("GET /api/connection: 接続状態を返す(1.8)", async () => {
    const res = await fetch(`${baseUrl}/api/connection`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("unchecked");
  });

  it("POST /api/connection/verify: 接続確認成功でユーザID・記事数を返す", async () => {
    const res = await fetch(`${baseUrl}/api/connection/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ userId: "potofo", itemsCount: 2, savedToEnv: false });
  });

  it("POST /api/connection/verify: 無効トークンは統一エラー形式(401)", async () => {
    const res = await fetch(`${baseUrl}/api/connection/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("TOKEN_INVALID");
    expect(body.error.message).toContain("トークン");
  });

  it("GET /api/articles?refresh=true: 一覧+集計+Git可用性を返す(2.3, 5.7)", async () => {
    const res = await fetch(`${baseUrl}/api/articles?refresh=true`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.articles).toHaveLength(2);
    expect(body.articles[0].status).toBe("notBackedUp");
    expect(body.articles[0].body).toBeUndefined(); // 本文は返さない(軽量化)
    expect(body.aggregate.total).toBe(2);
    expect(body.aggregate.notBackedUp).toBe(2);
    expect(typeof body.gitAvailable).toBe("boolean");
  });

  it("POST /api/backup + SSE: Runを開始し進捗イベントを受信できる(3.9)", async () => {
    // SSE購読を開始
    const sseController = new AbortController();
    const ssePromise = (async () => {
      const res = await fetch(`${baseUrl}/api/backup/events`, { signal: sseController.signal });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const eventNames: string[] = [];
      let summaryPayload: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const m of buffer.matchAll(/event: (\S+)\ndata: (.*)\n\n/g)) {
          if (!eventNames.includes(m[1]!) || m[1] === "article-done") eventNames.push(m[1]!);
          if (m[1] === "run-done") summaryPayload = m[2]!;
        }
        if (summaryPayload) break;
      }
      sseController.abort();
      return { eventNames, summaryPayload };
    })();

    // 少し待ってからRunを開始
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(`${baseUrl}/api/backup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "diff" }),
    });
    expect(res.status).toBe(200);
    const { runId } = await res.json();
    expect(runId).toMatch(/^run-/);

    const { eventNames, summaryPayload } = await ssePromise;
    expect(eventNames).toContain("snapshot");
    expect(eventNames).toContain("run-start");
    expect(eventNames).toContain("progress");
    expect(eventNames).toContain("article-done");
    const summary = JSON.parse(summaryPayload!).summary;
    expect(summary.succeeded).toBe(2);

    // 実ファイルが保存されている
    expect(existsSync(join(root, "記事1_a1", "記事1.md"))).toBe(true);
  }, 20_000);

  it("GET /api/backup/status: スナップショットを返す(再接続回復用)", async () => {
    const res = await fetch(`${baseUrl}/api/backup/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.running).toBe(false);
    expect(body.lastSummary).not.toBeNull();
  });

  it("POST /api/backup: 不正モードは400", async () => {
    const res = await fetch(`${baseUrl}/api/backup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "bogus" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_MODE");
  });

  it("POST /api/backup/cancel: 実行中Runがなければ404", async () => {
    const res = await fetch(`${baseUrl}/api/backup/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NO_ACTIVE_RUN");
  });

  it("POST /api/articles/:id/open-folder: 未バックアップ記事は404", async () => {
    const res = await fetch(`${baseUrl}/api/articles/zzz/open-folder`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("GET /api/history: 実行履歴を返す(5.8)", async () => {
    const res = await fetch(`${baseUrl}/api/history`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history.length).toBeGreaterThanOrEqual(1);
    expect(body.history[0].succeeded).toBe(2);
    expect(body.history[0].commit).not.toBeNull();
  });

  it("GET /api/connection: 接続状態に書き込み権限種別を含む(upload-sync 6.4)", async () => {
    const res = await fetch(`${baseUrl}/api/connection`);
    const body = await res.json();
    expect(["unknown", "granted", "denied"]).toContain(body.writeAccess);
  });

  it("アップロード一連: ローカル新規の検出 → 確認なし428 → 確認付き202 → SSE完了通知(upload-sync 3.1, 4.3, 7.1)", async () => {
    // ローカル新規記事を作成
    mkdirSync(join(root, "api-draft"), { recursive: true });
    writeFileSync(
      join(root, "api-draft", "draft.md"),
      "---\ntitle: APIテスト記事\ntags: [api-test]\n---\n# 新規本文",
      "utf8",
    );

    // 一覧の再取得でローカル新規行(不備理由なし)と集計が返る(1.2, 2.7)
    const listRes = await fetch(`${baseUrl}/api/articles?refresh=true`);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    const draftRow = list.articles.find((a: { id: string }) => a.id === "local:api-draft");
    expect(draftRow).toBeDefined();
    expect(draftRow.status).toBe("localNew");
    expect(draftRow.invalidReasons).toEqual([]);
    expect(list.aggregate.localNew).toBe(1);
    expect(list.aggregate.needsUpload).toBeGreaterThanOrEqual(1);

    // SSE購読
    const sseController = new AbortController();
    const ssePromise = (async () => {
      const res = await fetch(`${baseUrl}/api/backup/events`, { signal: sseController.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const eventNames: string[] = [];
      let runStartPayload: string | null = null;
      let summaryPayload: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const m of buffer.matchAll(/event: (\S+)\ndata: (.*)\n\n/g)) {
          if (!eventNames.includes(m[1]!)) eventNames.push(m[1]!);
          if (m[1] === "run-start") runStartPayload = m[2]!;
          if (m[1] === "run-done") summaryPayload = m[2]!;
        }
        if (summaryPayload) break;
      }
      sseController.abort();
      return { eventNames, runStartPayload, summaryPayload };
    })();
    await new Promise((r) => setTimeout(r, 100));

    // 確認なし → 428 + 確認情報(4.3)
    const first = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "changes" }),
    });
    expect(first.status).toBe(428);
    const firstBody = await first.json();
    expect(firstBody.error.code).toBe("UPLOAD_CONFIRM_REQUIRED");
    expect(firstBody.info.targets).toEqual([
      { key: "local:api-draft", title: "APIテスト記事", kind: "create" },
    ]);

    // 確認付き再送 → 202(受理)
    const second = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "changes", confirmed: true }),
    });
    expect(second.status).toBe(202);
    const { runId } = await second.json();
    expect(runId).toMatch(/^run-/);

    // SSEでrun-start(direction=upload)と完了通知を受信
    const { eventNames, runStartPayload, summaryPayload } = await ssePromise;
    expect(eventNames).toContain("run-start");
    expect(eventNames).toContain("run-done");
    expect(JSON.parse(runStartPayload!).direction).toBe("upload");
    const summary = JSON.parse(summaryPayload!).summary;
    expect(summary.direction).toBe("upload");
    expect(summary.succeeded).toBe(1);

    // 正規化済みフォルダが存在し、再取得で「最新」になる
    expect(existsSync(join(root, "APIテスト記事_created0001"))).toBe(true);
    const after = await fetch(`${baseUrl}/api/articles?refresh=true`);
    const afterBody = await after.json();
    const uploaded = afterBody.articles.find((a: { id: string }) => a.id === "created0001");
    expect(uploaded.status).toBe("upToDate");
  }, 20_000);

  it("POST /api/upload: 不正モードは400", async () => {
    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/upload/cancel: 204を返す", async () => {
    const res = await fetch(`${baseUrl}/api/upload/cancel`, { method: "POST" });
    expect(res.status).toBe(204);
  });
});

// ---- 画像アップロードの設定API(image-upload-automation 5.3) ---------------------

import { ImageUploadSettingsStoreImpl } from "../src/infra/imageUploadSettingsStore.js";
import type { UploaderAvailability } from "../src/infra/browserImageUploader.js";
import type { UploadService } from "../src/services/uploadService.js";
import type { UploadStartRequest } from "../src/types/index.js";

describe("HTTP API — 画像アップロードの設定(image-upload-automation 1.4, 3.3, 5.3)", () => {
  let server: Server;
  let baseUrl: string;
  let mock: MockQiitaServer;
  let settingsDir: string;
  let availability: UploaderAvailability = { available: true };
  const received: UploadStartRequest[] = [];
  let progressBus: ReturnType<typeof createProgressBus>;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "qbt-api-img-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>", "utf8");
    settingsDir = join(dir, ".image-upload");
    mock = await startMockQiita({ items: [], validToken: "tok" });
    const logger = createFileLogger(join(dir, "logs"));
    const tokenStore = createTokenStore("tok");
    const qiitaClient = new QiitaApiClientImpl(tokenStore, { baseUrl: mock.url });
    const storageManager = new StorageManagerImpl(join(dir, "backup"));
    const gitManager = await createGitManager(join(dir, "backup"));
    const stateStore = new StateStoreImpl(storageManager);
    await stateStore.loadIndex();
    progressBus = createProgressBus();
    const runCoordinator = createRunCoordinator();
    const uploadService: UploadService = {
      start(req) {
        received.push(req);
        return { ok: false, error: { kind: "invalidRequest", message: "記録のみ" } };
      },
      cancel() {},
      updateArticleCache() {},
    };
    const apiRouter = createApiRouter({
      authService: new AuthServiceImpl(qiitaClient, tokenStore, new EnvFileConfig(join(dir, ".env"))),
      stateStore,
      backupService: new BackupServiceImpl({
        qiitaClient,
        imageDownloader: new ImageDownloaderImpl({ intervalMs: 0 }),
        storageManager,
        gitManager,
        stateStore,
        progressBus,
        runCoordinator,
      }),
      uploadService,
      scanner: new LocalArticleScannerImpl(storageManager),
      storageManager,
      gitManager,
      qiitaClient,
      progressBus,
      logger,
      imageUpload: {
        settingsStore: new ImageUploadSettingsStoreImpl(settingsDir),
        availability: () => availability,
      },
    });
    server = await startServer(createApp({ publicDir: dir, logger, apiRouter }), 0, logger);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server?.close();
    await mock.close();
  });

  const put = (body: unknown): Promise<Response> =>
    fetch(`${baseUrl}/api/image-upload/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("GET: 既定は無効で、利用可否と保存済みセッションの有無を含む", async () => {
    const res = await fetch(`${baseUrl}/api/image-upload/settings`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      schemaVersion: 1,
      enabled: false,
      consentedAt: null,
      persistSession: false,
      workDraftUrl: null,
      available: true,
      unavailableReason: null,
      hasSavedSession: false,
    });
  });

  it("PUT: 同意なしの有効化は 400 CONSENT_REQUIRED", async () => {
    const res = await put({ enabled: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("CONSENT_REQUIRED");
  });

  it("PUT: 同意付きの有効化は成功し、同意日時が記録される", async () => {
    const res = await put({ enabled: true, consent: true, persistSession: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.persistSession).toBe(true);
    expect(typeof body.consentedAt).toBe("string");
  });

  it("PUT: 実行環境が利用できない場合の有効化は 503 IMAGE_UPLOAD_UNAVAILABLE", async () => {
    availability = { available: false, reason: "playwright-core がありません" };
    try {
      const res = await put({ enabled: true, consent: true });
      expect(res.status).toBe(503);
      expect((await res.json()).error.message).toContain("playwright-core");
      const view = await (await fetch(`${baseUrl}/api/image-upload/settings`)).json();
      expect(view.available).toBe(false);
      expect(view.unavailableReason).toContain("playwright-core");
    } finally {
      availability = { available: true };
    }
  });

  it("DELETE /session: 保存済みセッションを削除し、セッション保存を無効に戻す", async () => {
    mkdirSync(join(settingsDir, "browser-profile", "Default"), { recursive: true });
    writeFileSync(join(settingsDir, "browser-profile", "Default", "Cookies"), "x", "utf8");
    const res = await fetch(`${baseUrl}/api/image-upload/session`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(existsSync(join(settingsDir, "browser-profile"))).toBe(false);
    const view = await (await fetch(`${baseUrl}/api/image-upload/settings`)).json();
    expect(view.persistSession).toBe(false);
    expect(view.hasSavedSession).toBe(false);
  });

  it("Run実行中の設定変更・セッション削除は 409 RUN_IN_PROGRESS", async () => {
    progressBus.emit({ type: "run-start", runId: "r", mode: "changes", direction: "upload" });
    try {
      expect((await put({ enabled: false })).status).toBe(409);
      expect((await fetch(`${baseUrl}/api/image-upload/session`, { method: "DELETE" })).status).toBe(409);
    } finally {
      progressBus.emit({
        type: "run-done",
        summary: { runId: "r", mode: "changes", startedAt: "", finishedAt: "", total: 0, succeeded: 0, failed: 0, imageFailures: [], cancelled: false, commit: null },
      });
    }
  });

  it("POST /api/upload: 画像アップロードの承認フラグをサービスへ渡す(3.3)", async () => {
    await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "changes", confirmed: true, uploadImages: true }),
    });
    expect(received.at(-1)).toEqual({ mode: "changes", ids: undefined, confirmed: true, uploadImages: true });
  });
});
