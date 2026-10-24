# Technology Stack

## Architecture

レイヤードなローカルWebアプリケーション。単一のNode.jsプロセスが
Express HTTPサーバ(ループバックのみ)+ SSEによる進捗配信 + 静的フロントエンドを提供する。

```
web(ブラウザ) → http(Express/SSE) → services(ドメインロジック) → infra(外部I/O) → config/types
```

- 依存方向は上から下への一方向。組み立て(DI)は `src/http/server.ts` の `main()` が担う
- フロントエンドはフレームワークなしのTypeScript(esbuildでIIFEにバンドルし `public/` へ出力)

## Core Technologies

- **Language**: TypeScript(strict)
- **Runtime**: Node.js 24+、ESM(`"type": "module"` + NodeNext)
- **Server**: Express 5
- **Git操作**: simple-git
- **依存は最小主義**: 実行時依存は express / simple-git / dotenv の3つのみ。安易に追加しない
- **任意依存**: `playwright-core`(画像アップロード機能専用 — image-upload-automation)。`optionalDependencies` に置き、
  ブラウザ本体は同梱せず既存の Edge / Chrome を起動する。import してよいのは `src/infra/browserImageUploader.ts` のみ(動的 import)。
  未導入でも本体は動作し、画像アップロード機能だけが「利用不可」になる

## Development Standards

### Type Safety
- `strict` に加え `noUncheckedIndexedAccess` / `noImplicitOverride` を有効化
- ドメインエラーは例外ではなく **`Result<T, E>` 型**(`src/types/index.ts` の `ok`/`err`)で返す
- エラー型は `kind` を判別子とするユニオンで表現する(例: `ApiError = { kind: "unauthorized" } | ...`)
- 型のみの参照は `import type` を使う

### DI パターン
- 各モジュールは `interface` を公開し、実装は `XxxImpl` クラスまたは `createXxx()` ファクトリ
- 依存は `Deps` 型のオブジェクト1つで受け取る。`logger` はオプショナル(テストで省略可能)

### Testing
- **vitest**。`tests/{モジュール名}.test.ts` にユニット+統合テストを置く
- 外部依存はモックサーバで代替: `tests/helpers/mockQiitaServer.ts` / `mockImageHost.ts`。
  開発時の手動確認は `scripts/mock-qiita.mjs`(`QIITA_API_BASE_URL` で接続先を差し替え)
- 実Qiitaへ接続するテストは書かない(レート制限とデータ汚染防止)

### ログ・コメント
- ログは `createFileLogger`(`logs/` 配下)。トークン全文・Authorizationヘッダは出力禁止([security.md](security.md))
- ソースコメントは日本語。ファイル先頭のJSDocに責務と設計書の節番号・要件ID(例: `(3.12)`, `F-BK-12`)を記す

## Development Environment

### Required Tools
- Node.js 24+ / npm、Git(任意 — 無くても世代管理なしで動作)

### Common Commands
```powershell
npm start          # ビルド+起動(http://localhost:3000)
npm test           # vitest(ユニット+統合)
npm run typecheck  # tscの型チェックのみ
npm run perf       # 性能テスト(モック300記事×画像10枚)
node scripts/mock-qiita.mjs  # 開発用モックQiitaサーバ(token: mock-token)
```

### 環境固有の注意(Windows)
- この開発環境では `fs.rmSync(..., { force: true })` が黙って失敗することがある。
  ファイル削除は `unlinkSync` を使う(既存コードもこの慣習に従っている)

## Key Technical Decisions

- **Qiita API v2のみ**: スクレイピング禁止。バックアップは読み取り専用、書き込みは明示的な
  アップロード操作に限定(DELETEなし)。詳細は [qiita-api.md](qiita-api.md)
- **ビルドの二本立て**: サーバ側は `tsc`(`src/web` は除外)、フロントは esbuild(`scripts/build-web.mjs`)。
  フロントに新規ファイルを足す場合は esbuild のバンドル対象(`src/web/main.ts` からの参照)に含める
- **進捗はSSE**: WebSocketではなくServer-Sent Events(`progressBus`)で単方向配信
- **同時実行は1 Run**: バックアップ/アップロードを通じて常に1件に制限(`RunCoordinator` が排他を統括)

---
_標準とパターンを記す。依存の全列挙はしない_
