# Research & Design Decisions — qiita-backup-tool

## Summary
- **Feature**: `qiita-backup-tool`
- **Discovery Scope**: New Feature(グリーンフィールド、フルディスカバリ)
- **Key Findings**:
  - Qiita API v2 の `GET /authenticated_user/items` は限定共有記事を含む全記事を raw Markdown(`body`)付きで返すため、記事単位の個別取得が不要になり、API消費は記事300件でも3〜4リクエスト/同期で済む(事前調査済み: [research/qiita-api接続方法調査.md](../../../research/qiita-api接続方法調査.md))
  - 2026年7月時点の推奨スタックは Node.js 24(Active LTS、EOL 2028-04)+ Express 5.2 + TypeScript。Git操作は simple-git 3.36(週間DL 1,000万超、`git` CLI 必須)が事実上の標準
  - 進捗通知は Server-Sent Events(SSE)が最適。単方向・自動再接続・実装が軽量で、WebSocketの双方向性は不要(中断指示は通常のPOSTで足りる)

## Research Log

### Qiita API v2 の接続仕様
- **Context**: 記事・画像の取得手段と制約の確定
- **Sources Consulted**: [Qiita API v2 公式ドキュメント](https://qiita.com/api/v2/docs)、プロジェクト内調査 [research/qiita-api接続方法調査.md](../../../research/qiita-api接続方法調査.md)、[research/qiita-アクセストークン発行方法.md](../../../research/qiita-アクセストークン発行方法.md)
- **Findings**:
  - 認証は `Authorization: Bearer {token}`(個人用アクセストークン、スコープ `read_qiita`)
  - ページネーションは `page`(≦100)× `per_page`(≦100)、`Link` ヘッダの `rel="next"` 追跡、`Total-Count` ヘッダで総件数
  - レート制限は認証あり1,000回/時。429時は `Rate-Reset`(UNIX時間)まで待機。ヘッダ名は公式未記載のため実装時に実レスポンスで確認
  - 画像(`camo.qiitausercontent.com` / `qiita-image-store.s3.*`)は認証不要GET。`Authorization` を送ってはならない(トークン漏洩)
- **Implications**: QiitaApiClient は一覧取得+ユーザ取得の2エンドポイントに限定。ImageDownloader は認証ヘッダなしの別HTTPクライアントに分離(steering security.md 準拠)

### 実行環境・フレームワークの現行バージョン
- **Context**: 新規プロジェクトのスタック確定(Windows 11、単一コマンド起動、ローカルWebサーバ)
- **Sources Consulted**: [Node.js Releases](https://nodejs.org/en/about/previous-releases)、[endoflife.date/nodejs](https://endoflife.date/nodejs)、[Express 5 リリース情報](https://expressjs.com/en/guide/migrating-5/)、[simple-git (npm)](https://www.npmjs.com/package/simple-git)
- **Findings**:
  - 2026年7月時点: Node.js 24 が Active LTS(EOL 2028-04-30)、22 は Maintenance。26 は Current(非LTS)
  - Express 5.2.x が安定版(5.0は2024-10リリース、Node 18+要求)。ルーティングの正規表現制限等の破壊的変更はv4からの移行時のみ関係
  - simple-git 3.36.0(2026-04時点最新)。`git` コマンドのインストールが前提 — 外部要件書の前提条件9と整合
- **Implications**: Node.js 24 LTS + TypeScript 5 + Express 5 を採用。simple-git は Git 不在時に例外を投げるため、起動時の可用性チェックで F-GIT-07(警告して世代管理なし継続)を実現

### 進捗通知方式(SSE vs WebSocket vs ポーリング)
- **Context**: バックアップ実行中の進捗(9.1系: 3.9)をブラウザへプッシュする方式の選定
- **Sources Consulted**: MDN EventSource、Express 5でのSSE実装パターン(一般知識+検証は実装時)
- **Findings**:
  - SSE: サーバ→クライアント単方向、HTTP上で動作、`EventSource` の自動再接続あり、実装が最小
  - WebSocket: 双方向だがライブラリ追加(ws等)とハンドシェイク管理が必要。中断指示はPOSTで代替可能
  - ポーリング: 実装は容易だが進捗の粒度と即時性が劣る
- **Implications**: `GET /api/backup/events` をSSEで提供。イベント種別(progress / article-done / run-done / error)をJSONペイロードで通知

### Markdown画像参照の抽出・書き換え
- **Context**: F-BK-05/06 の実現方式
- **Sources Consulted**: プロジェクト内調査(qiita-api接続方法調査.md 7章・8章)
- **Findings**:
  - 抽出対象は `![alt](url)` と `<img src="url">` の2形式で実用上十分(Qiitaのbodyが取りうる形式)
  - Camo URLはパスがhexでファイル名を持たない → 連番+Content-Type由来拡張子で命名(F-DIR-04)
  - 同一URLが複数回参照されるケースがあるため、URL→ローカルファイル名のマップで1回だけダウンロードし全参照を置換
- **Implications**: 正規表現ベースの抽出で開始し、置換はURL完全一致の文字列置換(Markdownパーサ導入は初版では過剰)

### index.json のアトミック書き込み
- **Context**: N-PERF-03(異常終了時も管理情報を破損させない)
- **Findings**: 一時ファイルに書き込み後 `rename` する write-then-rename パターンがWindowsでも有効(同一ボリューム内)。Node.js では `fs.writeFile(tmp)` → `fs.rename(tmp, target)`
- **Implications**: StateStore の保存処理に必須実装として設計へ反映

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| レイヤードモノリス(採用) | 単一Nodeプロセス内で Types→Config→Infra→Service→HTTP→UI の一方向依存 | ローカルツールに適した最小構成。起動1コマンド。依存方向が明確 | 大規模化には不向き(本件は該当せず) | steering の依存方向原則と一致 |
| ヘキサゴナル | ポート&アダプタでコアを抽象化 | テスト容易性が最高 | アダプタ層の構築コストが単機能ツールには過剰 | 却下(過剰設計) |
| Electron等デスクトップ | ブラウザ同梱の配布形態 | 配布が単一実行ファイル | 要件は「ローカルWebツール」であり過剰。サイズ大 | 却下(要件1.2と不一致) |

## Design Decisions

### Decision: 技術スタック = Node.js 24 LTS + TypeScript + Express 5
- **Context**: 外部要件書 検討事項#5(実装技術は内部設計で決定)
- **Alternatives Considered**:
  1. Python + FastAPI — 実績十分だが、SSE・静的配信・型のフロント共有でTSに劣る
  2. Node.js + Fastify/Hono — 性能面の利点はローカルツールでは無意味。情報量でExpressが優位
- **Selected Approach**: Node.js 24 LTS、TypeScript 5(strict)、Express 5.2、フロントは静的HTML+vanilla TS(ビルドはesbuildまたはtscのみ)
- **Rationale**: 単一言語でサーバ・フロント・型定義を共有。simple-git/dotenv等の周辺が成熟。Windows 11で追加ランタイム不要(Node のみ)
- **Trade-offs**: SPAフレームワーク不使用のためUIの状態管理は手書き(画面3枚・状態少のため許容)
- **Follow-up**: Express 5でのSSEレスポンス(`res.flushHeaders`)の動作確認

### Decision: 進捗通知はSSE、中断はPOST
- **Context**: 3.9/3.10(進捗表示・中断)の通信方式
- **Selected Approach**: `GET /api/backup/events`(SSE)+ `POST /api/backup/cancel`
- **Rationale**: 双方向通信が不要でSSEが最小実装。EventSourceの自動再接続で切断にも頑健
- **Trade-offs**: 同時接続クライアントは実質1(ローカル専用のため問題なし)

### Decision: Git操作は simple-git、可用性チェックで graceful degradation
- **Context**: 6.1〜6.6(世代管理)、F-GIT-07
- **Alternatives Considered**:
  1. `child_process` で git CLI 直叩き — 依存ゼロだがエラー処理・エスケープを自前実装
  2. isomorphic-git — git CLI不要だが、rename検出やgc等の互換性に難
- **Selected Approach**: simple-git 3.x。起動時に `git --version` で可用性を判定し、不可なら世代管理無効フラグを立てUIに警告
- **Rationale**: Promise チェーンAPIで add/commit/status が簡潔。前提条件9(git インストール)と整合
- **Trade-offs**: git CLI への実行時依存(要件で許容済み)

### Decision: トークンはプロセスメモリ保持、書き込みは .env の該当行のみ更新
- **Context**: 1.5〜1.7(F-AUTH-05/07/08)、steering security.md
- **Selected Approach**: TokenStore(メモリ)を単一の真実とし、`.env` は起動時読込+同意時書込のみ。書込は既存内容をパースし `QIITA_ACCESS_TOKEN` 行だけ置換/追記
- **Rationale**: 保存経路を1本化して漏洩面を最小化。dotenvの再読込に依存しない
- **Follow-up**: `.env` が存在しない場合の新規作成(BOMなしUTF-8)の動作確認

## Risks & Mitigations
- レート制限ヘッダ名が公式未記載 — 実装初期に実レスポンスをログで確認し定数化。ヘッダ欠落時は固定ウェイトにフォールバック
- 記事タイトル由来のフォルダ名がWindowsパス長制限(260字)に抵触 — タイトル部を最大50文字に切り詰め+記事IDで一意性担保
- 画像バイナリの履歴蓄積でbackupリポジトリが肥大化 — 初版は許容(外部要件書 検討事項#7)。コミットメッセージに件数を記録し将来の間引きを可能にする
- `open folder` 操作(2.5)のOS依存 — Windows は `explorer.exe` 起動。他OSは初版対象外(N-OPS-02)

## References
- [Qiita API v2 公式ドキュメント](https://qiita.com/api/v2/docs) — エンドポイント・認証・ページネーション
- [research/qiita-api接続方法調査.md](../../../research/qiita-api接続方法調査.md) — プロジェクト内事前調査(接続方式決定の根拠)
- [research/qiita-アクセストークン発行方法.md](../../../research/qiita-アクセストークン発行方法.md) — トークン発行・失効手順
- [Node.js Releases](https://nodejs.org/en/about/previous-releases) / [endoflife.date/nodejs](https://endoflife.date/nodejs) — Node 24 Active LTS(2026-07時点)
- [Express 5 Migration Guide](https://expressjs.com/en/guide/migrating-5/) — Express 5.2系の安定性確認
- [simple-git (npm)](https://www.npmjs.com/package/simple-git) — v3.36、git CLI前提
