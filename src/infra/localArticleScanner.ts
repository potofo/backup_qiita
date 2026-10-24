/**
 * ローカル新規記事スキャナ(article-upload-sync 1.1〜1.3)
 * - backups/ 直下の未登録フォルダを走査しローカル新規記事候補を列挙する(読み取り専用)
 * - frontmatter解析は平坦なYAML(title: string / tags: [a, b] または行区切り)に限定(依存最小主義)
 * - index.json・.git・登録済みフォルダ(_{記事ID} 一致)は除外する
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LocalDraft, Result, StorageError } from "../types/index.js";
import { ok, err } from "../types/index.js";
import type { StorageManager } from "./storageManager.js";
import type { Logger } from "../config/logger.js";

export interface LocalArticleScanner {
  /** knownIds: index登録済みの記事ID集合。戻り値は名前順 */
  scan(knownIds: ReadonlySet<string>): Result<LocalDraft[], StorageError>;
}

/** frontmatterの解析結果 */
type Frontmatter = {
  title: string | null;
  tags: string[];
  /** frontmatter除去後の本文 */
  body: string;
};

/** 値の前後の引用符を除去する */
const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

/**
 * 平坦なYAML frontmatterを解析する(title / tags のみ対象)。
 * 対応形式: `tags: [a, b]`(インライン配列)と `tags:` + `- item`(行区切り)
 */
export const parseFrontmatter = (content: string): Frontmatter => {
  const none: Frontmatter = { title: null, tags: [], body: content };
  // 正規化: BOM・CRLF対応
  const text = content.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return none;

  const endIndex = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (endIndex < 0) return none;

  let title: string | null = null;
  const tags: string[] = [];
  let inTagsList = false;

  for (const line of lines.slice(1, endIndex)) {
    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (inTagsList && listItem) {
      const tag = unquote(listItem[1]!);
      if (tag) tags.push(tag);
      continue;
    }
    inTagsList = false;

    const keyValue = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!keyValue) continue;
    const key = keyValue[1]!;
    const rawValue = keyValue[2]!.trim();

    if (key === "title") {
      const value = unquote(rawValue);
      title = value ? value : null;
    } else if (key === "tags") {
      if (rawValue === "") {
        inTagsList = true; // 行区切り形式(後続の "- item" を収集)
      } else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        const inner = rawValue.slice(1, -1).trim();
        if (inner) {
          for (const part of inner.split(",")) {
            const tag = unquote(part);
            if (tag) tags.push(tag);
          }
        }
      } else if (rawValue) {
        // スカラー値: Qiitaのタグ名は空白を含められないため、
        // カンマ・空白区切りを複数タグとして解釈する(Qiitaエディタのタグ表記と互換)
        for (const part of unquote(rawValue).split(/[,\s]+/)) {
          const tag = part.trim();
          if (tag) tags.push(tag);
        }
      }
    }
  }

  const body = lines.slice(endIndex + 1).join("\n").replace(/^\n+/, "");
  return { title, tags, body };
};

export class LocalArticleScannerImpl implements LocalArticleScanner {
  constructor(
    private readonly storage: StorageManager,
    private readonly logger?: Logger,
  ) {}

  scan(knownIds: ReadonlySet<string>): Result<LocalDraft[], StorageError> {
    const root = this.storage.root;
    if (!existsSync(root)) return ok([]); // ルート未作成なら候補なし

    try {
      const drafts: LocalDraft[] = [];
      const entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, "ja"));

      for (const folderName of entries) {
        if (folderName === ".git") continue;
        // 登録済み記事フォルダ({タイトル}_{記事ID})は除外する
        const knownSuffix = [...knownIds].some((id) => folderName.endsWith(`_${id}`));
        if (knownSuffix) continue;

        drafts.push(this.readDraft(folderName));
      }
      return ok(drafts);
    } catch (cause) {
      this.logger?.error("ローカル新規記事の走査に失敗しました", { cause: String(cause) });
      return err({ kind: "io", message: `ローカル新規記事の走査に失敗しました: ${String(cause)}` });
    }
  }

  /** フォルダ1件を読み取り、規約充足を判定する(1.2, 1.3) */
  private readDraft(folderName: string): LocalDraft {
    const dir = join(this.storage.root, folderName);
    const mdFiles = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, "ja"));

    const base: LocalDraft = {
      key: `local:${folderName}`,
      folderName,
      mdFileName: mdFiles[0] ?? "",
      title: null,
      tags: [],
      body: "",
      mtime: "",
      invalidReasons: [],
    };

    if (mdFiles.length === 0) {
      base.invalidReasons.push("Markdownファイルがありません(フォルダ直下に .md を1つ置いてください)");
      return base;
    }
    if (mdFiles.length > 1) {
      base.invalidReasons.push(`Markdownファイルが複数あります(1フォルダ1記事): ${mdFiles.join(", ")}`);
      return base;
    }

    const mdPath = join(dir, mdFiles[0]!);
    const content = readFileSync(mdPath, "utf8");
    const { title, tags, body } = parseFrontmatter(content);
    base.title = title;
    base.tags = tags;
    base.body = body;
    base.mtime = statSync(mdPath).mtime.toISOString();

    if (title === null) {
      base.invalidReasons.push("frontmatterにtitleがありません");
    }
    if (tags.length === 0) {
      base.invalidReasons.push("frontmatterのtagsは1件以上必要です");
    }
    return base;
  }
}
