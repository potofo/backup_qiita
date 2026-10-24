/**
 * 接続確認サービス(3.1 / article-upload-sync 6.1〜6.4)
 * - 設定由来トークンまたは画面入力トークンの検証と保存判断を統括する(1.2〜1.8)
 * - 書き込み権限(writeAccess)を実績ベースで管理する(スコープ照会APIが存在しないため。
 *   成功→granted / 403→denied、トークン変更で unknown へリセット)
 * - 保存経路は EnvFileConfig.persistToken の1本のみ(steering security.md)
 */
import type {
  ConnectionError,
  ConnectionOk,
  ConnectionStatus,
  Result,
  WriteAccess,
} from "../types/index.js";
import { ok, err } from "../types/index.js";
import type { QiitaApiClient } from "../infra/qiitaApiClient.js";
import type { TokenStore } from "../config/tokenStore.js";
import type { EnvFileConfig } from "../config/env.js";
import type { Logger } from "../config/logger.js";

export interface AuthService {
  status(): ConnectionStatus;
  verify(input: { token?: string; save?: boolean }): Promise<Result<ConnectionOk, ConnectionError>>;
  /** 書き込み権限の実績種別(upload-sync 6.2: denied既知時はRun開始前に拒否できる) */
  writeAccess(): WriteAccess;
  /** アップロードRunからの書き込み結果報告(成功→granted / 403→denied — upload-sync 6.4) */
  reportWriteResult(result: "granted" | "denied"): void;
}

export class AuthServiceImpl implements AuthService {
  private current: ConnectionStatus;
  /** 書き込み権限の実績ベース管理(article-upload-sync 6.1〜6.4)。メモリのみ・永続化しない */
  private write: WriteAccess = "unknown";

  constructor(
    private readonly client: QiitaApiClient,
    private readonly tokenStore: TokenStore,
    private readonly envConfig: EnvFileConfig,
    private readonly logger?: Logger,
  ) {
    this.current = { state: "unchecked", maskedToken: tokenStore.maskedTail(), writeAccess: this.write };
  }

  status(): ConnectionStatus {
    return { ...this.current, writeAccess: this.write };
  }

  writeAccess(): WriteAccess {
    return this.write;
  }

  reportWriteResult(result: "granted" | "denied"): void {
    this.write = result;
    this.logger?.info("書き込み権限の実績を更新しました", { writeAccess: result });
  }

  async verify(input: {
    token?: string;
    save?: boolean;
  }): Promise<Result<ConnectionOk, ConnectionError>> {
    const token = input.token?.trim() || this.tokenStore.get();
    if (!token) {
      this.current = { state: "invalid", reason: "missing", maskedToken: null, writeAccess: this.write };
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
          writeAccess: this.write,
        };
        this.logger?.warn("トークンの検証に失敗しました", { reason: error.kind });
        return err({ kind: error.kind });
      }
      if (error.kind === "network") return err({ kind: "network", cause: error.cause });
      if (error.kind === "server") return err({ kind: "server", status: error.status });
      // rateLimited: 接続確認では待機せずサーバエラー扱いで返す
      return err({ kind: "server", status: 429 });
    }

    // 検証成功時のみメモリのトークンを更新する(8.1)。
    // トークンが変わった場合は書き込み権限の実績を未確認へリセットする(upload-sync 6.4)
    if (this.tokenStore.get() !== token) {
      this.write = "unknown";
    }
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
      writeAccess: this.write,
    };
    this.logger?.info("接続確認に成功しました", {
      userId: result.value.id,
      itemsCount: result.value.itemsCount,
      savedToEnv,
    });
    return ok({ userId: result.value.id, itemsCount: result.value.itemsCount, savedToEnv });
  }
}
