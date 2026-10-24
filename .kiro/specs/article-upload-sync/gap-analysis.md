# Gap Analysis — article-upload-sync

- **調査日**: 2026-08-02
- **対象**: [requirements.md](requirements.md)(Req 1〜9)と既存コードベース(qiita-backup-tool 実装完了版)のギャップ

## サマリ

| 観点 | 結論 |
|---|---|
| 再利用性 | Run統括(進捗・中断・リトライ・429待機・Gitコミット)と状態管理の基盤はそのまま流用可能 |
| 主要ギャップ | API書き込みメソッド、ローカル新規記事の検出・作成規約、競合状態の分類、画像参照の逆書換、書き込みスコープ検証 |
| 推奨アプローチ | Option C(ハイブリッド): 新規 `uploadService` + 既存モジュールの拡張 |
| 規模/リスク | L(1〜2週間)/ Medium |

## 1. 現状調査(Current State)

### 再利用可能な資産

| 資産 | 場所 | アップロードでの利用 |
|---|---|---|
| Run統括パターン | `src/services/backupService.ts` | 同時実行1件制限・進捗発行・中断(処理中記事の完了待ち)・記事単位リトライ・429待機・終了時のindex保存+Gitコミット — 構造をそのまま踏襲可能 |
| 進捗イベント基盤 | `src/services/progressBus.ts` | `ProgressEvent` ユニオン(`run-start`/`progress`/`article-done`/`run-done` 等)とSSE配信(`GET /api/backup/events`)。イベント型の追加のみで流用可 |
| 状態管理 | `src/services/stateStore.ts` | `IndexArticleEntry` は `qiitaUpdatedAt` / `contentHash` / `lastBackupAt` を保持済みで、**競合判定に必要なデータは揃っている** |
| ストレージ | `src/infra/storageManager.ts` | フォルダ規約 `{タイトル}_{記事ID}`、`findFolderById`、リネーム、アトミックJSON書込、パストラバーサル防止 |
| APIクライアント | `src/infra/qiitaApiClient.ts` | 共通 `request()`・`ApiError` 変換・`Rate-Reset` 解析・snake_case→camelCaseマッピング(`toQiitaItem`)。**POST/PATCHレスポンスの解釈にも再利用可** |
| 世代管理 | `src/infra/gitManager.ts` | Run終了時コミットをそのまま利用 |
| 認証 | `src/services/authService.ts` + `tokenStore` | トークン検証・マスク表示。スコープ概念は未実装 |
| テスト基盤 | `tests/helpers/mockQiitaServer.ts`, `scripts/mock-qiita.mjs` | GETのみ実装。書き込みエンドポイントの追加が必要 |

### 規約(遵守すべき既存パターン)

- レイヤード構成(`http → services → infra → config/types`)、`Result<T,E>` + `kind` 判別ユニオン、`Deps` によるDI、`XxxImpl`/`createXxx`
- `Authorization` ヘッダは `QiitaApiClient` のみが付与(security.md)— 書き込みも同クライアントに集約すべき

## 2. 要件↔資産マップとギャップ

| 要件 | 既存資産 | ギャップ(タグ) |
|---|---|---|
| Req 1 ローカル新規記事の検出 | `findFolderById`(ID検索のみ) | **Missing**: `backups/` 全走査で「IDと対応しないフォルダ」を検出する機能。**Unknown**: 新規記事の作成規約(ID未確定のためフォルダ名 `{title}_{id}` が適用不能。タイトル・タグの記載方法 = frontmatter か meta テンプレートか) |
| Req 2 更新日時比較・差分管理 | `classifyExisting`(ハッシュ+`updatedAt`比較) | **Constraint**: 現行のローカル改変検出は**閲覧用Markdownのsha256ハッシュ**であり日時比較ではない(ファイルmtimeはWindowsで信頼性に難があり、ハッシュ方式の維持が安全 — 要件の「更新日比較」との整合を設計で定義)。**Missing**: 「競合」状態 — 現行分類はローカル変更→Qiita側更新の優先順で判定するため、**双方更新が「ローカル改変」に吸収される**。`BackupStatus` への状態追加は `summarize()`・API・UI・テストへ波及 |
| Req 3/4 選択・変更点全件アップロード | Runモード機構(`all`/`diff`/`selected`) | **Missing**: `POST /items`・`PATCH /items/:id` クライアントメソッド、アップロードRun統括、確認ダイアログ(即時公開反映・競合警告)。**Constraint**: steering qiita-api.md「読み取り専用」の改訂が前提 |
| Req 5 非公開(下書き相当)登録 | — | **Unknown(Research Needed)**: Qiita API v2に下書き作成APIは存在しない見込み → `private: true`(限定共有)での登録を「下書き相当」とする方針の確認。`tweet: false` 指定、タグ最低1件必須などPOSTパラメータ仕様の確定 |
| Req 6 書き込みスコープ検証 | `verifyToken`(read検証のみ) | **Unknown(Research Needed)**: Qiita API v2に**スコープ照会エンドポイントが見当たらない**。事前検証の実現方法(レスポンスヘッダ調査/書き込み時403の捕捉と案内へのフォールバック)。`ConnectionStatus` への権限種別の追加 |
| Req 7 進捗・結果・ID対応付け | progressBus・history・gitManager | **Missing**: 新規登録成功時の「仮フォルダ → `{title}_{id}` へのリネーム+meta.json生成+index登録」。**Constraint**: PATCH/POST後はQiita側 `updated_at` が変わるため、**レスポンスの `updated_at` とハッシュ再計算でindexを更新**しないと直後に「Qiita側更新/ローカル改変」へ誤分類される |
| Req 8 安全性 | 同時実行1件制限(backupService内部) | **Constraint**: 排他がBackupServiceImpl内部にあり、**バックアップRunとアップロードRunの相互排他**には共有機構(RunCoordinator等)への抽出が必要。**Missing**: ローカル相対パス画像参照の検出と警告。**Constraint(重要)**: 閲覧用Markdownは画像参照が `images/` 相対パスへ書換済み — これを本文としてアップロードするとQiita上で画像が壊れるため、**meta.json の `images[]`(元URL↔ファイル名)を使った逆書換**が必要。アップロード本文のソース(閲覧用md か original.md か)の確定も必要(ハッシュ判定は閲覧用md基準) |
| Req 9 エラー処理・429 | backupServiceの既存実装 | ギャップ小: パターン流用。書き込み系のレート制限が読み取りと同枠かは **Unknown(Research Needed)** |

