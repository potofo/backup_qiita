import { describe, it, expect, afterEach } from "vitest";
import { QiitaApiClientImpl } from "../src/infra/qiitaApiClient.js";
import { createTokenStore } from "../src/config/tokenStore.js";
import { startMockQiita, makeRawItem, type MockQiitaServer } from "./helpers/mockQiitaServer.js";

let mock: MockQiitaServer | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const makeClient = (baseUrl: string, token: string | null = "valid-token") => {
  const store = createTokenStore(token);
  return new QiitaApiClientImpl(store, { baseUrl });
};

describe("QiitaApiClient.verifyToken(1.2)", () => {
  it("有効トークンでユーザIDと投稿記事数を返す", async () => {
    mock = await startMockQiita({
      items: [makeRawItem({ id: "a1" }), makeRawItem({ id: "a2" })],
      userId: "potofo",
      validToken: "valid-token",
    });
    const client = makeClient(mock.url);
    const result = await client.verifyToken("valid-token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("potofo");
      expect(result.value.itemsCount).toBe(2);
    }
  });

  it("無効トークンはunauthorized(401)を型で返す", async () => {
    mock = await startMockQiita({ validToken: "valid-token" });
    const client = makeClient(mock.url);
    const result = await client.verifyToken("wrong-token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unauthorized");
  });

  it("ネットワークエラーをnetworkとして返す", async () => {
    const client = makeClient("http://127.0.0.1:1/api/v2"); // 接続不能
    const result = await client.verifyToken("any");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("network");
  });
});

describe("QiitaApiClient.fetchAllItems(2.1)", () => {
  it("Linkヘッダを追跡して複数ページの全記事を取得する(限定共有含む)", async () => {
    const items = Array.from({ length: 250 }, (_, i) =>
      makeRawItem({ id: `item${String(i).padStart(3, "0")}`, private: i % 2 === 0 }),
    );
    mock = await startMockQiita({ items, validToken: "valid-token" });
    const client = makeClient(mock.url);

    const pages: [number, number][] = [];
    const result = await client.fetchAllItems((fetched, total) => pages.push([fetched, total]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(250);
      expect(result.value.some((i) => i.private)).toBe(true);
      // snake_case → camelCase へのマッピング
      const first = result.value[0]!;
      expect(first.id).toBe("item000");
      expect(first.createdAt).toBe("2026-01-01T10:00:00+09:00");
      expect(first.commentsCount).toBe(0);
      expect(first.tags).toEqual([{ name: "test" }]);
    }
    // per_page=100 で3リクエスト
    expect(mock.itemRequestCount()).toBe(3);
    // ページごとの進捗コールバック
    expect(pages).toEqual([
      [100, 250],
      [200, 250],
      [250, 250],
    ]);
  });

  it("429受信時はrateLimitedとして再開可能時刻(Rate-Reset)を返す(3.12)", async () => {
    mock = await startMockQiita({
      items: [makeRawItem({ id: "a1" })],
      validToken: "valid-token",
      rateLimitFirstN: { count: 1, resetAfterSec: 60 },
    });
    const client = makeClient(mock.url);
    const result = await client.fetchAllItems();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "rateLimited") {
      const diffSec = (result.error.resetAt.getTime() - Date.now()) / 1000;
      expect(diffSec).toBeGreaterThan(50);
      expect(diffSec).toBeLessThan(70);
    } else {
      expect.fail(`rateLimited を期待したが: ${JSON.stringify(result)}`);
    }
  });

  it("サーバエラー(5xx)をserverとして返す", async () => {
    mock = await startMockQiita({
      items: [makeRawItem({ id: "a1" })],
      validToken: "valid-token",
      failFirstN: { count: 1, status: 503 },
    });
    const client = makeClient(mock.url);
    const result = await client.fetchAllItems();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "server") {
      expect(result.error.status).toBe(503);
    } else {
      expect.fail(`server を期待したが: ${JSON.stringify(result)}`);
    }
  });

  it("トークン未設定時はunauthorizedを返す", async () => {
    mock = await startMockQiita({ items: [], validToken: "valid-token" });
    const client = makeClient(mock.url, null);
    const result = await client.fetchAllItems();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unauthorized");
  });

  it("認証ヘッダはQiita APIへのリクエストに付与される(8.1)", async () => {
    mock = await startMockQiita({ items: [makeRawItem({ id: "a1" })], validToken: "tok123" });
    const client = makeClient(mock.url, "tok123");
    await client.fetchAllItems();
    expect(mock.authHeaders.every((h) => h === "Bearer tok123")).toBe(true);
  });
});

