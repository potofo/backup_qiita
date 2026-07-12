import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageManagerImpl, sanitizeTitle, articleFolderName } from "../src/infra/storageManager.js";
import type { QiitaItem, ImageResult } from "../src/types/index.js";

const makeItem = (overrides: Partial<QiitaItem> & { id: string }): QiitaItem => ({
  title: `記事 ${overrides.id}`,
  body: "# 本文",
  url: `https://qiita.com/u/items/${overrides.id}`,
  createdAt: "2026-01-01T10:00:00+09:00",
  updatedAt: "2026-01-02T10:00:00+09:00",
  private: false,
  tags: [{ name: "test" }],
  commentsCount: 1,
  likesCount: 2,
  stocksCount: 3,
  ...overrides,
});

describe("sanitizeTitle / articleFolderName(4.2)", () => {
  it("OS禁止文字を_に置換する", () => {
    expect(sanitizeTitle('a\\b/c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("50文字を超えるタイトルは切り詰める", () => {
    const long = "あ".repeat(80);
    expect(sanitizeTitle(long)).toHaveLength(50);
  });

  it("フォルダ名は{サニタイズ済タイトル}_{記事ID}", () => {
    expect(articleFolderName("タイトル: 検証?", "abc123")).toBe("タイトル_ 検証__abc123");
  });
});

describe("StorageManager(2.3)", () => {
  let root: string;
  let storage: StorageManagerImpl;

  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), "qbt-st-")), "backup");
    storage = new StorageManagerImpl(root);
  });

  it("バックアップ先ルートと記事フォルダ一式を規定構成で保存する(4.1, 4.3)", async () => {
    const item = makeItem({ id: "abc123", title: "テスト記事" });
    const images: ImageResult[] = [
      { url: "https://example.com/x.png", ok: true, fileName: "001_x.png" },
      { url: "https://example.com/y.png", ok: false, reason: "HTTP 404" },
    ];
    const result = await storage.saveArticle(item, "# 書換済み本文", images);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dir = join(root, "テスト記事_abc123");
    expect(existsSync(join(dir, "テスト記事.md"))).toBe(true);
    expect(existsSync(join(dir, "original.md"))).toBe(true);
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
    expect(existsSync(join(dir, "images"))).toBe(true);

    expect(readFileSync(join(dir, "テスト記事.md"), "utf8")).toBe("# 書換済み本文");
    expect(readFileSync(join(dir, "original.md"), "utf8")).toBe("# 本文");

    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.id).toBe("abc123");
    expect(meta.title).toBe("テスト記事");
    expect(meta.likesCount).toBe(2);
    expect(meta.stocksCount).toBe(3);
    expect(meta.commentsCount).toBe(1);
    expect(meta.tags).toEqual(["test"]);
    expect(meta.images).toHaveLength(2);
    expect(meta.backedUpAt).toBeTruthy();
  });

  it("再バックアップ時は既存ファイルを上書きする(3.11)", async () => {
    const item = makeItem({ id: "abc123", title: "テスト記事" });
    await storage.saveArticle(item, "旧本文", []);
    const result = await storage.saveArticle(item, "新本文", []);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "テスト記事_abc123", "テスト記事.md"), "utf8")).toBe("新本文");
  });

  it("タイトル変更時は記事IDで同一判定し既存フォルダをリネームする(4.6)", async () => {
    await storage.saveArticle(makeItem({ id: "abc123", title: "旧タイトル" }), "本文", []);
    // 旧フォルダにしか存在しないファイル(画像)がリネーム後も残ることを確認する
    writeFileSync(join(root, "旧タイトル_abc123", "images", "001.png"), "png");

    const result = await storage.saveArticle(makeItem({ id: "abc123", title: "新タイトル" }), "本文2", []);
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "旧タイトル_abc123"))).toBe(false);
    expect(existsSync(join(root, "新タイトル_abc123", "新タイトル.md"))).toBe(true);
    expect(existsSync(join(root, "新タイトル_abc123", "images", "001.png"))).toBe(true);
    // 旧タイトルの閲覧用mdは残さない
    expect(existsSync(join(root, "新タイトル_abc123", "旧タイトル.md"))).toBe(false);
  });

  it("writeJsonAtomicは一時ファイル経由で書き込み、失敗時も既存ファイルを破損しない(9.3)", async () => {
    const okResult = await storage.writeJsonAtomic("index.json", { schemaVersion: 1 });
    expect(okResult.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "index.json"), "utf8"))).toEqual({ schemaVersion: 1 });

    // シリアライズ不能な値(循環参照)で失敗させても、既存内容は無傷(中断シミュレーション)
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const failResult = await storage.writeJsonAtomic("index.json", circular);
    expect(failResult.ok).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "index.json"), "utf8"))).toEqual({ schemaVersion: 1 });
    // 一時ファイルが残っていない
    expect(readdirSync(root).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("バックアップ先外への書き込みを拒否する(パストラバーサル防止)", async () => {
    const result = await storage.writeJsonAtomic("../evil.json", { pwned: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("forbiddenPath");
    expect(existsSync(join(root, "..", "evil.json"))).toBe(false);
  });

  it("readJsonはファイル不在時にnotFoundを返す", async () => {
    const result = await storage.readJson("index.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("notFound");
  });

  it("openFolderは存在しない記事IDに対しnotFoundを返す(2.5)", () => {
    const result = storage.openFolder("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("notFound");
  });

  it("findFolderByIdは記事IDからフォルダ名を返す", async () => {
    await storage.saveArticle(makeItem({ id: "abc123", title: "テスト記事" }), "本文", []);
    expect(storage.findFolderById("abc123")).toBe("テスト記事_abc123");
    expect(storage.findFolderById("zzz")).toBeNull();
  });

  it("システムディレクトリをバックアップ先として拒否する(steering security.md)", () => {
    expect(() => new StorageManagerImpl("C:\\Windows\\backup")).toThrow();
    expect(() => new StorageManagerImpl("C:\\")).toThrow();
  });
});
