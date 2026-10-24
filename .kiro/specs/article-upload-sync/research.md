# Research & Design Decisions — article-upload-sync

## Summary
- **Feature**: `article-upload-sync`
- **Discovery Scope**: Extension(既存システムへの機能追加、統合重視の軽量ディスカバリ+外部API調査)
- **Key Findings**:
  - Qiita API v2 に**下書き作成APIは存在しない**。コミュニティ標準の代替は `private: true`(限定共有)での登録であり、要件5「非公開(下書き相当)」はこの方式で実現する
  - **トークンのスコープを照会するAPIは存在せず**、発行後は本人もスコープを確認できない。書き込み権限の「事前検証」は、既知の権限不足状態の事前拒否+Run内の最初の書き込みでの403検出(即時中断+案内)の2段構えで実現する
  - `PATCH /api/v2/items/:item_id` は `title`・`body` が**必須**。`private` 省略時の挙動が公式未記載のため、更新時は現在の公開範囲を**常に明示送信**する(5.3の「公開範囲を変更しない」を確実にする)
  - 既存の Run 統括基盤(排他・進捗SSE・429待機・記事単位リトライ・Gitコミット)は設計変更なしで踏襲可能。排他フラグのみ `BackupServiceImpl` 内部から共有機構(RunCoordinator)へ抽出する

## Research Log

