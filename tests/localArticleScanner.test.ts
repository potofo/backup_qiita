import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArticleScannerImpl } from "../src/infra/localArticleScanner.js";
import { StorageManagerImpl } from "../src/infra/storageManager.js";

describe("LocalArticleScanner(article-upload-sync 1.1〜1.3)", () => {
  let root: string;
  let scanner: LocalArticleScannerImpl;

  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), "qbt-scan-")), "backup");
    mkdirSync(root, { recursive: true });
    scanner = new LocalArticleScannerImpl(new StorageManagerImpl(root));
  });

  /** 新規記事フォルダを作る */
  const makeDraft = (folder: string, mdName: string, content: string): void => {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, mdName), content, "utf8");
  };

  it("正常なfrontmatter(インライン配列)の新規記事を検出する(1.1, 1.2)", () => {
    makeDraft(
      "my-new-article",
      "draft.md",
      "---\ntitle: 新しい記事\ntags: [typescript, nodejs]\n---\n# 本文\n\nこんにちは。",
    );
    const result = scanner.scan(new Set());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const draft = result.value[0]!;
    expect(draft.key).toBe("local:my-new-article");
    expect(draft.folderName).toBe("my-new-article");
    expect(draft.mdFileName).toBe("draft.md");
    expect(draft.title).toBe("新しい記事");
    expect(draft.tags).toEqual(["typescript", "nodejs"]);
    expect(draft.body).toBe("# 本文\n\nこんにちは。");
    expect(draft.invalidReasons).toEqual([]);
    expect(draft.mtime).not.toBe("");
  });

  it("スペース区切りのtags(Qiitaエディタ形式)を複数タグとして解析できる", () => {
    // Qiitaのタグ名はスペースを含められないため、スペース区切りは複数タグとみなす
    makeDraft(
      "space-tags",
      "a.md",
      "---\ntitle: スペース区切り\ntags: Azure AzureContainerApps SoftEther VPN nginx\n---\n本文",
    );
    const result = scanner.scan(new Set());
    if (!result.ok) return expect.fail("scan失敗");
    expect(result.value[0]!.tags).toEqual([
      "Azure",
      "AzureContainerApps",
      "SoftEther",
      "VPN",
      "nginx",
    ]);
    expect(result.value[0]!.invalidReasons).toEqual([]);
  });

  it("カンマ区切り(括弧なし)のtagsも複数タグとして解析できる", () => {
    makeDraft("comma-tags", "a.md", "---\ntitle: カンマ区切り\ntags: a, b, c\n---\n本文");
    const result = scanner.scan(new Set());
    if (!result.ok) return expect.fail("scan失敗");
    expect(result.value[0]!.tags).toEqual(["a", "b", "c"]);
  });

  it("行区切り(- 項目)のtagsと引用符付きtitleを解析できる", () => {
    makeDraft(
      "draft2",
      "index.md",
      '---\ntitle: "引用符付き タイトル"\ntags:\n  - qiita\n  - "api"\n---\n本文',
    );
    const result = scanner.scan(new Set());
    if (!result.ok) return expect.fail("scan失敗");
    expect(result.value[0]!.title).toBe("引用符付き タイトル");
    expect(result.value[0]!.tags).toEqual(["qiita", "api"]);
  });

  it("titleが欠落している場合は不備理由付きで返す(1.3)", () => {
    makeDraft("no-title", "a.md", "---\ntags: [test]\n---\n本文");
    const result = scanner.scan(new Set());
    if (!result.ok) return expect.fail("scan失敗");
    const draft = result.value[0]!;
    expect(draft.title).toBeNull();
    expect(draft.invalidReasons.some((r) => r.includes("title"))).toBe(true);
  });

  it("tagsが0件の場合は不備理由付きで返す(1.3)", () => {
    makeDraft("no-tags", "a.md", "---\ntitle: タグなし\ntags: []\n---\n本文");
    const result = scanner.scan(new Set());
    if (!result.ok) return expect.fail("scan失敗");
    const draft = result.value[0]!;
    expect(draft.invalidReasons.some((r) => r.includes("tags"))).toBe(true);
  });

  it("frontmatterが無い場合はtitle・tags両方の不備として返す", () => {
    makeDraft("no-fm", "a.md", "# frontmatterなし\n本文のみ");
    const result = scanner.scan(new Set());
    if (!result.ok) return expect.fail("scan失敗");
    const draft = result.value[0]!;
    expect(draft.title).toBeNull();
    expect(draft.invalidReasons.length).toBeGreaterThanOrEqual(2);
  });

  it("Markdownが複数あるフォルダは不備として返す(1フォルダ1記事)", () => {
    makeDraft("multi-md", "a.md", "---\ntitle: A\ntags: [t]\n---\nA");
    writeFileSync(join(root, "multi-md", "b.md"), "B", "utf8");
    const result = scanner.scan(new Set());
    if (!result.ok) return expect.fail("scan失敗");
    const draft = result.value[0]!;
    expect(draft.invalidReasons.some((r) => r.includes("複数"))).toBe(true);
  });

  it("Markdownが無いフォルダは不備として返す", () => {
    mkdirSync(join(root, "empty-folder"));
    const result = scanner.scan(new Set());
    if (!result.ok) return expect.fail("scan失敗");
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.invalidReasons.some((r) => r.includes("Markdown"))).toBe(true);
  });

  it("登録済み記事フォルダ(_{記事ID}一致)と.git・管理ファイルは除外する", () => {
    // 登録済み記事フォルダのレイアウトを模擬
    mkdirSync(join(root, "既存記事_abc123"), { recursive: true });
    writeFileSync(join(root, "既存記事_abc123", "既存記事.md"), "x", "utf8");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "index.json"), "{}", "utf8");
    makeDraft("brand-new", "n.md", "---\ntitle: 新規\ntags: [t]\n---\nb");

    const result = scanner.scan(new Set(["abc123"]));
    if (!result.ok) return expect.fail("scan失敗");
    expect(result.value.map((d) => d.folderName)).toEqual(["brand-new"]);
  });

  it("未登録IDのサフィックスを持つフォルダは候補に含める(indexに無いため)", () => {
    makeDraft("記事_zzz999", "a.md", "---\ntitle: T\ntags: [t]\n---\nb");
    const result = scanner.scan(new Set(["abc123"]));
    if (!result.ok) return expect.fail("scan失敗");
    expect(result.value).toHaveLength(1);
  });

  it("バックアップルートが存在しない場合は空配列を返す", () => {
    const scanner2 = new LocalArticleScannerImpl(
      new StorageManagerImpl(join(root, "not-exist")),
    );
    const result = scanner2.scan(new Set());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("結果はフォルダ名順で返す", () => {
    makeDraft("b-folder", "b.md", "---\ntitle: B\ntags: [t]\n---\nb");
    makeDraft("a-folder", "a.md", "---\ntitle: A\ntags: [t]\n---\na");
    const result = scanner.scan(new Set());
    if (!result.ok) return expect.fail("scan失敗");
    expect(result.value.map((d) => d.folderName)).toEqual(["a-folder", "b-folder"]);
  });

  it("ファイルを一切変更しない(読み取り専用)", () => {
    makeDraft("readonly-check", "a.md", "---\ntitle: A\ntags: [t]\n---\nbody");
    const result = scanner.scan(new Set());
    expect(result.ok).toBe(true);
    // 走査後もファイル内容が不変
    const content = readFileSync(join(root, "readonly-check", "a.md"), "utf8");
    expect(content).toContain("title: A");
  });
});
