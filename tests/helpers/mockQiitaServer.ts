/**
 * テスト用モックQiita APIサーバ
 * - GET /api/v2/authenticated_user と GET /api/v2/authenticated_user/items を模擬する
 * - Linkヘッダによるページング、429(Rate-Reset)、5xxの注入に対応
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
};

export type MockQiitaServer = {
  url: string;
  server: Server;
  /** 受信した Authorization ヘッダの記録(漏洩チェック用) */
  authHeaders: string[];
  /** /items リクエスト数 */
  itemRequestCount: () => number;
  setItems: (items: RawQiitaItem[]) => void;
  close: () => Promise<void>;
};

export async function startMockQiita(options: MockQiitaOptions = {}): Promise<MockQiitaServer> {
  let items = options.items ?? [];
  const authHeaders: string[] = [];
  let itemRequests = 0;
  let rateLimitRemaining = options.rateLimitFirstN?.count ?? 0;
  let failRemaining = options.failFirstN?.count ?? 0;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
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

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");

  return {
    url: `http://127.0.0.1:${address.port}/api/v2`,
    server,
    authHeaders,
    itemRequestCount: () => itemRequests,
    setItems: (next) => {
      items = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
