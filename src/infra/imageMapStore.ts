/**
 * 画像↔Qiita画像URLの対応表の永続化(image-upload-automation 7.4, 7.6, 7.7, 8.2)
 * - 既存記事(meta.jsonあり)は meta.json の uploadedImages、新規記事は記事フォルダ直下の .image-uploads.json に保存する
 * - 1件記録するたびに一時ファイル経由で書き込む(途中で止まっても既存の記録を壊さない)
 * - 同じ内容ハッシュは1件にまとめて参照パスを追加する。エントリは削除しない(Qiita側の画像は消せないため)
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ArticleMeta, DraftImageUploads, Result, StorageError, UploadedImageEntry } from "../types/index.js";
import { ok } from "../types/index.js";
import { DRAFT_IMAGE_UPLOADS_FILE, type StorageManager } from "./storageManager.js";

export interface ImageMapStore {
  read(folderName: string): Result<UploadedImageEntry[], StorageError>;
  record(folderName: string, entry: UploadedImageEntry): Promise<Result<void, StorageError>>;
  /** バックアップルート内の全記事から同じ内容の画像を探す(記事をまたいだ再利用 — 7.7) */
  findByHash(sha256: string): UploadedImageEntry | null;
}

/** 同じハッシュのエントリへ参照パスを統合する(URL・記録日時は最初の記録を保つ) */
const mergeEntry = (entries: UploadedImageEntry[], entry: UploadedImageEntry): UploadedImageEntry[] => {
  const index = entries.findIndex((e) => e.sha256 === entry.sha256);
  if (index < 0) return [...entries, entry];
  const current = entries[index]!;
  const paths = [...new Set([...current.paths, ...entry.paths])];
  return entries.map((e, i) => (i === index ? { ...current, paths } : e));
};

export class ImageMapStoreImpl implements ImageMapStore {
  /** sha256 → エントリ(初回の findByHash で全記事を走査して作る) */
  private hashIndex: Map<string, UploadedImageEntry> | null = null;

  constructor(private readonly storage: StorageManager) {}

  private isArticleFolder(folderName: string): boolean {
    return existsSync(join(this.storage.root, folderName, "meta.json"));
  }

  read(folderName: string): Result<UploadedImageEntry[], StorageError> {
    if (this.isArticleFolder(folderName)) {
      const meta = this.storage.readJson<ArticleMeta>(join(folderName, "meta.json"));
      if (!meta.ok) return meta;
      return ok(meta.value.uploadedImages ?? []);
    }
    const sidecar = this.storage.readJson<DraftImageUploads>(join(folderName, DRAFT_IMAGE_UPLOADS_FILE));
    if (!sidecar.ok) return sidecar.error.kind === "notFound" ? ok([]) : sidecar;
    return ok(sidecar.value.entries);
  }

  async record(folderName: string, entry: UploadedImageEntry): Promise<Result<void, StorageError>> {
    let written: Result<void, StorageError>;
    if (this.isArticleFolder(folderName)) {
      const metaPath = join(folderName, "meta.json");
      const meta = this.storage.readJson<ArticleMeta>(metaPath);
      if (!meta.ok) return meta;
      const uploadedImages = mergeEntry(meta.value.uploadedImages ?? [], entry);
      written = await this.storage.writeJsonAtomic(metaPath, { ...meta.value, uploadedImages });
    } else {
      const current = this.read(folderName);
      if (!current.ok) return current;
      const data: DraftImageUploads = { schemaVersion: 1, entries: mergeEntry(current.value, entry) };
      written = await this.storage.writeJsonAtomic(join(folderName, DRAFT_IMAGE_UPLOADS_FILE), data);
    }
    if (written.ok && this.hashIndex && !this.hashIndex.has(entry.sha256)) {
      this.hashIndex.set(entry.sha256, entry);
    }
    return written;
  }

  findByHash(sha256: string): UploadedImageEntry | null {
    if (!this.hashIndex) this.hashIndex = this.buildIndex();
    return this.hashIndex.get(sha256) ?? null;
  }

  private buildIndex(): Map<string, UploadedImageEntry> {
    const index = new Map<string, UploadedImageEntry>();
    if (!existsSync(this.storage.root)) return index;
    const folders = readdirSync(this.storage.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== ".git")
      .map((e) => e.name);
    for (const folder of folders) {
      const entries = this.read(folder);
      if (!entries.ok) continue; // 壊れた管理情報は検索対象から外す(再アップロードになるだけで安全)
      for (const e of entries.value) if (!index.has(e.sha256)) index.set(e.sha256, e);
    }
    return index;
  }
}
