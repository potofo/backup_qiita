import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageDownloaderImpl } from "../src/infra/imageDownloader.js";
import { startMockImageHost, type MockImageHost } from "./helpers/mockImageHost.js";

let host: MockImageHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

const makeDownloader = () => new ImageDownloaderImpl({ intervalMs: 0 });

describe("ImageDownloader.extractImageUrls(3.5)", () => {
  it("Markdown記法とimgタグの両方から画像URLを抽出する", () => {
    const md = [
      "# タイトル",
      "![alt1](https://camo.qiitausercontent.com/abc123/def456)",
      '![alt2](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/12345/photo.png "説明")',
      '<img src="https://example.com/images/diagram.jpg" width="600">',
      "本文テキスト",
    ].join("\n");
    const urls = makeDownloader().extractImageUrls(md);
    expect(urls).toEqual([
      "https://camo.qiitausercontent.com/abc123/def456",
      "https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/12345/photo.png",
      "https://example.com/images/diagram.jpg",
    ]);
  });

  it("同一URLの複数参照は重複なく抽出する", () => {
    const md = [
      "![a](https://example.com/x.png)",
      "![b](https://example.com/x.png)",
      '<img src="https://example.com/x.png">',
    ].join("\n");
    expect(makeDownloader().extractImageUrls(md)).toEqual(["https://example.com/x.png"]);
  });

  it("http(s)以外の参照・相対パスは対象にしない", () => {
    const md = "![a](images/local.png)\n![b](ftp://example.com/x.png)";
    expect(makeDownloader().extractImageUrls(md)).toEqual([]);
  });

  it("画像参照がない本文では空配列を返す", () => {
    expect(makeDownloader().extractImageUrls("# 本文のみ\nテキスト")).toEqual([]);
  });
});

describe("ImageDownloader.downloadAll(3.5, 3.8, 4.4, 8.5)", () => {
  it("登場順連番+元ファイル名で保存し、拡張子はContent-Typeから決定する", async () => {
    host = await startMockImageHost({
      "/images/photo.png": { contentType: "image/png" },
      "/pics/diagram": { contentType: "image/jpeg" },
    });
    const dest = mkdtempSync(join(tmpdir(), "qbt-img-"));
    const results = await makeDownloader().downloadAll(
      [`${host.origin}/images/photo.png`, `${host.origin}/pics/diagram`],
      dest,
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, fileName: "001_photo.png" });
    // ファイル名相当がないURLは連番のみ。拡張子はContent-Type(image/jpeg → .jpg)
    expect(results[1]).toMatchObject({ ok: true, fileName: "002.jpg" });
    expect(existsSync(join(dest, "001_photo.png"))).toBe(true);
    expect(existsSync(join(dest, "002.jpg"))).toBe(true);
  });

  it("Camo形式URL(拡張子なしプロキシ)は連番のみで保存する", async () => {
    host = await startMockImageHost({
      "/abcdef0123456789/deadbeefcafebabe": { contentType: "image/png" },
    });
    const dest = mkdtempSync(join(tmpdir(), "qbt-img-"));
    const results = await makeDownloader().downloadAll(
      [`${host.origin}/abcdef0123456789/deadbeefcafebabe`],
      dest,
    );
    expect(results[0]).toMatchObject({ ok: true, fileName: "001.png" });
  });

  it("失敗した画像は理由付きで記録し、残りの処理を継続する(3.8)", async () => {
    host = await startMockImageHost({
      "/ok1.png": { contentType: "image/png" },
      "/broken.png": { status: 404 },
      "/ok2.png": { contentType: "image/png" },
    });
    const dest = mkdtempSync(join(tmpdir(), "qbt-img-"));
    const results = await makeDownloader().downloadAll(
      [`${host.origin}/ok1.png`, `${host.origin}/broken.png`, `${host.origin}/ok2.png`],
      dest,
    );
    expect(results[0]!.ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false });
    if (results[1] && !results[1].ok) expect(results[1].reason).toContain("404");
    expect(results[2]!.ok).toBe(true);
    // 失敗した画像はファイルとして残らない
    expect(readdirSync(dest).sort()).toEqual(["001_ok1.png", "003_ok2.png"]);
  });

  it("接続不能ホストでも例外にせず失敗として記録する", async () => {
    const dest = mkdtempSync(join(tmpdir(), "qbt-img-"));
    const results = await makeDownloader().downloadAll(["http://127.0.0.1:1/x.png"], dest);
    expect(results[0]).toMatchObject({ ok: false });
  });

  it("認証ヘッダ(Authorization)を一切送信しない(8.5)", async () => {
    host = await startMockImageHost({ "/x.png": { contentType: "image/png" } });
    const dest = mkdtempSync(join(tmpdir(), "qbt-img-"));
    await makeDownloader().downloadAll([`${host.origin}/x.png`], dest);
    expect(host.authHeaders).toEqual([undefined]);
  });
});
