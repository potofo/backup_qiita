/**
 * 接続確認サービス(3.1)
 * - 設定由来トークンまたは画面入力トークンの検証と保存判断を統括する(1.2〜1.8)
 * - 保存経路は EnvFileConfig.persistToken の1本のみ(steering security.md)
 */
import type { ConnectionError, ConnectionOk, ConnectionStatus, Result } from "../types/index.js";
import { ok, err } from "../types/index.js";
import type { QiitaApiClient } from "../infra/qiitaApiClient.js";
import type { TokenStore } from "../config/tokenStore.js";
import type { EnvFileConfig } from "../config/env.js";
import type { Logger } from "../config/logger.js";

export interface AuthService {
  status(): ConnectionStatus;
  verify(input: { token?: string; save?: boolean }): Promise<Result<ConnectionOk, ConnectionError>>;
}

export class AuthServiceImpl implements AuthService {
  private current: ConnectionStatus;

  constructor(
    private readonly client: QiitaApiClient,
    private readonly tokenStore: TokenStore,
    private readonly envConfig: EnvFileConfig,
    private readonly logger?: Logger,
  ) {
    this.current = { state: "unchecked", maskedToken: tokenStore.maskedTail() };
  }

  status(): ConnectionStatus {
    return this.current;
  }

  async verify(input: {
    token?: string;
    save?: boolean;
  }): Promise<Result<ConnectionOk, ConnectionError>> {
    const token = input.token?.trim() || this.tokenStore.get();
    if (!token) {
      this.current = { state: "invalid", reason: "missing", maskedToken: null };
      return err({ kind: "missing" });
    }

    const result = await this.client.verifyToken(token);
    if (!result.ok) {
      const error = result.error;
      if (error.kind === "unauthorized" || error.kind === "forbidden") {
        this.current = {
          state: "invalid",
          reason: error.kind,
          maskedToken: this.tokenStore.maskedTail(),
        };
        this.logger?.warn("トークンの検証に失敗しました", { reason: error.kind });
        return err({ kind: error.kind });
      }
      if (error.kind === "network") return err({ kind: "network", cause: error.cause });
      if (error.kind === "server") return err({ kind: "server", status: error.status });
      // rateLimited: 接続確認では待機せずサーバエラー扱いで返す
      return err({ kind: "server", status: 429 });
    }

    // 検証成功時のみメモリのトークンを更新する(8.1)
    this.tokenStore.set(token);

    let savedToEnv = false;
    if (input.save === true) {
      const persisted = this.envConfig.persistToken(token); // 1.6 同意時のみ
      savedToEnv = persisted.ok;
      if (!persisted.ok) {
        this.logger?.error(".envへのトークン保存に失敗しました", {
          message: persisted.error.message,
        });
      }
    }

    this.current = {
      state: "connected",
      userId: result.value.id,
      itemsCount: result.value.itemsCount,
      maskedToken: this.tokenStore.maskedTail(),
    };
    this.logger?.info("接続確認に成功しました", {
      userId: result.value.id,
      itemsCount: result.value.itemsCount,
      savedToEnv,
    });
    return ok({ userId: result.value.id, itemsCount: result.value.itemsCount, savedToEnv });
  }
}
