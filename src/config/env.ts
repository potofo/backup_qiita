/**
 * .env 読込と QIITA_ACCESS_TOKEN 行の安全な更新(1.1, 1.6, 8.1)
 * - 書き込みは QIITA_ACCESS_TOKEN 行のみ。他のキー・コメントは保持する(steering security.md)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";
import type { AppConfig, EnvWriteError, Result } from "../types/index.js";
import { ok, err } from "../types/index.js";

const TOKEN_KEY = "QIITA_ACCESS_TOKEN";

export class EnvFileConfig {
  constructor(private readonly envPath: string) {}

  /** 起動時に1回だけ呼ぶ。.env 不在・値なしは既定値で補完する(プロセス環境変数が優先) */
  load(): AppConfig {
    let parsed: Record<string, string> = {};
    if (existsSync(this.envPath)) {
      const raw = readFileSync(this.envPath, "utf8").replace(/^﻿/, "");
      parsed = dotenv.parse(raw);
    }
    const get = (key: string): string | null => process.env[key] || parsed[key] || null;
    const port = Number(get("SERVER_PORT") ?? "");
    return {
      tokenFromEnv: get(TOKEN_KEY),
      backupDir: get("BACKUP_DIR") ?? "backups",
      serverPort: Number.isInteger(port) && port > 0 ? port : 3000,
      // テスト・開発用: Qiita APIのベースURLを差し替える(通常は未設定)
      apiBaseUrl: get("QIITA_API_BASE_URL"),
    };
  }

  /**
   * トークン行のみを置換/追記する(1.6 — ユーザ同意時のみ呼ばれる)
   * ファイル未存在時は新規作成。BOMなしUTF-8で書き込む。
   */
  persistToken(token: string): Result<void, EnvWriteError> {
    try {
      const tokenLine = `${TOKEN_KEY}=${token}`;
      if (!existsSync(this.envPath)) {
        writeFileSync(this.envPath, `${tokenLine}\n`, "utf8");
        return ok(undefined);
      }
      const raw = readFileSync(this.envPath, "utf8").replace(/^﻿/, "");
      const lines = raw.split(/\r?\n/);
      const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${TOKEN_KEY}\\s*=`);
      let replaced = false;
      const updated = lines.map((line) => {
        if (!replaced && keyPattern.test(line)) {
          replaced = true;
          return tokenLine;
        }
        return line;
      });
      if (!replaced) {
        // 末尾の空行の手前に追記する
        while (updated.length > 0 && updated[updated.length - 1] === "") updated.pop();
        updated.push(tokenLine);
      }
      let content = updated.join("\n");
      if (!content.endsWith("\n")) content += "\n";
      writeFileSync(this.envPath, content, "utf8");
      return ok(undefined);
    } catch (cause) {
      return err({ kind: "io", message: `.envの更新に失敗しました: ${String(cause)}` });
    }
  }
}
