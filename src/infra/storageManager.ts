/**
 * 記事ストレージ管理(2.3)
 * - 記事フォルダの物理レイアウト管理(4.1〜4.6)とアトミック書込(9.3)
 * - バックアップ先外への書き込み拒否(パストラバーサル防止、steering security.md)
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { join, resolve, sep, parse as parsePath } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type {
  ArticleMeta,
  ArticlePaths,
  ImageResult,
  QiitaItem,
  Result,
  StorageError,
} from "../types/index.js";
import { ok, err } from "../types/index.js";
import type { Logger } from "../config/logger.js";

/** サニタイズ済みタイトルの最大長(4.2) */
const MAX_TITLE_LENGTH = 50;

/** OSで使用できない文字・制御文字を _ に置換し、最大50文字に切り詰める(4.2) */
export function sanitizeTitle(title: string): string {
  const sanitized = title
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f]/g, "_")
    .slice(0, MAX_TITLE_LENGTH)
    // Windowsはフォルダ名末尾のドット・空白を許容しない
    .replace(/[. ]+$/, "");
  return sanitized || "untitled";
}

/** 記事フォルダ名: {サニタイズ済タイトル}_{記事ID}(4.2) */
export function articleFolderName(title: string, articleId: string): string {
  return `${sanitizeTitle(title)}_${articleId}`;
}