describe("QiitaApiClient.createItem(article-upload-sync 3.2, 5.1)", () => {
  it("POST /items で限定共有(private: true)の記事を登録し、正規化Itemを返す", async () => {
    mock = await startMockQiita({ validToken: "valid-token" });
    const client = makeClient(mock.url);
    const result = await client.createItem({
      title: "新規記事",
      body: "# 本文",
      tags: [{ name: "typescript" }, { name: "qiita" }],
      private: true,
      tweet: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).not.toBe("");
    expect(result.value.private).toBe(true);
    expect(result.value.url).toContain(result.value.id);
    expect(result.value.updatedAt).not.toBe("");

    // 送信ペイロードの検証(限定共有・SNS投稿なし — 5.1)
    expect(mock.writeRequests).toHaveLength(1);
    const req = mock.writeRequests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/v2/items");
    expect(req.body["title"]).toBe("新規記事");
    expect(req.body["body"]).toBe("# 本文");
    expect(req.body["tags"]).toEqual([{ name: "typescript" }, { name: "qiita" }]);
    expect(req.body["private"]).toBe(true);
    expect(req.body["tweet"]).toBe(false);
  });

  it("スコープ不足(403)はforbiddenとして返す(6.2)", async () => {
    mock = await startMockQiita({ validToken: "valid-token", writeForbidden: true });
    const client = makeClient(mock.url);
    const result = await client.createItem({
      title: "t",
      body: "b",
      tags: [{ name: "t" }],
      private: true,
      tweet: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("forbidden");
  });

  it("429はrateLimitedとしてRate-Reset由来の再開時刻を返す(9.1)", async () => {
    mock = await startMockQiita({
      validToken: "valid-token",
      writeRateLimitFirstN: { count: 1, resetAfterSec: 60 },
    });
    const client = makeClient(mock.url);
    const result = await client.createItem({
      title: "t",
      body: "b",
      tags: [{ name: "t" }],
      private: true,
      tweet: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "rateLimited") {
      const diffSec = (result.error.resetAt.getTime() - Date.now()) / 1000;
      expect(diffSec).toBeGreaterThan(50);
    } else {
      expect.fail(`rateLimited を期待したが: ${JSON.stringify(result)}`);
    }
  });

  it("トークン未設定時はunauthorizedを返す", async () => {
    mock = await startMockQiita({ validToken: "valid-token" });
    const client = makeClient(mock.url, null);
    const result = await client.createItem({
      title: "t",
      body: "b",
      tags: [{ name: "t" }],
      private: true,
      tweet: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unauthorized");
  });
});

describe("QiitaApiClient.updateItem(article-upload-sync 3.3, 5.3)", () => {
  it("PATCH /items/:id で本文を更新し、公開範囲を常に明示送信する(5.3)", async () => {
    mock = await startMockQiita({
      items: [makeRawItem({ id: "a1", title: "既存記事", private: false })],
      validToken: "valid-token",
    });
    const client = makeClient(mock.url);
    const result = await client.updateItem("a1", {
      title: "既存記事",
      body: "# 更新後の本文",
      tags: [{ name: "test" }],
      private: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("a1");
    expect(result.value.body).toBe("# 更新後の本文");
    expect(result.value.private).toBe(false); // 公開範囲は変更されない

    const req = mock.writeRequests[0]!;
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe("/api/v2/items/a1");
    expect(req.body["title"]).toBe("既存記事"); // PATCH必須項目を常に送信
    expect(req.body["private"]).toBe(false); // 省略せず明示送信(5.3)
  });

  it("ネットワークエラーをnetworkとして返す(9.2)", async () => {
    const client = makeClient("http://127.0.0.1:1/api/v2");
    const result = await client.updateItem("a1", {
      title: "t",
      body: "b",
      tags: [],
      private: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("network");
  });

  it("サーバエラー(5xx)をserverとして返す", async () => {
    mock = await startMockQiita({
      items: [makeRawItem({ id: "a1" })],
      validToken: "valid-token",
      writeFailFirstN: { count: 1, status: 502 },
    });
    const client = makeClient(mock.url);
    const result = await client.updateItem("a1", {
      title: "t",
      body: "b",
      tags: [],
      private: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "server") {
      expect(result.error.status).toBe(502);
    } else {
      expect.fail(`server を期待したが: ${JSON.stringify(result)}`);
    }
  });
});
