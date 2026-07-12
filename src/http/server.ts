/**
 * サーバ起動エントリポイント(7.1, 8.3, 10.1, 10.3)
 * - ループバックアドレス(127.0.0.1)のみで待ち受ける(8.3)
 * - 起動時にアクセスURLをコンソールへ表示する(7.1)
 */
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Express } from "express";
import { createApp } from "./app.js";
import { createFileLogger, type Logger } from "../config/logger.js";
import { EnvFileConfig } from "../config/env.js";
import { createTokenStore } from "../config/tokenStore.js";

/** ループバックのみでlistenする(8.3) */
export function startServer(app: Express, port: number, logger: Logger): Promise<Server> {
  return new Promise((resolvePromise, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolvePromise(server));
    server.on("error", (cause) => {
      logger.error("サーバの起動に失敗しました", { cause: String(cause) });
      reject(cause);
    });
  });
}

export async function main(): Promise<void> {
  const envPath = resolve(process.cwd(), ".env");
  const envConfig = new EnvFileConfig(envPath);
  const config = envConfig.load();
  const logger = createFileLogger(resolve(process.cwd(), "logs"));

  const tokenStore = createTokenStore(config.tokenFromEnv);
  if (!config.tokenFromEnv) {
    logger.warn("QIITA_ACCESS_TOKEN が未設定です(画面からの入力で補完できます)");
  }

  // 各層のモジュールを組み立てる
  const { QiitaApiClientImpl } = await import("../infra/qiitaApiClient.js");
  const { ImageDownloaderImpl } = await import("../infra/imageDownloader.js");
  const { StorageManagerImpl } = await import("../infra/storageManager.js");
  const { createGitManager } = await import("../infra/gitManager.js");
  const { AuthServiceImpl } = await import("../services/authService.js");
  const { StateStoreImpl } = await import("../services/stateStore.js");
  const { BackupServiceImpl } = await import("../services/backupService.js");
  const { createProgressBus } = await import("../services/progressBus.js");
  const { createApiRouter } = await import("./routes.js");

  const backupRoot = resolve(process.cwd(), config.backupDir);
  const qiitaClient = new QiitaApiClientImpl(tokenStore, {
    logger,
    ...(config.apiBaseUrl ? { baseUrl: config.apiBaseUrl } : {}),
  });
  const imageDownloader = new ImageDownloaderImpl({ logger });
  const storageManager = new StorageManagerImpl(backupRoot, logger);
  const gitManager = await createGitManager(backupRoot, logger);
  if (!gitManager.available) {
    logger.warn("Gitが利用できないため、世代管理なし(最新1世代のみ)で動作します(6.6)");
  }
  const authService = new AuthServiceImpl(qiitaClient, tokenStore, envConfig, logger);
  const stateStore = new StateStoreImpl(storageManager, logger);
  await stateStore.loadIndex();
  const progressBus = createProgressBus();
  const backupService = new BackupServiceImpl({
    qiitaClient,
    imageDownloader,
    storageManager,
    gitManager,
    stateStore,
    progressBus,
    logger,
  });

  const apiRouter = createApiRouter({
    authService,
    stateStore,
    backupService,
    storageManager,
    gitManager,
    qiitaClient,
    progressBus,
    logger,
  });

  const app = createApp({
    publicDir: resolve(process.cwd(), "public"),
    logger,
    apiRouter,
  });

  const server = await startServer(app, config.serverPort, logger);
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : config.serverPort;
  const url = `http://localhost:${port}`;
  console.log("Qiita記事バックアップツールを起動しました。");
  console.log(`ブラウザで次のURLを開いてください: ${url}`);
  logger.info("サーバを起動しました", { url });
}

// 直接実行時のみ起動(テストからのimportでは起動しない)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error("起動に失敗しました:", cause);
    process.exit(1);
  });
}
