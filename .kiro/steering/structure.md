# Project Structure

## Organization Philosophy

レイヤード構成。`src/` 直下のディレクトリが層に対応し、依存は
`http → services → infra → config / types` の一方向のみ。逆方向・層飛ばしの依存を作らない
(唯一の例外: 組み立てを担う `http/server.ts` は全層を知ってよい)。

## Directory Patterns

### 共有型(依存最下層)
**Location**: `src/types/`
**Purpose**: 全層から参照される型と `Result`/`ok`/`err`。ロジックは置かない
**Example**: `QiitaItem`, `ApiError`, `RunSummary`

### 設定・横断機能
**Location**: `src/config/`
**Purpose**: `.env` 読み書き、ロガー、トークン保持
**Example**: `env.ts`, `logger.ts`, `tokenStore.ts`

### 外部I/O(インフラ層)
**Location**: `src/infra/`
**Purpose**: Qiita API・画像ホスト・ファイルシステム・Gitなど、プロセス外との入出力を隔離
**Example**: `qiitaApiClient.ts`, `imageDownloader.ts`, `storageManager.ts`, `gitManager.ts`

### ドメインロジック(サービス層)
**Location**: `src/services/`
**Purpose**: 業務ルール。インフラ層のインターフェースへ依存し、具象は知らない
**Example**: `backupService.ts`(Run統括), `stateStore.ts`(5状態管理), `progressBus.ts`(SSEイベント)

### HTTP境界
**Location**: `src/http/`
**Purpose**: Expressのapp/routes/server。ルートはサービスへ委譲し、ロジックを持たない。
エラーは統一形式 `{ error: { code, message } }`(日本語メッセージ)へ変換する
**Example**: `routes.ts`, `server.ts`(組み立て+起動)

### フロントエンド
**Location**: `src/web/`(ソース)→ `public/`(esbuildの出力先。直接編集しない)
**Purpose**: フレームワークなしのTS+HTML+CSS。`tsconfig.json` の対象外(esbuildがビルド)

### ツールのローカル状態(Git管理外)
**Location**: `.image-upload/`(プロジェクトルート直下)
**Purpose**: 画像アップロード機能の設定(`settings.json`)と、同意時のみ保存するブラウザプロファイル(`browser-profile/`)
**補足**: 新規記事フォルダ直下の `.image-uploads.json` は、記事ID確定前の画像↔URL対応表。登録時に `meta.json.uploadedImages` へ移して削除する

### テスト
**Location**: `tests/`
**Purpose**: `{モジュール名}.test.ts` で対象モジュールと1対1。共有モックは `tests/helpers/`

### ドキュメント
**Location**: `docs/`(正式文書)、`research/`(調査報告)、`.kiro/specs/`(Kiro仕様)
**Purpose**: 配置・版数・要件ID体系は [documentation-standards.md](documentation-standards.md) に従う

## Naming Conventions

- **Files**: camelCase(`backupService.ts`)。テストは `{対象}.test.ts`
- **Interfaces/Types**: PascalCase。実装クラスは `XxxImpl`、ファクトリは `createXxx()`
- **依存注入**: 各モジュールの依存はまとめて `Deps` 型・オプションは `Options` 型で受ける

## Import Organization

```typescript
// NodeNext ESM — 相対インポートは拡張子 .js を必ず付ける(ソースは .ts でも)
import type { QiitaItem, Result } from "../types/index.js";
import { ok, err } from "../types/index.js";
import type { StateStore } from "./stateStore.js";
```

- パスエイリアスは使わない(相対パスのみ)
- 並び順: Node組み込み → 外部パッケージ → プロジェクト内。型のみは `import type`

## Code Organization Principles

- **インターフェースに依存する**: サービス層はインフラの `interface` のみ参照し、テストではモック実装を注入する
- **ファイル先頭に責務コメント**: 日本語JSDocで責務+設計書の節番号・要件IDを記す
  (例: `/** バックアップ実行サービス(3.3) ... */`)
- **新規機能の置き場所**: 外部と通信するなら `infra`、業務判断なら `services`、
  APIエンドポイント追加は `routes.ts` +必要なら対応するサービスを新設 — 層をまたぐ神モジュールを作らない

---
_パターンを記す。ファイルツリーの全列挙はしない。パターンに従う新規ファイルはこの文書の更新を要しない_
