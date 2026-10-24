/**
 * Qiita API v2 クライアント(1.2, 2.1, 3.12 / article-upload-sync 3.2, 3.3, 5.1, 5.3, 8.2)
 * - 読み取り: GET /authenticated_user と GET /authenticated_user/items
 * - 書き込み: POST /items(新規・常に限定共有)と PATCH /items/:id(更新・公開範囲を明示送信)。
 *   DELETEメソッドは実装しない(article-upload-sync 8.2)
 * - Authorization ヘッダはこのクライアントのみが付与する(8.1)。画像取得とは共有しない(8.5)
 */
import type {
  ApiError,
  AuthenticatedUser,
  CreateItemInput,
  QiitaItem,
  Result,
  UpdateItemInput,
} from "../types/index.js";
import { ok, err } from "../types/index.js";
import type { TokenStore } from "../config/tokenStore.js";
import type { Logger } from "../config/logger.js";

export interface QiitaApiClient {
  verifyToken(token: string): Promise<Result<AuthenticatedUser, ApiError>>;
  fetchAllItems(onPage?: (fetched: number, total: number) => void): Promise<Result<QiitaItem[], ApiError>>;
  /** 記事の新規登録(article-upload-sync 3.2)。常に限定共有(5.1) */
  createItem(input: CreateItemInput): Promise<Result<QiitaItem, ApiError>>;
  /** 記事の更新(article-upload-sync 3.3)。公開範囲は常に明示送信(5.3) */
  updateItem(itemId: string, input: UpdateItemInput): Promise<Result<QiitaItem, ApiError>>;
}

const PER_PAGE = 100;
const MAX_PAGES = 100; // Qiita API仕様上の上限(10,000件)

type ClientOptions = {
  baseUrl?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
};

/** Qiita APIのraw(snake_case)レスポンスを共有型へマッピングする */
const toQiitaItem = (raw: Record<string, unknown>): QiitaItem => ({
  id: String(raw["id"]),
  title: String(raw["title"]),
  body: String(raw["body"]),
  url: String(raw["url"]),
  createdAt: String(raw["created_at"]),
  updatedAt: String(raw["updated_at"]),
  private: Boolean(raw["private"]),
  tags: Array.isArray(raw["tags"])
    ? (raw["tags"] as { name: string }[]).map((t) => ({ name: t.name }))
    : [],
  commentsCount: Number(raw["comments_count"] ?? 0),
  likesCount: Number(raw["likes_count"] ?? 0),
  stocksCount: Number(raw["stocks_count"] ?? 0),
});

/** 429レスポンスのRate-Resetヘッダ(UNIX秒)から再開可能時刻を得る */
const parseResetAt = (res: Response): Date => {
  const reset = Number(res.headers.get("rate-reset") ?? "");
  if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000);
  // ヘッダ欠落時のフォールバック: 60秒後
  return new Date(Date.now() + 60_000);
};

const toApiError = (res: Response, message?: string): ApiError => {
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 403) return { kind: "forbidden", ...(message ? { message } : {}) };
  if (res.status === 429) return { kind: "rateLimited", resetAt: parseResetAt(res) };
  return { kind: "server", status: res.status };
};

export class QiitaApiClientImpl implements QiitaApiClient {
  private readonly baseUrl: string;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly tokenStore: TokenStore,
    options: ClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? "https://qiita.com/api/v2";
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async verifyToken(token: string): Promise<Result<AuthenticatedUser, ApiError>> {
    const result = await this.request("/authenticated_user", token);
    if (!result.ok) return result;
    const body = (await result.value.json()) as Record<string, unknown>;
    return ok({ id: String(body["id"]), itemsCount: Number(body["items_count"] ?? 0) });
  }

  async createItem(input: CreateItemInput): Promise<Result<QiitaItem, ApiError>> {
    const token = this.tokenStore.get();
    if (!token) return err({ kind: "unauthorized" });
    // 送信ペイロード(Qiita APIはこの範囲では全キーがそのままsnake_case)
    const result = await this.request("/items", token, { method: "POST", body: input });
    if (!result.ok) return result;
    const raw = (await result.value.json()) as Record<string, unknown>;
    this.logger?.info("記事を新規登録しました", { itemId: String(raw["id"]), status: 201 });
    return ok(toQiitaItem(raw));
  }

  async updateItem(itemId: string, input: UpdateItemInput): Promise<Result<QiitaItem, ApiError>> {
    const token = this.tokenStore.get();
    if (!token) return err({ kind: "unauthorized" });
    const result = await this.request(`/items/${itemId}`, token, { method: "PATCH", body: input });
    if (!result.ok) return result;
    const raw = (await result.value.json()) as Record<string, unknown>;
    this.logger?.info("記事を更新しました", { itemId, status: 200 });
    return ok(toQiitaItem(raw));
  }

  async fetchAllItems(
    onPage?: (fetched: number, total: number) => void,
  ): Promise<Result<QiitaItem[], ApiError>> {
    const token = this.tokenStore.get();
    if (!token) return err({ kind: "unauthorized" });

    const items: QiitaItem[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this.request(
        `/authenticated_user/items?page=${page}&per_page=${PER_PAGE}`,
        token,
      );
      if (!result.ok) return result;
      const res = result.value;
      const rawItems = (await res.json()) as Record<string, unknown>[];
      items.push(...rawItems.map(toQiitaItem));

      const total = Number(res.headers.get("total-count") ?? items.length);
      onPage?.(items.length, Number.isFinite(total) ? total : items.length);

      const link = res.headers.get("link") ?? "";
      if (!/rel="next"/.test(link)) break;
    }
    this.logger?.info("記事一覧を全件取得しました", { count: items.length });
    return ok(items);
  }

  /** 共通リクエスト処理: HTTPエラーをApiErrorへ変換する(GET/POST/PATCH・JSONボディ対応) */
  private async request(
    path: string,
    token: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<Result<Response, ApiError>> {
    let res: Response;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      const init: RequestInit = { method: options.method ?? "GET", headers };
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      this.logger?.warn("Qiita APIへの接続に失敗しました", { path, cause: String(cause) });
      return err({ kind: "network", cause: String(cause) });
    }
    if (!res.ok) {
      // エラーレスポンスの message を取り出す(403の原因案内に使う — トークンは含まれない)
      let apiMessage: string | undefined;
      try {
        const raw = (await res.json()) as Record<string, unknown>;
        if (typeof raw["message"] === "string") apiMessage = raw["message"];
      } catch {
        // JSONでないレスポンスは無視
      }
      this.logger?.warn("Qiita APIがエラーを返しました", { path, status: res.status });
      return err(toApiError(res, apiMessage));
    }
    return ok(res);
  }
}
