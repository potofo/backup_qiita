/**
 * 性能検証スクリプト(タスク6.3 / N-PERF-01)
 * - 記事300件・画像10枚/記事(計3,000枚)相当のモックQiitaサーバをインプロセスで起動し、
 *   実運用と同じ画像取得間隔(300ms)で全件バックアップの所要時間を計測する
 * - 目標: 30分以内。結果は .kiro/specs/qiita-backup-tool/perf-report.md に記録する
 *
 * 実行: npm run perf
 */
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BackupServiceImpl } from "../services/backupService.js";
import { StateStoreImpl } from "../services/stateStore.js";
import { createProgressBus } from "../services/progressBus.js";
import { QiitaApiClientImpl } from "../infra/qiitaApiClient.js";
import { ImageDownloaderImpl } from "../infra/imageDownloader.js";
import { StorageManagerImpl } from "../infra/storageManager.js";
import { createGitManager } from "../infra/gitManager.js";
import { createTokenStore } from "../config/tokenStore.js";

const ARTICLE_COUNT = Number(process.env["PERF_ARTICLES"] ?? 300);
const IMAGES_PER_ARTICLE = Number(process.env["PERF_IMAGES"] ?? 10);
const TARGET_MINUTES = 30;

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function startMockServer(): Promise<{ baseUrl: string; origin: string; close: () => void }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/img/")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG_BYTES);
      return;
    }
    if (url.pathname === "/api/v2/authenticated_user") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "perfuser", items_count: ARTICLE_COUNT }));
      return;
    }
    if (url.pathname === "/api/v2/authenticated_user/items") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "20");
      const start = (page - 1) * perPage;
      const items = [];
      for (let i = start; i < Math.min(start + perPage, ARTICLE_COUNT); i++) {
        const id = `perf${String(i).padStart(4, "0")}`;
        const images = Array.from(
          { length: IMAGES_PER_ARTICLE },
          (_, k) => `![図${k + 1}](${origin}/img/${id}-${k + 1}.png)`,
        ).join("\n\n");
        items.push({
          id,
          title: `性能検証記事 ${i + 1}`,
          body: `# 性能検証記事 ${i + 1}\n\n${images}\n`,
          url: `https://qiita.com/perfuser/items/${id}`,
          created_at: "2026-06-01T10:00:00+09:00",
          updated_at: "2026-07-01T12:00:00+09:00",
          private: false,
          tags: [{ name: "perf" }],
          comments_count: 0,
          likes_count: 0,
          stocks_count: 0,
        });
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "total-count": String(ARTICLE_COUNT),
      };
      if (start + perPage < ARTICLE_COUNT) {
        headers["link"] = `<${origin}/api/v2/authenticated_user/items?page=${page + 1}&per_page=${perPage}>; rel="next"`;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(items));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const origin = `http://127.0.0.1:${address.port}`;
  return { baseUrl: `${origin}/api/v2`, origin, close: () => server.close() };
}

let origin = "";

async function main(): Promise<void> {
  const mock = await startMockServer();
  origin = mock.origin;

  const root = join(mkdtempSync(join(tmpdir(), "qbt-perf-")), "backup");
  console.log(`性能検証開始: 記事${ARTICLE_COUNT}件 × 画像${IMAGES_PER_ARTICLE}枚 = 画像計${ARTICLE_COUNT * IMAGES_PER_ARTICLE}枚`);
  console.log(`バックアップ先: ${root}`);

  const tokenStore = createTokenStore("perf-token");
  const storage = new StorageManagerImpl(root);
  const stateStore = new StateStoreImpl(storage);
  await stateStore.loadIndex();
  const gitManager = await createGitManager(root);
  const bus = createProgressBus();
  bus.subscribe((e) => {
    if (e.type === "progress" && e.done > 0 && e.done % 25 === 0) {
      console.log(`  進捗: ${e.done}/${e.total}件 (${new Date().toLocaleTimeString("ja-JP")})`);
    }
  });

  const backup = new BackupServiceImpl({
    qiitaClient: new QiitaApiClientImpl(tokenStore, { baseUrl: mock.baseUrl }),
    imageDownloader: new ImageDownloaderImpl(), // 実運用と同じ300ms間隔
    storageManager: storage,
    gitManager,
    stateStore,
    progressBus: bus,
  });

  const startedAt = Date.now();
  const started = backup.start({ mode: "all" });
  if (!started.ok) throw new Error(`Run開始失敗: ${JSON.stringify(started.error)}`);
  const summary = await started.value.done;
  const elapsedMs = Date.now() - startedAt;
  mock.close();

  const elapsedMin = elapsedMs / 60_000;
  const passed = elapsedMin <= TARGET_MINUTES && summary.failed === 0;
  console.log("");
  console.log(`所要時間: ${(elapsedMs / 1000).toFixed(1)}秒(${elapsedMin.toFixed(2)}分)`);
  console.log(`結果: 成功${summary.succeeded}件 / 失敗${summary.failed}件 / 画像失敗${summary.imageFailures.length}件`);
  console.log(`判定: ${passed ? `合格(目標${TARGET_MINUTES}分以内)` : "不合格"}`);

  const report = `# 性能検証結果(タスク6.3 / N-PERF-01)

- 実施日時: ${new Date().toLocaleString("ja-JP")}
- 実行環境: Windows 11 / Node.js ${process.version}(モックQiitaサーバ・ローカルループバック)

## 条件

| 項目 | 値 |
|---|---|
| 記事数 | ${ARTICLE_COUNT}件 |
| 画像数 | ${IMAGES_PER_ARTICLE}枚/記事(計${ARTICLE_COUNT * IMAGES_PER_ARTICLE}枚) |
| 画像取得間隔 | 300ms(実運用と同一の直列ダウンロード) |
| モード | 全件バックアップ(Gitコミット含む) |

## 結果

| 項目 | 値 |
|---|---|
| 所要時間 | ${(elapsedMs / 1000).toFixed(1)}秒(${elapsedMin.toFixed(2)}分) |
| 成功 | ${summary.succeeded}件 |
| 失敗 | ${summary.failed}件 |
| 画像取得失敗 | ${summary.imageFailures.length}件 |
| 目標(30分以内) | **${passed ? "合格" : "不合格"}** |

${passed ? "画像取得間隔・並列度の調整は不要。" : "目標超過のため、画像取得間隔・並列度の調整を検討すること。"}
`;
  const reportPath = resolve(process.cwd(), ".kiro/specs/qiita-backup-tool/perf-report.md");
  writeFileSync(reportPath, report, "utf8");
  console.log(`レポートを保存しました: ${reportPath}`);
  process.exit(passed ? 0 : 1);
}

main().catch((cause) => {
  console.error("性能検証に失敗しました:", cause);
  process.exit(1);
});
