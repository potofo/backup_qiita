import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageManagerImpl } from "../src/infra/storageManager.js";
import { ImageMapStoreImpl } from "../src/infra/imageMapStore.js";
import type { ArticleMeta, StorageError, UploadedImageEntry, Result } from "../src/types/index.js";
import { err } from "../src/types/index.js";

const makeRoot = (): string => {
  const root = join(mkdtempSync(join(tmpdir(), "qbt-map-")), "backup");
  mkdirSync(root, { recursive: true });
  return root;
};

const meta = (id: string, extra: Partial<ArticleMeta> = {}): ArticleMeta => ({
  schemaVersion: 1,
  id,
  title: `記事${id}`,
  url: `https://qiita.com/u/items/${id}`,
  private: true,
  tags: ["t"],
  createdAt: "2026-01-01T00:00:00+09:00",
  updatedAt: "2026-01-01T00:00:00+09:00",
  commentsCount: 0,
  likesCount: 0,
  stocksCount: 0,
  backedUpAt: "2026-01-01T00:00:00.000Z",
  images: [],
  ...extra,
});

const entry = (sha256: string, path: string, url = `https://qiita-image-store.s3.amazonaws.com/${sha256}.png`): UploadedImageEntry => ({
  sha256,
  paths: [path],
  url,
  bytes: 10,
  uploadedAt: "2026-10-25T00:00:00.000Z",
});

/** 既存記事フォルダ(meta.jsonあり)を作る */
const makeArticle = (root: string, folder: string, id: string, extra: Partial<ArticleMeta> = {}): void => {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "meta.json"), JSON.stringify(meta(id, extra)), "utf8");
};

describe("ImageMapStore(image-upload-automation 7.4, 7.6, 7.7, 8.2)", () => {
  it("既存記事は meta.json の uploadedImages に記録し、他の項目を変えない", async () => {
    const root = makeRoot();
    makeArticle(root, "記事a1_a1", "a1", { likesCount: 5 });
    const store = new ImageMapStoreImpl(new StorageManagerImpl(root));

    const result = await store.record("記事a1_a1", entry("h1", "images/a.png"));
    expect(result.ok).toBe(true);

    const saved = JSON.parse(readFileSync(join(root, "記事a1_a1", "meta.json"), "utf8")) as ArticleMeta;
    expect(saved.uploadedImages).toEqual([entry("h1", "images/a.png")]);
    expect(saved.likesCount).toBe(5);
    expect(existsSync(join(root, "記事a1_a1", ".image-uploads.json"))).toBe(false);
  });

  it("新規記事(meta.jsonなし)は補助ファイル .image-uploads.json に記録する", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "my-draft"));
    writeFileSync(join(root, "my-draft", "draft.md"), "# x", "utf8");
    const store = new ImageMapStoreImpl(new StorageManagerImpl(root));

    await store.record("my-draft", entry("h1", "images/a.png"));
    const sidecar = JSON.parse(readFileSync(join(root, "my-draft", ".image-uploads.json"), "utf8"));
    expect(sidecar).toEqual({ schemaVersion: 1, entries: [entry("h1", "images/a.png")] });
    expect(store.read("my-draft")).toEqual({ ok: true, value: [entry("h1", "images/a.png")] });
  });

  it("同じ内容ハッシュは1件にまとめ、参照パスを追加する(URLは最初の記録を保つ)", async () => {
    const root = makeRoot();
    makeArticle(root, "記事a1_a1", "a1");
    const store = new ImageMapStoreImpl(new StorageManagerImpl(root));
    await store.record("記事a1_a1", entry("h1", "images/a.png", "https://qiita-image-store.s3.amazonaws.com/first.png"));
    await store.record("記事a1_a1", entry("h1", "images/copy.png", "https://qiita-image-store.s3.amazonaws.com/second.png"));
    await store.record("記事a1_a1", entry("h1", "images/a.png"));

    const read = store.read("記事a1_a1");
    expect(read.ok && read.value).toEqual([
      { ...entry("h1", "images/a.png", "https://qiita-image-store.s3.amazonaws.com/first.png"), paths: ["images/a.png", "images/copy.png"] },
    ]);
  });

  it("記録のない記事は空の対応表を返す", () => {
    const root = makeRoot();
    makeArticle(root, "記事a1_a1", "a1");
    const store = new ImageMapStoreImpl(new StorageManagerImpl(root));
    expect(store.read("記事a1_a1")).toEqual({ ok: true, value: [] });
    expect(store.read("no-such-folder")).toEqual({ ok: true, value: [] });
  });

  it("バックアップフォルダ内の全記事(既存・新規)から同じ内容の画像を探せる", async () => {
    const root = makeRoot();
    makeArticle(root, "記事a1_a1", "a1", { uploadedImages: [entry("h1", "images/a.png")] });
    mkdirSync(join(root, "my-draft"));
    const store = new ImageMapStoreImpl(new StorageManagerImpl(root));
    expect(store.findByHash("h1")?.url).toBe(entry("h1", "x").url);
    expect(store.findByHash("h2")).toBeNull();

    await store.record("my-draft", entry("h2", "b.png"));
    expect(store.findByHash("h2")?.url).toBe(entry("h2", "x").url); // 記録直後から検索に反映される
  });

  it("書き込みに失敗しても既存の記録は壊れない", async () => {
    const root = makeRoot();
    makeArticle(root, "記事a1_a1", "a1", { uploadedImages: [entry("h1", "images/a.png")] });
    const storage = new StorageManagerImpl(root);
    const failing = Object.create(storage) as StorageManagerImpl;
    failing.writeJsonAtomic = async (): Promise<Result<void, StorageError>> => err({ kind: "io", message: "disk full" });
    const store = new ImageMapStoreImpl(failing);

    const result = await store.record("記事a1_a1", entry("h2", "images/b.png"));
    expect(result.ok).toBe(false);
    const saved = JSON.parse(readFileSync(join(root, "記事a1_a1", "meta.json"), "utf8")) as ArticleMeta;
    expect(saved.uploadedImages).toEqual([entry("h1", "images/a.png")]);
    expect(store.findByHash("h2")).toBeNull();
  });
});
