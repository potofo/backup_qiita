/**
 * サーバ起動エントリポイント(7.1, 8.3, 10.1, 10.3)
 * - ループバックアドレス(127.0.0.1)のみで待ち受ける(8.3)
 * - 起動時にアクセスURLをコンソールへ表示する(7.1)
 */
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
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
  const { LocalArticleScannerImpl } = await import("../infra/localArticleScanner.js");
  const { createGitManager } = await import("../infra/gitManager.js");
  const { AuthServiceImpl } = await import("../services/authService.js");
  const { StateStoreImpl } = await import("../services/stateStore.js");
  const { BackupServiceImpl } = await import("../services/backupService.js");
  const { UploadServiceImpl } = await import("../services/uploadService.js");
  const { createRunCoordinator } = await import("../services/runCoordinator.js");
  const { createProgressBus } = await import("../services/progressBus.js");
  const { createApiRouter } = await import("./routes.js");
  const { ImageUploadSettingsStoreImpl } = await import("../infra/imageUploadSettingsStore.js");
  const { BrowserImageUploaderImpl } = await import("../infra/browserImageUploader.js");
  const { ImageMapStoreImpl } = await import("../infra/imageMapStore.js");
  const { ImageUploadPlannerImpl } = await import("../services/imageUploadPlanner.js");
  const { ImageUploadServiceImpl } = await import("../services/imageUploadService.js");

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
  // バックアップ/アップロードのRun排他を共有する(upload-sync 8.4)
  const runCoordinator = createRunCoordinator();
  const scanner = new LocalArticleScannerImpl(storageManager, logger);
  const backupService = new BackupServiceImpl({
    qiitaClient,
    imageDownloader,
    storageManager,
    gitManager,
    stateStore,
    progressBus,
    runCoordinator,
    logger,
  });
  // 画像アップロード機能(image-upload-automation)。設定とブラウザプロファイルは backups/ の外に置く(5.2)
  const imageSettingsStore = new ImageUploadSettingsStoreImpl(resolve(process.cwd(), ".image-upload"), { logger });
  // ブラウザ操作部品にはアクセストークンを渡さない(11.2)
  const editorUploader = new BrowserImageUploaderImpl({
    persistentProfileDir: imageSettingsStore.profileDir(),
    logger,
  });
  const imageAvailability = await editorUploader.availability(); // 1.3: 起動時に一度だけ確かめる
  if (!imageAvailability.available) {
    logger.info("画像アップロード機能は利用できません(任意機能)", { reason: imageAvailability.reason });
  }
  const imageMapStore = new ImageMapStoreImpl(storageManager);
  const uploadService = new UploadServiceImpl({
    qiitaClient,
    storageManager,
    gitManager,
    stateStore,
    progressBus,
    runCoordinator,
    scanner,
    authService,
    imageUpload: {
      planner: new ImageUploadPlannerImpl({ storageManager, imageMapStore }),
      service: new ImageUploadServiceImpl({
        uploader: editorUploader,
        imageMapStore,
        progressBus,
        settingsStore: imageSettingsStore,
        logger,
      }),
      isEnabled: () => imageAvailability.available && imageSettingsStore.get().enabled,
    },
    logger,
  });

  const apiRouter = createApiRouter({
    authService,
    stateStore,
    backupService,
    uploadService,
    scanner,
    storageManager,
    gitManager,
    qiitaClient,
    progressBus,
    logger,
    imageUpload: { settingsStore: imageSettingsStore, availability: () => imageAvailability },
  });

  const app = createApp({
    publicDir: resolve(process.cwd(), "public"),
    logger,
    apiRouter,
  });

  const server = await startServer(app, config.serverPort, logger);

  // npm stop 用のPIDファイル(scripts/stop-server.mjs が参照する)
  const pidPath = resolve(process.cwd(), ".server.pid");
  writeFileSync(pidPath, String(process.pid), "utf8");
  const removePidFile = (): void => {
    try {
      unlinkSync(pidPath);
    } catch {
      // 既に削除済みなら何もしない
    }
  };
  process.on("exit", removePidFile);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info("停止シグナルを受信しました。サーバを終了します", { signal });
      server.close();
      removePidFile();
      process.exit(0);
    });
  }

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
