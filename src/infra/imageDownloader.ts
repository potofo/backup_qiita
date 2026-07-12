/**
 * 画像ダウンローダ(3.5, 3.8, 4.4, 8.5)
 * - QiitaApiClientとHTTPクライアントを共有せず、Authorizationヘッダを一切付けない(8.5)
 * - 直列ダウンロード+間隔(既定300ms — サーバ負荷配慮、steering qiita-api.md)
 * - 失敗は記録して継続する(3.8)
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ImageResult } from "../types/index.js";
import type { Logger } from "../config/logger.js";

export interface ImageDownloader {
  extractImageUrls(markdown: string): string[];
  downloadAll(urls: string[], destDir: string): Promise<ImageResult[]>;
}

/** Content-Type → 拡張子(拡張子はURLではなくContent-Typeから決定する — 4.4) */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "image/x-icon": ".ico",
};

/** Windowsパス長制限(260文字)を考慮したファイル名部分の上限 */
const MAX_BASENAME_LENGTH = 40;

type DownloaderOptions = {
  intervalMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
};

/** URL末尾のパスセグメントから「ファイル名相当」を得る。なければnull */
const originalFileName = (url: string): string | null => {
  try {
    const pathname = new URL(url).pathname;
    const segment = posix.basename(pathname);
    // 拡張子を持たないセグメント(Camo等のプロキシURLのハッシュ)はファイル名相当とみなさない
    if (!segment || !/\.[A-Za-z0-9]{1,5}$/.test(segment)) return null;
    const base = segment.replace(/\.[A-Za-z0-9]{1,5}$/, "");
    // Windowsで使用できない文字を除去し、過度に長い名前は切り詰める
    const sanitized = base.replace(/[\\/:*?"<>|\s]/g, "_").slice(0, MAX_BASENAME_LENGTH);
    return sanitized || null;
  } catch {
    return null;
  }
};

export class ImageDownloaderImpl implements ImageDownloader {
  private readonly intervalMs: number;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DownloaderOptions = {}) {
    this.intervalMs = options.intervalMs ?? 300;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  extractImageUrls(markdown: string): string[] {
    const urls: string[] = [];
    const seen = new Set<string>();
    const add = (url: string): void => {
      if (!/^https?:\/\//.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      urls.push(url);
    };

    // Markdown記法: ![alt](url) / ![alt](url "title")
    for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*(\S+?)(?:\s+"[^"]*")?\s*\)/g)) {
      if (m[1]) add(m[1]);
    }
    // imgタグ: <img src="url">
    for (const m of markdown.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      if (m[1]) add(m[1]);
    }
    return urls;
  }

  async downloadAll(urls: string[], destDir: string): Promise<ImageResult[]> {
    const results: ImageResult[] = [];
    if (urls.length === 0) return results;
    await mkdir(destDir, { recursive: true });

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;
      if (i > 0 && this.intervalMs > 0) await delay(this.intervalMs);
      results.push(await this.downloadOne(url, i + 1, destDir));
    }
    return results;
  }

  /** 1画像の取得。認証ヘッダは付けない(8.5)。失敗はImageResultで返し例外にしない(3.8) */
  private async downloadOne(url: string, seq: number, destDir: string): Promise<ImageResult> {
    try {
      // 独立したfetch呼び出し(ヘッダ指定なし) — Authorizationが漏れる経路を持たない
      const res = await this.fetchImpl(url, { redirect: "follow" });
      if (!res.ok) {
        this.logger?.warn("画像の取得に失敗しました", { url, status: res.status });
        return { url, ok: false, reason: `HTTP ${res.status}` };
      }
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      const ext = EXT_BY_CONTENT_TYPE[contentType] ?? ".bin";
      const original = originalFileName(url);
      const seqStr = String(seq).padStart(3, "0");
      const fileName = original ? `${seqStr}_${original}${ext}` : `${seqStr}${ext}`;
      const bytes = Buffer.from(await res.arrayBuffer());
      await writeFile(join(destDir, fileName), bytes);
      return { url, ok: true, fileName };
    } catch (cause) {
      this.logger?.warn("画像の取得に失敗しました", { url, cause: String(cause) });
      return { url, ok: false, reason: String(cause) };
    }
  }
}