### Qiita API v2 書き込みエンドポイントの仕様
- **Context**: Req 3(選択アップロード)・Req 5(非公開登録)の実現手段の確定(gap-analysis 申し送り#1)
- **Sources Consulted**: [Qiita API v2 公式ドキュメント](https://qiita.com/api/v2/docs)
- **Findings**:
  - `POST /api/v2/items`: 必須 = `body`, `title`, `tags`(配列)。任意 = `private`(boolean), `tweet`(boolean), `slide` 等。成功時 **201** で Item オブジェクト全体(`id`, `url`, `updated_at` 等)を返す
  - `PATCH /api/v2/items/:item_id`: **`title` と `body` が必須**、`tags`・`private` は任意。成功時 200 で更新後の Item を返す。`private` 省略時の挙動は公式未記載
  - 下書き(draft)を作成・取得するエンドポイントは存在しない
  - 画像をアップロードするエンドポイントは存在しない(認証ユーザ情報に `image_monthly_upload_limit` フィールドはあるがAPI経由の手段なし)— 要件の Out of scope 判断と整合
  - レート制限は認証時 1,000回/時で読み書き共通(書き込み別枠の記載なし)。429時の `Rate-Reset` 待機は既存実装をそのまま適用
- **Implications**: `QiitaApiClient` に `createItem`/`updateItem` を追加するだけで要件を満たせる。PATCH必須項目の関係で、本文のみ更新(Req 3.3)でも `title` はローカル管理情報から常に送信する。`private` は省略せず現在値を明示送信する

### トークンスコープの検証方法
- **Context**: Req 6.2「アップロード前に書き込みスコープを検証」の実現可能性(gap-analysis 申し送り#2)
- **Sources Consulted**: [Qiita API v2 公式ドキュメント](https://qiita.com/api/v2/docs)、[Qiita API v2 で403 Forbiddenが発生する](https://qiita.com/fkooo/items/9f8e566c027bb833c29e)
- **Findings**:
  - スコープ照会用のエンドポイントは存在しない。`GET /authenticated_user` のレスポンスにもスコープ情報は含まれない
  - トークンは発行後に本人もスコープを再確認できない(発行時に控える運用が前提)
  - スコープ不足の書き込みは 403 を返す
- **Implications**: 純粋な「事前検証」はAPI制約上不可能。設計では (1) 接続状態に権限種別 `writeAccess: unknown/granted/denied` を実績ベースで保持し、`denied` が既知なら**Run開始前に拒否**して案内(6.2, 6.3)、(2) `unknown` の場合はRunを開始し**最初の書き込みの403で全体を即時中断**して案内(9.3)する2段構えとする。403時点では書き込みは一切成立していないため「アップロードを実行せず」(6.3)の効果は保たれる

### 下書き相当の実現(private: true)
- **Context**: Req 5「アップロード後の公開はせず下書き状態」の実現方式(gap-analysis 申し送り#1)
- **Sources Consulted**: [Qiita の限定共有記事を予約投稿機能として使えるようにした話](https://qiita.com/terra_yucco/items/9b63dd6359dcfb1aff22)、[Qiita API を利用して記事を投稿する](https://qiita.com/iimuz/items/4837e9c8043ce7c1262b) ほかコミュニティ事例
- **Findings**:
  - `private: true`(限定共有)での投稿を「下書き相当」として使うのがコミュニティの確立したパターン(自動投稿とレビューの間に人間の確認を挟む用途で広く採用)
  - 限定共有記事はURLを知る本人のみ閲覧可能で、公開への切替はQiitaの画面から行える
- **Implications**: 新規登録は常に `private: true` + `tweet: false` で行う。UI文言は「限定共有(非公開)として登録します。公開はQiita上で行ってください」とし、「下書き」と完全同一でない(URLを知っていれば閲覧可能)ことを明示する

### ローカル新規記事の作成規約
- **Context**: Req 1 の検出規約の確定(gap-analysis 申し送り#3)。既存フォルダ規約 `{タイトル}_{記事ID}` は記事ID未確定の新規記事に適用できない
- **Sources Consulted**: 既存実装(`storageManager.ts` のフォルダ規約・`findFolderById`)、Qiita CLI のfrontmatter慣行(一般知識)
- **Findings**:
  - 既存記事フォルダは `_{記事ID}` サフィックスで同定される。`index.json` に登録済みのフォルダ名一覧も突合に使える
  - メタ情報の記載方式は (a) 手書き `meta.json` (b) Markdown frontmatter の2案。frontmatter は Qiita CLI と同じ慣行でユーザに馴染みがあり、1ファイルで完結する
- **Implications**: 新規記事の規約は「`backups/` 直下の任意名フォルダ+その直下に `.md` 1つ(YAML frontmatter で `title` 必須・`tags` 必須1件以上)」とする。検出は「`index.json` に登録がなく、既知の記事IDサフィックスとも一致しないフォルダ」を走査して行う。frontmatter 不備は「アップロード不可」として理由付きで表示(1.3)

### アップロード本文のソースと画像参照の逆書換
- **Context**: 閲覧用Markdownは画像参照が `images/` 相対パスへ書換済みで、そのままアップロードするとQiita上で画像が壊れる(gap-analysis 申し送り#4)
- **Sources Consulted**: 既存実装(`backupService.ts` の `rewriteImageRefs`、`meta.json` の `images[]`)
- **Findings**:
  - ローカル変更検知(ハッシュ)の対象は閲覧用Markdown(`{タイトル}.md`)であり、ユーザの編集面はこのファイルである
  - `meta.json` の `images[]` は 元URL↔ローカルファイル名 の対応を成功分について保持しており、`rewriteImageRefs` の逆変換(`images/{fileName}` → 元URL)が機械的に可能
  - 対応表にないローカル相対参照(ユーザが追加した画像)は逆変換できない — Req 8.3 の警告対象
- **Implications**: アップロード本文 = 閲覧用Markdownに逆書換を適用したもの。逆書換関数は `rewriteImageRefs` と対で配置する。対応表にない相対参照が残る記事は実行前確認に警告として列挙する

### Run排他の共有方式
- **Context**: Req 8.4(バックアップ/アップロードを通じて同時実行1件)。既存の排他は `BackupServiceImpl` 内部の `running` フラグ
- **Sources Consulted**: 既存実装(`backupService.ts` の `start()`/`running`)
- **Findings**: 排他はサービス内部のプライベート状態のため、アップロードRunとの相互排他には共有機構が必要
- **Implications**: `RunCoordinator`(獲得/解放のみの小さな共有サービス)を新設し、両サービスがRun開始時に獲得する。既存テストで回帰を確認できる小規模リファクタリング

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A: backupService双方向化 | 既存サービスにアップロードRunを追加 | 排他・進捗の共有が自動、新規ファイル最小 | Run統括の複雑さが倍加し単一責務を毀損 | steering structure.md の層規約に不適合 |
| B: 完全新規(専用インフラ含む) | アップロード専用のクライアント・サービスを独立新設 | 既存への影響ほぼゼロ | Authorization付与クライアントが2系統になりsecurity.mdの集約原則に違反。排他・リトライの重複実装 | 不採用 |
| C: ハイブリッド(採用) | 新規 `uploadService`+`RunCoordinator` 抽出、`qiitaApiClient`/`stateStore` 等は拡張 | 認証集約・排他共有・パターン踏襲と責務分離を両立 | backupServiceへ小規模リファクタリングが入る | gap-analysis の推奨どおり |

## Design Decisions

### Decision: 下書き相当は限定共有(private: true)で実現する
- **Context**: Req 5。Qiita API v2 に下書きAPIが存在しない
- **Alternatives Considered**:
  1. 限定共有(`private: true`)での登録 — コミュニティ標準
  2. アップロード機能自体を断念(下書きが作れないため)
- **Selected Approach**: 新規登録は常に `private: true`・`tweet: false` で行い、公開操作はスコープ外とする
- **Rationale**: 要件の意図(推敲前の記事を誤公開しない)を満たす唯一の実現手段であり、確立した先行事例がある
- **Trade-offs**: 厳密な「下書き」ではなくURLを知る本人は閲覧可能。UI文言で明示して補う
- **Follow-up**: 実装時にPOSTレスポンスの `private` が true であることを検証する

### Decision: スコープ検証は「既知状態の事前拒否+最初の書き込みでの403即時中断」
- **Context**: Req 6.2〜6.4。スコープ照会APIが存在しない
- **Alternatives Considered**:
  1. プローブ書き込み(テスト記事のPOST→DELETE)— ゴミ記事が生じ、Req 8.2(削除しない)と衝突
  2. ユーザの自己申告のみ — 検証にならない
  3. 実績ベースの権限状態管理+最初の書き込みでの判定(採用)
- **Selected Approach**: `ConnectionStatus` に `writeAccess: "unknown" | "granted" | "denied"` を追加。`denied` 既知ならRun開始要求を即時拒否。`unknown` ならRunを開始し、最初の書き込みが403なら残り全件を中止して再発行手順を案内。成功/403の結果で `writeAccess` を更新する
- **Rationale**: API制約下で「権限不足のまま書き込みが1件も成立しない」ことを保証でき、副作用(ゴミ記事)もない
- **Trade-offs**: 初回は「実行してみて判明」となる。403発生時点で書き込みは一切成立していないため実害はない
- **Follow-up**: 403レスポンスボディの `type` でスコープ不足と他の403(凍結等)を区別できるか実装時に確認する

### Decision: 新規記事の作成規約は「フォルダ+frontmatter付きMarkdown」
- **Context**: Req 1.2〜1.4。記事ID未確定の新規記事は既存フォルダ規約に乗らない
- **Alternatives Considered**:
  1. 手書き `meta.json` を要求 — JSON手書きはエラーを誘発しやすい
  2. YAML frontmatter(採用)— Qiita CLI と同じ慣行
- **Selected Approach**: `backups/` 直下の未登録フォルダ直下に `.md` 1つ。frontmatter で `title`(必須)・`tags`(必須1+)を記載。登録成功後はフォルダを `{サニタイズ済タイトル}_{記事ID}` へリネームし、既存レイアウト(閲覧用md・original.md・meta.json)へ正規化する
- **Rationale**: ユーザは「フォルダを作ってMarkdownを書く」だけでよく、既存レイアウトとの往復が機械的に定義できる
- **Trade-offs**: frontmatterパーサ(簡易YAML)の自作が必要(依存最小主義のため外部ライブラリは追加しない — title/tagsのみの平坦な形式に限定して自作コストを抑える)
- **Follow-up**: frontmatterの許容形式(引用符・配列記法)をテストで固定する

### Decision: アップロード本文は閲覧用Markdownの逆書換で生成する
- **Context**: Req 3.2/3.3・8.3。閲覧用mdは画像参照が相対パス化されている
- **Alternatives Considered**:
  1. `original.md` を本文ソースにする — ユーザの編集面(ハッシュ検知対象)は閲覧用mdであり、編集が反映されない
  2. 閲覧用md+`meta.json` `images[]` による逆書換(採用)
- **Selected Approach**: `rewriteImageRefs` の逆関数で `images/{fileName}` → 元URL へ復元してから送信。逆変換できない相対参照は実行前確認で警告(8.3)
- **Rationale**: 編集面と検知対象とアップロード対象が一致し、ユーザの直感と揃う
- **Trade-offs**: 対応表にない画像はQiita上で壊れる(警告で補う。画像アップロードAPIは存在しないため解決不能)
- **Follow-up**: アップロード成功後は閲覧用mdを再生成せず、レスポンス本文で `original.md` とハッシュ・`qiitaUpdatedAt` を更新して「最新」へ遷移させる(7.4)

### Decision: 状態モデルは3状態を追加した8状態へ拡張する
- **Context**: Req 2。既存5状態では「ローカル新規」「競合」「ローカル欠落」が表現できない(欠落は現行 `localModified` に吸収)
- **Selected Approach**: `BackupStatus` へ `localNew`(ローカル新規)・`conflict`(競合)・`localMissing`(本文ファイル欠落)を追加。分類優先順: 欠落 → 競合(ハッシュ不一致∧Qiita側更新)→ ローカル改変 → Qiita側更新 → 最新
- **Rationale**: ダウンロード側の既存挙動(差分対象 = 未バックアップ+Qiita側更新)を変えずに、アップロード側の対象選定・保護を状態だけで決定できる
- **Trade-offs**: `summarize()`・API・UI・テストへ波及するが機械的な拡張。`localMissing` の選択ダウンロードは失われるローカル変更が存在しないため上書き確認を不要とする(現行は欠落も確認対象 — 挙動の明確化として設計に明記)
- **Follow-up**: 既存 `index.json` はスキーマ変更なし(追加フィールドはRunSummaryの `direction` のみ、省略時は `backup` とみなす)

## Risks & Mitigations
- `PATCH` の `private` 省略時挙動が未文書 — 省略せず現在値を常に明示送信して回避
- 403がスコープ不足以外(利用制限等)でも発生し得る — エラーメッセージにQiitaのレスポンス `message` を含め、案内を「スコープ確認または再発行」とする
- ユーザがfrontmatterを誤記する — 検出時に不備理由を一覧へ表示(1.3)し、規約はUIから参照可能にする(1.4)
- アップロード直後の状態誤分類(updated_at前進) — 書き込みレスポンスの Item で `qiitaUpdatedAt`・ハッシュを即時更新(7.4)
- 既存バックアップ機能への回帰 — RunCoordinator抽出は既存テスト+統合テストで回帰確認。分類変更はstateStoreテストを拡張

## References
- [Qiita API v2 公式ドキュメント](https://qiita.com/api/v2/docs) — 書き込みエンドポイント・スコープ・レート制限
- [Qiita API v2 で403 Forbiddenが発生する](https://qiita.com/fkooo/items/9f8e566c027bb833c29e) — スコープ不足時の挙動
- [Qiita の限定共有記事を予約投稿機能として使えるようにした話](https://qiita.com/terra_yucco/items/9b63dd6359dcfb1aff22) — private:true を下書き代替とする先行事例
- [Qiita API を利用して記事を投稿する](https://qiita.com/iimuz/items/4837e9c8043ce7c1262b) — POST /items の利用例
- プロジェクト内: [gap-analysis.md](gap-analysis.md)、[research/qiita-api接続方法調査.md](../../../research/qiita-api接続方法調査.md)
