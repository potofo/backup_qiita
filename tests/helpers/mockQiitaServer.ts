/**
 * テスト用モックQiita APIサーバ
 * - GET /api/v2/authenticated_user と GET /api/v2/authenticated_user/items を模擬する
 * - POST /api/v2/items(201)と PATCH /api/v2/items/:id(200)を模擬する(article-upload-sync 1.2)
 * - Linkヘッダによるページング、429(Rate-Reset)、403(スコープ不足)、5xxの注入に対応
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export type RawQiitaItem = {
  id: string;
  title: string;
  body: string;
  url: string;
  created_at: string;
  updated_at: string;
  private: boolean;
  tags: { name: string; versions: string[] }[];
  comments_count: number;
  likes_count: number;
  stocks_count: number;
};

export function makeRawItem(overrides: Partial<RawQiitaItem> & { id: string }): RawQiitaItem {
  return {
    title: `記事 ${overrides.id}`,
    body: `# 記事 ${overrides.id}\n\n本文です。`,
    url: `https://qiita.com/testuser/items/${overrides.id}`,
    created_at: "2026-01-01T10:00:00+09:00",
    updated_at: "2026-01-01T10:00:00+09:00",
    private: false,
    tags: [{ name: "test", versions: [] }],
    comments_count: 0,
    likes_count: 0,
    stocks_count: 0,
    ...overrides,
  };
}

export type MockQiitaOptions = {
  items?: RawQiitaItem[];
  userId?: string;
  /** このトークン以外は401を返す。省略時は任意のBearerトークンを受け付ける */
  validToken?: string;
  /** /items への最初のN回のリクエストに429を返す。resetAfterSec 秒後のUNIX時刻を Rate-Reset で返す */
  rateLimitFirstN?: { count: number; resetAfterSec: number };
  /** /items への最初のN回のリクエストに指定ステータス(5xx等)を返す */
  failFirstN?: { count: number; status: number };
  /** 書き込み(POST/PATCH)を常に403(スコープ不足)にする */
  writeForbidden?: boolean;
  /** 書き込みへの最初のN回のリクエストに429を返す(Rate-Reset付き) */
  writeRateLimitFirstN?: { count: number; resetAfterSec: number };
  /** 書き込みへの最初のN回のリクエストに指定ステータス(5xx等)を返す */
  writeFailFirstN?: { count: number; status: number };
};

/** 受信した書き込みリクエストの記録(検証用 — article-upload-sync 1.2) */
export type WriteRequest = {
  method: string;
  path: string;
  body: Record<string, unknown>;
};

export type MockQiitaServer = {
  url: string;
  server: Server;
  /** 受信した Authorization ヘッダの記録(漏洩チェック用) */
  authHeaders: string[];
  /** /items リクエスト数 */
  itemRequestCount: () => number;
  /** 受信した書き込み(POST/PATCH)の内容(タイトル・本文・タグ・公開範囲の検証用) */
  writeRequests: WriteRequest[];
  setItems: (items: RawQiitaItem[]) => void;
  close: () => Promise<void>;
};

/** リクエストボディのJSONを読み取る */
const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
    req.on("error", reject);
  });

