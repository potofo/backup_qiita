import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileLogger } from "../src/config/logger.js";

describe("createFileLogger", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qbt-log-"));
  });

  it("ログディレクトリとapp.logを自動作成し、時刻・レベル・コンテキスト付きで出力する", async () => {
    const logDir = join(dir, "logs");
    const logger = createFileLogger(logDir);
    logger.info("サーバを起動しました", { port: 3000 });
    await logger.flush();

    const logPath = join(logDir, "app.log");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO時刻
    expect(content).toContain("[INFO]");
    expect(content).toContain("サーバを起動しました");
    expect(content).toContain('"port":3000');
  });

  it("エラーレベルを区別して出力する", async () => {
    const logger = createFileLogger(dir);
    logger.error("失敗しました", { articleId: "abc123" });
    await logger.flush();
    const content = readFileSync(join(dir, "app.log"), "utf8");
    expect(content).toContain("[ERROR]");
    expect(content).toContain("abc123");
  });

  it("トークン・Authorizationヘッダに相当するコンテキストキーをマスクする(8.2)", async () => {
    const logger = createFileLogger(dir);
    logger.info("接続確認", {
      token: "secret-token-1234abcd",
      authorization: "Bearer secret-token-1234abcd",
      accessToken: "secret-token-1234abcd",
    });
    await logger.flush();
    const content = readFileSync(join(dir, "app.log"), "utf8");
    expect(content).not.toContain("secret-token-1234abcd");
    expect(content).toContain("****");
  });

  it("メッセージ中のBearerトークンをマスクする(8.2)", async () => {
    const logger = createFileLogger(dir);
    logger.warn("リクエスト失敗: Authorization: Bearer secret-token-1234abcd を送信");
    await logger.flush();
    const content = readFileSync(join(dir, "app.log"), "utf8");
    expect(content).not.toContain("secret-token-1234abcd");
  });
});
