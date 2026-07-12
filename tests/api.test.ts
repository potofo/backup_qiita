import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
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
import { createGitManager } from "../src/infra/gitManager.js";
import { AuthServiceImpl } from "../src/services/authService.js";
import { StateStoreImpl } from "../src/services/stateStore.js";
import { BackupServiceImpl } from "../src/services/backupService.js";
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
    const backupService = new BackupServiceImpl({
      qiitaClient,
      imageDownloader: new ImageDownloaderImpl({ intervalMs: 0 }),
      storageManager,
      gitManager,
      stateStore,
      progressBus,
    });

    const apiRouter = createApiRouter({
      authService,
      stateStore,
      backupService,
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
});