export async function startMockQiita(options: MockQiitaOptions = {}): Promise<MockQiitaServer> {
  let items = options.items ?? [];
  const authHeaders: string[] = [];
  const writeRequests: WriteRequest[] = [];
  let itemRequests = 0;
  let createdCount = 0;
  let rateLimitRemaining = options.rateLimitFirstN?.count ?? 0;
  let failRemaining = options.failFirstN?.count ?? 0;
  let writeRateLimitRemaining = options.writeRateLimitFirstN?.count ?? 0;
  let writeFailRemaining = options.writeFailFirstN?.count ?? 0;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = req.headers.authorization ?? "";
    authHeaders.push(auth);

    const sendJson = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    if (options.validToken !== undefined && auth !== `Bearer ${options.validToken}`) {
      sendJson(401, { message: "Unauthorized", type: "unauthorized" });
      return;
    }
    if (!auth.startsWith("Bearer ")) {
      sendJson(401, { message: "Unauthorized", type: "unauthorized" });
      return;
    }

    if (url.pathname === "/api/v2/authenticated_user") {
      sendJson(200, { id: options.userId ?? "testuser", items_count: items.length });
      return;
    }

    // ---- 書き込みエンドポイント(article-upload-sync 1.2) ---------------------
    const isCreate = req.method === "POST" && url.pathname === "/api/v2/items";
    const patchMatch =
      req.method === "PATCH" ? /^\/api\/v2\/items\/([^/]+)$/.exec(url.pathname) : null;
    if (isCreate || patchMatch) {
      const body = await readBody(req);
      writeRequests.push({ method: req.method ?? "", path: url.pathname, body });

      // シナリオ注入: 403(スコープ不足)/ 429(Rate-Reset付き)/ 5xx
      if (options.writeForbidden) {
        sendJson(403, { message: "Insufficient token scope", type: "forbidden" });
        return;
      }
      if (writeRateLimitRemaining > 0) {
        writeRateLimitRemaining -= 1;
        const resetAt = Math.ceil(Date.now() / 1000) + (options.writeRateLimitFirstN?.resetAfterSec ?? 1);
        sendJson(
          429,
          { message: "Rate limit exceeded", type: "rate_limit_exceeded" },
          { "rate-remaining": "0", "rate-reset": String(resetAt) },
        );
        return;
      }
      if (writeFailRemaining > 0) {
        writeFailRemaining -= 1;
        sendJson(options.writeFailFirstN?.status ?? 500, { message: "Internal Server Error", type: "error" });
        return;
      }

      const now = new Date().toISOString();
      const tags = Array.isArray(body["tags"]) ? (body["tags"] as { name: string }[]) : [];
      if (isCreate) {
        // 新規登録: 限定共有フラグを反映して201でItemを返す
        createdCount += 1;
        const id = `created${String(createdCount).padStart(4, "0")}`;
        const created: RawQiitaItem = {
          id,
          title: String(body["title"] ?? ""),
          body: String(body["body"] ?? ""),
          url: `https://qiita.com/testuser/items/${id}`,
          created_at: now,
          updated_at: now,
          private: Boolean(body["private"]),
          tags: tags.map((t) => ({ name: t.name, versions: [] })),
          comments_count: 0,
          likes_count: 0,
          stocks_count: 0,
        };
        items = [...items, created];
        sendJson(201, created);
        return;
      }

      // 更新: 200で更新後Itemを返す
      const itemId = patchMatch![1]!;
      const existing = items.find((i) => i.id === itemId);
      if (!existing) {
        sendJson(404, { message: "Not Found", type: "not_found" });
        return;
      }
      existing.title = String(body["title"] ?? existing.title);
      existing.body = String(body["body"] ?? existing.body);
      if (Array.isArray(body["tags"])) {
        existing.tags = tags.map((t) => ({ name: t.name, versions: [] }));
      }
      if (typeof body["private"] === "boolean") existing.private = body["private"];
      existing.updated_at = now;
      sendJson(200, existing);
      return;
    }

    if (url.pathname === "/api/v2/authenticated_user/items") {
      itemRequests += 1;
      if (rateLimitRemaining > 0) {
        rateLimitRemaining -= 1;
        const resetAt = Math.ceil(Date.now() / 1000) + (options.rateLimitFirstN?.resetAfterSec ?? 1);
        sendJson(
          429,
          { message: "Rate limit exceeded", type: "rate_limit_exceeded" },
          { "rate-remaining": "0", "rate-reset": String(resetAt) },
        );
        return;
      }
      if (failRemaining > 0) {
        failRemaining -= 1;
        sendJson(options.failFirstN?.status ?? 500, { message: "Internal Server Error", type: "error" });
        return;
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "20");
      const start = (page - 1) * perPage;
      const pageItems = items.slice(start, start + perPage);
      const headers: Record<string, string> = { "total-count": String(items.length) };
      if (start + perPage < items.length) {
        headers["link"] = `<http://localhost/api/v2/authenticated_user/items?page=${page + 1}&per_page=${perPage}>; rel="next"`;
      }
      sendJson(200, pageItems, headers);
      return;
    }

    sendJson(404, { message: "Not Found", type: "not_found" });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "mock handler error", type: "error" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");

  return {
    url: `http://127.0.0.1:${address.port}/api/v2`,
    server,
    authHeaders,
    itemRequestCount: () => itemRequests,
    writeRequests,
    setItems: (next) => {
      items = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
