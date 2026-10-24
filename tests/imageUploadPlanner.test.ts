import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { StorageManagerImpl } from "../src/infra/storageManager.js";
import { ImageMapStoreImpl } from "../src/infra/imageMapStore.js";
import { ImageUploadPlannerImpl } from "../src/services/imageUploadPlanner.js";
import type { ArticleImagePlan, ImagePlanEntry } from "../src/types/index.js";

const PNG = (seed: string): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);
const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

const setup = (options: { maxImageBytes?: number } = {}) => {
  const root = join(mkdtempSync(join(tmpdir(), "qbt-plan-")), "backup");
  mkdirSync(root, { recursive: true });
  const storage = new StorageManagerImpl(root);
  const mapStore = new ImageMapStoreImpl(storage);
  const planner = new ImageUploadPlannerImpl({ storageManager: storage, imageMapStore: mapStore }, options);
  const file = (folder: string, rel: string, content: Buffer | string): void => {
    const path = join(root, folder, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  return { root, storage, mapStore, planner, file };
};

const statusOf = (plan: ArticleImagePlan, ref: string): ImagePlanEntry["status"]["kind"] | undefined =>
  plan.entries.find((e) => e.ref === ref)?.status.kind;

describe("ImageUploadPlanner(image-upload-automation 2.3〜2.6, 3.1, 7.6, 7.7)", () => {
  it("記事フォルダ基準で参照を解決し、送る画像として枚数・容量を数える", () => {
    const { planner, file } = setup();
    file("draft", "images/a.png", PNG("a"));
    file("draft", "my pic.png", PNG("b"));
    const result = planner.plan([
      { key: "local:draft", title: "下書き", folderName: "draft", body: "![a](images/a.png)\n![b](./my%20pic.png?v=1#x)" },
    ]);
    if (!result.ok) return expect.fail(result.error.message);
    const article = result.value.articles[0]!;
    expect(article.entries.map((e) => [e.ref, e.path, e.status.kind])).toEqual([
      ["images/a.png", "images/a.png", "upload"],
      ["./my%20pic.png?v=1#x", "my pic.png", "upload"],
    ]);
    expect(result.value.uploadCount).toBe(2);
    expect(result.value.uploadBytes).toBe(PNG("a").length + PNG("b").length);
    expect(result.value.reuseCount).toBe(0);
  });

  it("ファイルがない参照は missing、記事フォルダの外を指す参照は outsideFolder とする(2.3, 2.4)", () => {
    const { root, planner, file } = setup();
    file("other", "secret.png", PNG("s"));
    file("draft", "x.md", "x");
    let symlinked = true;
    try {
      symlinkSync(join(root, "other", "secret.png"), join(root, "draft", "link.png"));
    } catch {
      symlinked = false; // Windowsで権限がない場合はシンボリックリンクの検証を省く
    }
    const result = planner.plan([
      {
        key: "local:draft",
        title: "下書き",
        folderName: "draft",
        body: "![m](images/none.png)\n![o](../other/secret.png)\n![l](link.png)",
      },
    ]);
    if (!result.ok) return expect.fail(result.error.message);
    const article = result.value.articles[0]!;
    expect(statusOf(article, "images/none.png")).toBe("missing");
    expect(statusOf(article, "../other/secret.png")).toBe("outsideFolder");
    if (symlinked) expect(statusOf(article, "link.png")).toBe("outsideFolder");
    expect(result.value.uploadCount).toBe(0);
  });

  it("形式が対象外・中身が拡張子と違う・容量上限を超える画像は unsupported とし理由を付ける(2.5)", () => {
    const { planner, file } = setup({ maxImageBytes: 20 });
    file("draft", "a.svg", "<svg></svg>");
    file("draft", "fake.png", "not a png");
    file("draft", "big.png", PNG("x".repeat(50)));
    const result = planner.plan([
      { key: "local:draft", title: "下書き", folderName: "draft", body: "![s](a.svg)\n![f](fake.png)\n![b](big.png)" },
    ]);
    if (!result.ok) return expect.fail(result.error.message);
    const entries = result.value.articles[0]!.entries;
    expect(entries.map((e) => e.status.kind)).toEqual(["unsupported", "unsupported", "unsupported"]);
    const big = entries[2]!.status;
    expect(big.kind === "unsupported" && big.reason).toContain("容量");
  });

  it("対応表に同じ内容が記録済みなら reuse、同じパスでも内容が変わっていれば upload とする(2.6, 7.6, 7.7)", async () => {
    const { planner, file, mapStore } = setup();
    file("draft", "images/a.png", PNG("v2")); // 内容を更新済み
    file("draft", "images/b.png", PNG("same"));
    file("other", "meta.json", "{}");
    await mapStore.record("draft", {
      sha256: sha(PNG("v1")),
      paths: ["images/a.png"],
      url: "https://qiita-image-store.s3.amazonaws.com/0/1/old-a.png",
      bytes: 10,
      uploadedAt: "2026-10-25T00:00:00.000Z",
    });
    // 別の記事で同じ内容の画像がアップロード済み(記事をまたいだ再利用)
    await mapStore.record("draft2", {
      sha256: sha(PNG("same")),
      paths: ["c.png"],
      url: "https://qiita-image-store.s3.amazonaws.com/0/1/same.png",
      bytes: 10,
      uploadedAt: "2026-10-25T00:00:00.000Z",
    });
    const result = planner.plan([
      { key: "local:draft", title: "下書き", folderName: "draft", body: "![a](images/a.png)\n![b](images/b.png)" },
    ]);
    if (!result.ok) return expect.fail(result.error.message);
    const entries = result.value.articles[0]!.entries;
    expect(entries[0]!.status).toEqual({ kind: "upload" });
    expect(entries[1]!.status).toEqual({ kind: "reuse", url: "https://qiita-image-store.s3.amazonaws.com/0/1/same.png" });
    expect(result.value.uploadCount).toBe(1);
    expect(result.value.reuseCount).toBe(1);
  });

  it("同じ内容の画像を複数の記事・参照が使っていても、送る枚数と容量は1回分で数える", () => {
    const { planner, file } = setup();
    file("d1", "a.png", PNG("dup"));
    file("d2", "images/copy.png", PNG("dup"));
    const result = planner.plan([
      { key: "local:d1", title: "1", folderName: "d1", body: "![a](a.png)\n<img src=\"./a.png\">" },
      { key: "local:d2", title: "2", folderName: "d2", body: "![c](images/copy.png)" },
    ]);
    if (!result.ok) return expect.fail(result.error.message);
    expect(result.value.uploadCount).toBe(1);
    expect(result.value.uploadBytes).toBe(PNG("dup").length);
    expect(result.value.articles.map((a) => a.entries.length)).toEqual([2, 1]);
  });

  it("ローカル画像参照のない記事も空の計画として含める", () => {
    const { planner } = setup();
    const result = planner.plan([
      { key: "a1", title: "外部画像のみ", folderName: "x_a1", body: "![e](https://example.com/e.png)" },
    ]);
    expect(result.ok && result.value.articles).toEqual([{ key: "a1", title: "外部画像のみ", folderName: "x_a1", entries: [] }]);
  });
});
