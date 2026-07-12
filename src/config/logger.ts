/**
 * ファイルログ基盤(10.1)
 * - 時刻・レベル・コンテキスト付きの構造化ログを logs/app.log へ追記する
 * - トークン等の秘匿情報はキー名・メッセージ内容の両面からマスクする(8.2, steering security.md)
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /** 書き込みキューの完了を待つ(テスト・終了処理用) */
  flush(): Promise<void>;
}

/** 値の代わりに出力するマスク文字列(末尾4桁のみ残す) */
const maskValue = (value: string): string =>
  value.length > 4 ? `****${value.slice(-4)}` : "****";

/** キー名が秘匿情報を示すか(token / authorization / secret 等) */
const isSecretKey = (key: string): boolean => /token|authorization|secret|password/i.test(key);

/** メッセージ中の Bearer トークンをマスクする */
const scrubMessage = (message: string): string =>
  message.replace(/Bearer\s+\S+/g, "Bearer ****");

const sanitizeContext = (context: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (isSecretKey(key)) {
      out[key] = typeof value === "string" ? maskValue(value.replace(/^Bearer\s+/i, "")) : "****";
    } else if (typeof value === "string") {
      out[key] = scrubMessage(value);
    } else {
      out[key] = value;
    }
  }
  return out;
};

export function createFileLogger(logDir: string): Logger {
  const logPath = join(logDir, "app.log");
  // 書き込みは追記キューで直列化する(行の混線防止)
  let queue: Promise<void> = Promise.resolve();

  const write = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    const time = new Date().toISOString();
    const ctx = context ? ` ${JSON.stringify(sanitizeContext(context))}` : "";
    const line = `${time} [${level.toUpperCase()}] ${scrubMessage(message)}${ctx}\n`;
    queue = queue
      .then(() => mkdir(logDir, { recursive: true }))
      .then(() => appendFile(logPath, line, "utf8"))
      .catch(() => {
        // ログ書き込み失敗で本処理を止めない(標準エラーにのみ通知)
        process.stderr.write(`[logger] ログ書き込みに失敗しました: ${logPath}\n`);
      });
  };

  return {
    debug: (m, c) => write("debug", m, c),
    info: (m, c) => write("info", m, c),
    warn: (m, c) => write("warn", m, c),
    error: (m, c) => write("error", m, c),
    flush: () => queue,
  };
}