### 横断的な影響

- **ステアリング改訂**(要件承認後): qiita-api.md(読み取り専用原則→明示的アップロード操作の例外追加、書き込みエンドポイント表)、security.md(スコープ方針: バックアップのみ=read、アップロード利用時=read+write)。既存の「Authorizationはqiita.comのみ」制限はそのまま有効
- **モック拡張**: `mock-qiita.mjs` / `mockQiitaServer.ts` へ POST/PATCH 追加(テスト戦略の前提)
- **UI拡張**: ダッシュボードの状態列(競合・ローカル新規)、アップロードボタン2種、実行前確認、権限種別表示

## 3. 実装アプローチ

### Option A: 既存コンポーネント拡張(backupServiceを双方向化)
- `BackupService` にアップロードRunを追加し、既存の排他・リトライ・進捗をそのまま使う
- ✅ 排他制御の共有が自動的に成立、新規ファイル最小
- ❌ backupServiceは既にRun統括の複雑さを抱えており、方向の異なるロジック混在で肥大化。steering structure.md の単一責務原則に反する

### Option B: 完全新規(uploadService + 独自インフラ)
- アップロード専用のサービス・APIクライアント・ストレージ操作を新設
- ✅ 分離が明確、既存機能への影響ほぼゼロ
- ❌ `Authorization` 付与クライアントが2つになりsecurity.mdの集約原則に反する。排他・リトライ・429待機の重複実装

### Option C: ハイブリッド(推奨)
- **新規**: `services/uploadService.ts`(アップロードRun統括)、`services/runCoordinator.ts`(Run排他の共有機構として抽出)、ローカル記事走査(storageManagerの拡張 or `infra/localArticleScanner.ts`)
- **拡張**: `qiitaApiClient`(`createItem`/`updateItem` — 認証集約を維持)、`stateStore`(競合・ローカル新規の分類)、`types`(状態・Run種別・イベント)、`routes`/`web`(エンドポイント+UI)、モックサーバ
- ✅ 認証集約・排他共有・パターン踏襲と責務分離を両立
- ❌ 排他の抽出でbackupServiceに軽微なリファクタリングが入る(既存テストで回帰確認可能)

## 4. 規模・リスク

- **Effort: L(1〜2週間)** — 新サービス+状態モデル拡張+UI+モック拡張+テスト。既存パターンの踏襲で個々は定型だが、面が広い
- **Risk: Medium** — アーキテクチャ適合は良好だが、外部API書き込み仕様に未確定事項(スコープ検証・下書き相当・書き込みレート制限)があり、画像参照の逆書換に設計判断を要する

## 5. 設計フェーズへの申し送り(Research Needed)

1. **Qiita API v2 書き込み仕様の確定**: `POST /api/v2/items` / `PATCH /api/v2/items/:item_id` のパラメータ(`private`, `tweet`, `tags` 必須条件)、レスポンス、下書き作成が不可能であることの確認(→限定共有を「下書き相当」とする方針の妥当性)
2. **書き込みスコープの事前検証方法**: スコープ照会APIの有無、なければ「実行時403捕捉+案内」への要件解釈の調整
3. **ローカル新規記事の作成規約**: フォルダ命名(ID未確定)、メタ情報の書式(frontmatter vs meta.jsonテンプレート)、ユーザ向け案内方法
4. **アップロード本文のソースと画像参照の逆書換**: 閲覧用md(ハッシュ判定基準)を正とし、`meta.json` の `images[]` で相対パス→元URLへ逆書換する方式の検証。ローカルにしかない画像(元URLなし)の扱い(Req 8.3の警告対象)
5. **「更新日比較」の実装解釈**: ハッシュ方式(現行)+アップロード後の `updated_at`/ハッシュ更新で要件の意図(双方向の差分管理)を満たす設計の明文化
6. **書き込み系レート制限**: 読み取りと同一枠(1,000回/時)かの確認

---
_本文書は情報提供が目的であり、最終的な実装方式の決定は設計フェーズ(`/kiro:spec-design`)で行う。_
