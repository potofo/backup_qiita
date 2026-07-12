/**
 * テスト用モック画像ホスト(Camo / S3 相当)
 * - パスごとにContent-Type・レスポンス内容・エラーを設定できる
 * - 受信した Authorization ヘッダを記録する(トークン漏洩チェック用 — 8.5)
 */
import { createServer, type Server } from "node:http";

export type MockImageRoute = {
  contentType?: string;
  body?: Buffer | string;
  status?: number;
};

export type MockImageHost = {
  origin: string;
  authHeaders: (string | undefined)[];
  requestedPaths: string[];
  close: () => Promise<void>;
};

export async function startMockImageHost(
  routes: Record<string, MockImageRoute>,
): Promise<MockImageHost> {
  const authHeaders: (string | undefined)[] = [];
  const requestedPaths: string[] = [];

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    authHeaders.push(req.headers.authorization);
    requestedPaths.push(path);
    const route = routes[path];
    if (!route) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(route.status ?? 200, { "content-type": route.contentType ?? "image/png" });
    res.end(route.body ?? Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    authHeaders,
    requestedPaths,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