/** システムディレクトリ等、バックアップ先として不適切なパスを拒否する(steering security.md) */
const assertSafeRoot = (root: string): void => {
  const normalized = resolve(root).toLowerCase().replace(/\//g, "\\");
  const { root: driveRoot } = parsePath(normalized);
  if (normalized === driveRoot.toLowerCase().replace(/\//g, "\\")) {
    throw new Error(`バックアップ先にドライブ直下は指定できません: ${root}`);
  }
  const forbiddenPrefixes = [
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
    "c:\\programdata",
    "\\etc",
    "\\usr",
    "\\bin",
    "\\sbin",
  ];
  if (forbiddenPrefixes.some((p) => normalized === p || normalized.startsWith(`${p}\\`))) {
    throw new Error(`バックアップ先にシステムディレクトリは指定できません: ${root}`);
  }
};

export interface StorageManager {
  /**
   * 記事フォルダを保存可能な状態に整える(ルート自動作成・タイトル変更時のリネーム・imagesフォルダ作成)。
   * 画像ダウンロード前に呼ぶことで、リネームとダウンロード先の不整合を防ぐ。
   */
  prepareArticleDir(article: QiitaItem): Promise<Result<string, StorageError>>;
  saveArticle(
    article: QiitaItem,
    rewrittenMd: string,
    images: ImageResult[],
  ): Promise<Result<ArticlePaths, StorageError>>;
  writeJsonAtomic<T>(relPath: string, data: T): Promise<Result<void, StorageError>>;
  readJson<T>(relPath: string): Result<T, StorageError>;
  openFolder(articleId: string): Result<void, StorageError>;
  findFolderById(articleId: string): string | null;
  /** 記事の画像保存先(imagesサブフォルダ)の絶対パスを返す */
  imagesDirFor(article: QiitaItem): string;
  readonly root: string;
}

export class StorageManagerImpl implements StorageManager {
  readonly root: string;

  constructor(
    root: string,
    private readonly logger?: Logger,
  ) {
    assertSafeRoot(root);
    this.root = resolve(root);
  }

  /** ルート配下の絶対パスへ解決する。外側を指す場合はエラー(パストラバーサル防止) */
  private resolveInsideRoot(relPath: string): Result<string, StorageError> {
    const abs = resolve(this.root, relPath);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      return err({
        kind: "forbiddenPath",
        message: `バックアップ先の外側への書き込みは拒否されました: ${relPath}`,
      });
    }
    return ok(abs);
  }

  findFolderById(articleId: string): string | null {
    if (!existsSync(this.root)) return null;
    const suffix = `_${articleId}`;
    const entry = readdirSync(this.root, { withFileTypes: true }).find(
      (e) => e.isDirectory() && e.name.endsWith(suffix),
    );
    return entry?.name ?? null;
  }

  imagesDirFor(article: QiitaItem): string {
    return join(this.root, articleFolderName(article.title, article.id), "images");
  }

  async prepareArticleDir(article: QiitaItem): Promise<Result<string, StorageError>> {
    try {
      await mkdir(this.root, { recursive: true }); // 4.1 自動作成
      const folderName = articleFolderName(article.title, article.id);
      const existing = this.findFolderById(article.id);

      // 記事IDが一致しフォルダ名が変わる場合はリネーム(4.6)
      if (existing && existing !== folderName) {
        renameSync(join(this.root, existing), join(this.root, folderName));
        // 旧タイトルの閲覧用Markdownを残さない(新タイトル名で書き直すため)
        const oldViewMd = join(this.root, folderName, `${existing.slice(0, -(article.id.length + 1))}.md`);
        try {
          unlinkSync(oldViewMd);
        } catch {
          // 旧閲覧用Markdownが存在しない場合は何もしない
        }
        this.logger?.info("記事フォルダをリネームしました", {
          articleId: article.id,
          from: existing,
          to: folderName,
        });
      }

      const dir = join(this.root, folderName);
      mkdirSync(join(dir, "images"), { recursive: true });
      return ok(dir);
    } catch (cause) {
      this.logger?.error("記事フォルダの準備に失敗しました", {
        articleId: article.id,
        cause: String(cause),
      });
      return err({ kind: "io", message: `記事フォルダの準備に失敗しました: ${String(cause)}` });
    }
  }

  async saveArticle(
    article: QiitaItem,
    rewrittenMd: string,
    images: ImageResult[],
  ): Promise<Result<ArticlePaths, StorageError>> {
    try {
      const prepared = await this.prepareArticleDir(article);
      if (!prepared.ok) return prepared;
      const folderName = articleFolderName(article.title, article.id);
      const dir = prepared.value;
      const sanitized = sanitizeTitle(article.title);

      const paths: ArticlePaths = {
        dir,
        viewMd: join(dir, `${sanitized}.md`),
        originalMd: join(dir, "original.md"),
        metaJson: join(dir, "meta.json"),
      };

      await writeFile(paths.viewMd, rewrittenMd, "utf8");
      await writeFile(paths.originalMd, article.body, "utf8");

      const meta: ArticleMeta = {
        schemaVersion: 1,
        id: article.id,
        title: article.title,
        url: article.url,
        private: article.private,
        tags: article.tags.map((t) => t.name),
        createdAt: article.createdAt,
        updatedAt: article.updatedAt,
        commentsCount: article.commentsCount,
        likesCount: article.likesCount,
        stocksCount: article.stocksCount,
        backedUpAt: new Date().toISOString(),
        images,
      };
      const metaResult = await this.writeJsonAtomic(join(folderName, "meta.json"), meta);
      if (!metaResult.ok) return metaResult;

      return ok(paths);
    } catch (cause) {
      this.logger?.error("記事の保存に失敗しました", { articleId: article.id, cause: String(cause) });
      return err({ kind: "io", message: `記事の保存に失敗しました: ${String(cause)}` });
    }
  }

  /** write-then-rename によるアトミック書込(9.3) */
  async writeJsonAtomic<T>(relPath: string, data: T): Promise<Result<void, StorageError>> {
    const resolved = this.resolveInsideRoot(relPath);
    if (!resolved.ok) return resolved;
    const target = resolved.value;
    const tmpPath = `${target}.tmp-${randomBytes(4).toString("hex")}`;
    try {
      const json = JSON.stringify(data, null, 2);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(tmpPath, json, "utf8");
      await rename(tmpPath, target);
      return ok(undefined);
    } catch (cause) {
      await unlink(tmpPath).catch(() => undefined);
      return err({ kind: "io", message: `JSONの書き込みに失敗しました: ${String(cause)}` });
    }
  }

  readJson<T>(relPath: string): Result<T, StorageError> {
    const resolved = this.resolveInsideRoot(relPath);
    if (!resolved.ok) return resolved;
    if (!existsSync(resolved.value)) {
      return err({ kind: "notFound", message: `ファイルが存在しません: ${relPath}` });
    }
    try {
      return ok(JSON.parse(readFileSync(resolved.value, "utf8")) as T);
    } catch (cause) {
      return err({ kind: "io", message: `JSONの読み込みに失敗しました: ${String(cause)}` });
    }
  }

  /** 記事フォルダをOSのファイルマネージャで開く(2.5) */
  openFolder(articleId: string): Result<void, StorageError> {
    const folderName = this.findFolderById(articleId);
    if (!folderName) {
      return err({ kind: "notFound", message: `記事フォルダが見つかりません: ${articleId}` });
    }
    const dir = join(this.root, folderName);
    const command =
      process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    try {
      const child = spawn(command, [dir], { detached: true, stdio: "ignore" });
      child.on("error", (cause) => {
        this.logger?.warn("フォルダを開けませんでした", { articleId, cause: String(cause) });
      });
      child.unref();
      return ok(undefined);
    } catch (cause) {
      return err({ kind: "io", message: `フォルダを開けませんでした: ${String(cause)}` });
    }
  }
}
