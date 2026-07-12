import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../src/http/app.js";
import { startServer } from "../src/http/server.js";
import { createFileLogger } from "../src/config/logger.js";

describe("ローカルサーバ骨格(7.1, 8.3, 10.3)", () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "qbt-srv-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Qiita Backup Tool</title>", "utf8");
    const logger = createFileLogger(join(dir, "logs"));
    const app = createApp({ publicDir: dir, logger });
    server = await startServer(app, 0, logger); // port 0 = 空きポート
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it("ループバックアドレスのみで待ち受ける(8.3)", () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    expect(address.address).toBe("127.0.0.1");
  });

  it("トップページ(静的アセット)を配信する(7.1)", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Qiita Backup Tool");
  });

  it("ヘルスチェックAPIが応答する", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
