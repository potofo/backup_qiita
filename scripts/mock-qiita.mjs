// 開発・E2E・性能検証用のスタンドアロン モックQiitaサーバ
//   - GET /api/v2/authenticated_user / GET /api/v2/authenticated_user/items(ページング対応)
//   - GET /img/{name}.png … 1x1 PNG を返す画像ホスト(認証不要)
// 環境変数: PORT(既定4510) / ARTICLE_COUNT(既定5) / IMAGES_PER_ARTICLE(既定2) / MOCK_TOKEN(既定 mock-token)
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4510);
const ARTICLE_COUNT = Number(process.env.ARTICLE_COUNT ?? 5);
const IMAGES_PER_ARTICLE = Number(process.env.IMAGES_PER_ARTICLE ?? 2);
const MOCK_TOKEN = process.env.MOCK_TOKEN ?? "mock-token";

// 1x1 透過PNG
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const origin = `http://127.0.0.1:${PORT}`;

const makeItem = (i) => {
  const id = `mock${String(i).padStart(4, "0")}`;
  const images = Array.from(
    { length: IMAGES_PER_ARTICLE },
    (_, k) => `![図${k + 1}](${origin}/img/${id}-${k + 1}.png)`,
  ).join("\n\n");
  return {
    id,
    title: `モック記事 ${i + 1}: ローカルWebツールの作り方`,
    body: `# モック記事 ${i + 1}\n\nこれはテスト用の本文です。\n\n${images}\n\n<img src="${origin}/img/${id}-tag.png" width="400">\n\n以上。`,
    url: `https://qiita.com/mockuser/items/${id}`,
    created_at: "2026-06-01T10:00:00+09:00",
    updated_at: `2026-07-${String((i % 11) + 1).padStart(2, "0")}T12:00:00+09:00`,
    private: i % 5 === 0,
    tags: [{ name: "mock", versions: [] }, { name: "test", versions: [] }],
    comments_count: i % 7,
    likes_count: (i * 3) % 50,
    stocks_count: (i * 2) % 40,
  };
};

const items = Array.from({ length: ARTICLE_COUNT }, (_, i) => makeItem(i));

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", origin);

  // 画像ホスト(認証不要 — Authorizationが来たら警告)
  if (url.pathname.startsWith("/img/")) {
    if (req.headers.authorization) {
      console.error(`[mock] 警告: 画像リクエストにAuthorizationヘッダが付与されています! ${url.pathname}`);
    }
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG_BYTES);
    return;
  }

  const sendJson = (status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  if (req.headers.authorization !== `Bearer ${MOCK_TOKEN}`) {
    sendJson(401, { message: "Unauthorized", type: "unauthorized" });
    return;
  }

  if (url.pathname === "/api/v2/authenticated_user") {
    sendJson(200, { id: "mockuser", items_count: items.length });
    return;
  }

  if (url.pathname === "/api/v2/authenticated_user/items") {
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "20");
    const start = (page - 1) * perPage;
    const headers = { "total-count": String(items.length) };
    if (start + perPage < items.length) {
      headers["link"] = `<${origin}/api/v2/authenticated_user/items?page=${page + 1}&per_page=${perPage}>; rel="next"`;
    }
    sendJson(200, items.slice(start, start + perPage), headers);
    return;
  }

  sendJson(404, { message: "Not Found", type: "not_found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`モックQiitaサーバ起動: ${origin} (記事${ARTICLE_COUNT}件 / 画像${IMAGES_PER_ARTICLE + 1}枚/記事)`);
  console.log(`トークン: ${MOCK_TOKEN}`);
});
