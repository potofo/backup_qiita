import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvFileConfig } from "../src/config/env.js";
import { createTokenStore } from "../src/config/tokenStore.js";

describe("EnvFileConfig.load", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qbt-env-"));
  });

  it(".envからトークン・バックアップ先・ポートを読み込む(1.1)", () => {
    const envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      "QIITA_ACCESS_TOKEN=tok_abcdef1234\nBACKUP_DIR=D:/mybackup\nSERVER_PORT=4321\n",
      "utf8",
    );
    const config = new EnvFileConfig(envPath).load();
    expect(config.tokenFromEnv).toBe("tok_abcdef1234");
    expect(config.backupDir).toBe("D:/mybackup");
    expect(config.serverPort).toBe(4321);
  });

  it(".envが存在しない場合は既定値を返す(トークンはnull)", () => {
    const config = new EnvFileConfig(join(dir, ".env")).load();
    expect(config.tokenFromEnv).toBeNull();
    expect(config.backupDir).toBe("backups");
    expect(config.serverPort).toBe(3000);
  });

  it("値が空のキーは未設定として扱う", () => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "QIITA_ACCESS_TOKEN=\nBACKUP_DIR=\nSERVER_PORT=\n", "utf8");
    const config = new EnvFileConfig(envPath).load();
    expect(config.tokenFromEnv).toBeNull();
    expect(config.backupDir).toBe("backups");
    expect(config.serverPort).toBe(3000);
  });
});

describe("EnvFileConfig.persistToken(1.6 同意時のみ呼ばれる)", () => {
  let dir: string;
  let envPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qbt-env-"));
    envPath = join(dir, ".env");
  });

  it("既存キー・コメントを保持したままQIITA_ACCESS_TOKEN行のみを置換する", () => {
    writeFileSync(
      envPath,
      "# 設定ファイル\nBACKUP_DIR=D:/mybackup\nQIITA_ACCESS_TOKEN=old_token\n# 末尾コメント\nSERVER_PORT=4321\n",
      "utf8",
    );
    const result = new EnvFileConfig(envPath).persistToken("new_token_5678");
    expect(result.ok).toBe(true);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("QIITA_ACCESS_TOKEN=new_token_5678");
    expect(content).not.toContain("old_token");
    expect(content).toContain("# 設定ファイル");
    expect(content).toContain("BACKUP_DIR=D:/mybackup");
    expect(content).toContain("# 末尾コメント");
    expect(content).toContain("SERVER_PORT=4321");
    // 行の順序が保持されている(BACKUP_DIRがトークン行より前)
    expect(content.indexOf("BACKUP_DIR")).toBeLessThan(content.indexOf("QIITA_ACCESS_TOKEN"));
  });

  it("キーが存在しない場合は末尾に追記する", () => {
    writeFileSync(envPath, "BACKUP_DIR=D:/mybackup\n", "utf8");
    new EnvFileConfig(envPath).persistToken("tok_new");
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("BACKUP_DIR=D:/mybackup");
    expect(content).toContain("QIITA_ACCESS_TOKEN=tok_new");
  });

  it(".envが存在しない場合は新規作成する", () => {
    expect(existsSync(envPath)).toBe(false);
    new EnvFileConfig(envPath).persistToken("tok_new");
    expect(readFileSync(envPath, "utf8")).toContain("QIITA_ACCESS_TOKEN=tok_new");
  });

  it("BOMなしUTF-8で書き込む", () => {
    new EnvFileConfig(envPath).persistToken("tok_new");
    const bytes = readFileSync(envPath);
    expect(bytes[0]).not.toBe(0xef); // BOMなし
  });
});

describe("TokenStore(トークンのメモリ一元保持 — 8.1)", () => {
  it("set/getでメモリ上に保持する", () => {
    const store = createTokenStore();
    expect(store.get()).toBeNull();
    store.set("tok_abcdef8d5a");
    expect(store.get()).toBe("tok_abcdef8d5a");
  });

  it("maskedTailは末尾4桁のみを返す(8.2)", () => {
    const store = createTokenStore();
    expect(store.maskedTail()).toBeNull();
    store.set("tok_abcdef8d5a");
    expect(store.maskedTail()).toBe("****8d5a");
  });

  it("短いトークンでも全文を露出しない", () => {
    const store = createTokenStore();
    store.set("ab");
    expect(store.maskedTail()).not.toContain("ab");
  });
});
