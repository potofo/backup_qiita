# Research & Design Decisions

## Summary
- **Feature**: `image-upload-automation`
- **Discovery Scope**: Complex Integration(既存アップロード機能の拡張+非公式なWeb UI自動操作という外部統合)
- **Key Findings**:
  - 既存の `meta.json.images`(`ImageResult[]`)と `restoreImageRefs` は「`images/{fileName}` ↔ URL」の対応表として機能しており、アップロード側の対応表もこの考え方に寄せられる。ただし `saveArticle` / `normalizeDraft` は meta を毎回作り直すため、新フィールドは明示的に引き継がないと消える
  - `playwright-core`(ブラウザ同梱なし)+ `channel: "msedge"`(Windows標準搭載)で、ブラウザ本体のダウンロードなしに画面ありブラウザを起動できる。依存の重さを大幅に抑えられる
  - Qiita利用規約に自動化ツール・スクレイピングを直接禁止する条項はない。ただし第11条3項7号(不正な操作)・第12条(アカウント凍結事由)に抵触すると判断される余地は残り、違反時は予告なくアカウント凍結があり得る(第11条6項)。リスクとして利用者に提示する

## Research Log

### 既存アップロード機能との統合点
- **Context**: 画像アップロードを既存のアップロードRunの前段に組み込むため、差し込み位置とデータの流れを確認した
- **Sources Consulted**: `src/services/uploadService.ts`, `src/infra/storageManager.ts`, `src/infra/localArticleScanner.ts`, `src/services/backupService.ts`(`restoreImageRefs`), `src/services/progressBus.ts`, `src/http/routes.ts`, `src/web/main.ts`
- **Findings**:
  - `UploadServiceImpl.start()` は「対象選定 → 実行前確認情報(`UploadConfirmInfo`)生成 → `confirmed` で実行」の2段階。`imageWarnings` は既に記事ごとのローカル画像参照を返している(article-upload-sync 8.3)
  - `executeRun()` は記事を1件ずつ直列処理し、どの終了経路でも index 保存+Gitコミットを行う。画像フェーズはこのループの前に置けば、排他(RunCoordinator)・コミットをそのまま共有できる
  - 新規記事: `draft.body`(frontmatter除去済み)をそのまま `createItem` に送り、`normalizeDraft` が閲覧用md=`draft.body`、original.md=`item.body` を書く。送信本文だけを置換すれば、閲覧用mdは相対参照のまま残る(要件7.3と整合)
  - 更新記事: 閲覧用mdを `restoreImageRefs(content, meta.images)` で復元して送信する。ここにアップロード対応表による置換を追加すればよい
  - ローカル新規の判定はフォルダ名の `_{記事ID}` 接尾辞で行い、meta.json の有無を見ていない。新規記事フォルダに `.md` 以外の補助ファイルを置いても判定に影響しない
  - `saveArticle` / `normalizeDraft` は `ArticleMeta` を毎回新規に組み立てる。追加フィールドは既存metaから引き継ぐ改修が必要(バックアップ側の `saveArticle` も同じ)
- **Implications**: 画像フェーズは `UploadServiceImpl` から呼ぶ新サービスとして切り出し、本文置換は純粋関数にまとめる。対応表は meta.json の新フィールドとし、StorageManager 側で保存のたびに引き継ぐ

### ブラウザ自動操作ライブラリ
- **Context**: 依存最小主義(実行時依存3つ)との整合と、利用者が手動ログインできる画面ありブラウザの要件
- **Sources Consulted**: `npm view playwright-core`(2026-10-25時点 1.64.1, engines node>=20, unpacked 約13.7MB)、[Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype)
- **Findings**:
  - `playwright-core` はブラウザ本体を同梱せず、`channel: "msedge"` / `"chrome"` で既存インストールのブラウザを起動できる。Windows には Edge が標準で入っている
  - `launchPersistentContext(userDataDir, options)` で、ユーザデータディレクトリ(Cookie等)を指定場所に置ける。一時ディレクトリを渡して終了時に削除すれば、セッションを残さない運用にできる
  - `locator.setInputFiles()` で `input[type=file]` へファイルを投入できる(2026-10-25 の手動作業で、Qiitaエディタに対して成功を確認済み)
- **Implications**: `playwright-core` を `optionalDependencies` とし、動的 import で読み込む。読み込めない場合は機能を「利用不可」として表示する(要件1.3)。必須の実行時依存は3つのまま保つ

### Qiitaエディタの挙動(2026-10-25 の手動作業で観測)
- **Context**: 自動化の対象となる画面の実際の挙動
- **Findings**:
  - 未ログインで `https://qiita.com/drafts/new` を開くと `/login?redirect_to=...` へリダイレクトされ、ログイン後に `/drafts/new` へ戻る
  - エディタには `input[type=file]`(`accept="image/*"`, `multiple=false`)が1つある。本文はCodeMirror(`.cm-editor`)
  - 画像を投入すると、カーソル位置に `![{元ファイル名}](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/{ユーザ番号}/{UUID}.png)` が挿入される
  - 最初の投入で下書きが自動保存され、URLが `/drafts/{下書きID}/edit` に変わる(APIでは削除できない作業用下書きが1件残る)
  - 24枚(合計約10.4MB)を1枚ずつ投入し、すべて数秒以内にURLが得られた
  - CodeMirrorは表示範囲外の行をDOMに描画しないため、DOMのテキストを読むだけでは行数が多いと全文を取れない可能性がある
- **Implications**: 画像は1枚ずつ投入し、投入前後のURL集合の差分で新しいURLを特定する。1枚ごとにエディタを空にすれば、表示範囲の問題を避けられ、下書きに記事内容も残らない(要件9.3)。画面要素のセレクタやURL判定は1か所の定義に集約し、画面変更時の修正範囲を限定する

### Qiita利用規約・容量制限
- **Context**: 要件のBoundary Context(規約の確認)と要件2.5(容量上限)
- **Sources Consulted**: [Qiita利用規約](https://qiita.com/terms)、[個人記事(2018年)](https://qiita.com/saiteu/items/49f5415fe7043357a053)
- **Findings**:
  - 規約に自動化ツール・ボット・スクレイピングを直接扱う条項はない。関連しうるのは第11条3項7号(他人のコンピューターに対する不正な操作)、第12条1項3号(情報の不正使用によるアカウント凍結)。違反時は予告なく記事非公開・アカウント凍結があり得る(第11条6項)
  - 画像の容量上限について公式の現行値は見つからなかった。2018年の個人記事では「記事未投稿ユーザーは1ファイル2MB、投稿後は月100MB」との報告がある(現行仕様は未確認)
- **Implications**: 規約リスクは初回有効化時の同意画面で提示する(要件1.4)。送信は利用者の明示操作ごと・1枚ずつ直列に限り、サーバ負荷を抑える。容量上限は定数として持ち、実装時に実際の挙動で確かめる。上限超過をQiitaが拒否した場合も、URLが得られない失敗として扱える

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 既存UploadServiceに直接追加 | 画像処理を `uploadService.ts` に書き足す | 変更ファイルが少ない | 464行のファイルがさらに肥大化。ブラウザ依存がサービス層に入り込む | 不採用 |
| ポート&アダプタで分離(採用) | 画像フェーズを独立サービスにし、ブラウザ操作は infra のアダプタに閉じ込める | Playwright を1ファイルに隔離。偽アダプタでテストできる。画面変更時の修正範囲が限定される | ファイル数が増える | structure.md の層構造・DI方針と一致 |
| 別プロセス/外部スクリプト | 画像アップロードを独立CLIにする | 本体への影響が最小 | 進捗・排他・結果サマリの統合(要件10)が難しい | 不採用 |

## Design Decisions

### Decision: 送信本文のみを置換し、ローカルの閲覧用mdは書き換えない
- **Context**: 要件7.1, 7.3
- **Alternatives Considered**:
  1. ローカルmdを直接書き換える(2026-10-25 の手作業と同じ)
  2. 送信本文だけを置換し、対応表を meta に記録する
- **Selected Approach**: 2。既存の「閲覧用md=相対参照 / original.md=URL」の二形態保持と同じ考え方
- **Rationale**: ローカルで画像付き閲覧を保てる。閲覧用mdのハッシュも変わらないため、状態判定(ローカル変更あり)に影響しない
- **Trade-offs**: 置換結果はローカルの閲覧用mdからは見えない(original.md と meta の対応表で確認する)
- **Follow-up**: 次回バックアップで Qiita 側の画像が `images/` へダウンロードされた場合も、閲覧用mdが壊れないことをテストで確かめる

### Decision: 対応表の保存場所(既存記事は meta.json、新規記事は補助ファイル)
- **Context**: 要件7.4, 7.5, 8.2(失敗時も成功分を保持)
- **Alternatives Considered**:
  1. 実行中のメモリにのみ保持し、登録成功時に meta へ書く
  2. 新規記事フォルダに補助ファイル `.image-uploads.json` を置き、登録時に meta.json へ引き継ぐ
- **Selected Approach**: 2
- **Rationale**: 1だと記事アップロードに失敗した場合に、アップロード済みの画像のURLが失われ、再実行で二重アップロードになる
- **Trade-offs**: 補助ファイルという新しいファイル規約が増える(作成規約の文書に追記する)
- **Follow-up**: `normalizeDraft` で補助ファイルを meta に引き継いだあと削除する。削除には `unlinkSync` を使う(この環境では `rmSync` が黙って失敗するため)

### Decision: ブラウザは playwright-core + 既存の Edge/Chrome、任意依存として導入
- **Context**: 要件1.1〜1.3、tech.md の依存最小主義
- **Alternatives Considered**:
  1. `playwright`(ブラウザ本体を別途ダウンロード)を必須依存にする
  2. `playwright-core` を任意依存にし、既存ブラウザのチャネルで起動する
- **Selected Approach**: 2。起動は `msedge` を優先し、失敗したら `chrome` を試す
- **Rationale**: 追加ダウンロードなしで動き、機能を使わない利用者に影響しない
- **Trade-offs**: ブラウザのバージョンは利用者の環境任せになる(Playwright は同梱Chromiumでの動作が最も安定)
- **Follow-up**: 依存のバージョンは実装時点の安定版に固定する

### Decision: セッションは既定で保存しない
- **Context**: 要件5.1〜5.3、security.md(秘密情報はトークンのみ)
- **Selected Approach**: 既定では一時ディレクトリをユーザデータに使い、終了時に削除する。同意がある場合のみ `.image-upload/browser-profile/`(Git管理外)に保存する
- **Rationale**: 新しい秘密情報を既定で残さない。利便性は利用者が選べる
- **Follow-up**: 一時ディレクトリの削除は再帰的な `unlinkSync` で行い、失敗したらログに残す

### Decision: 作業用下書きのURLを記録して再利用する
- **Context**: 要件9.1(作業用下書きを最小限にする)
- **Selected Approach**: 初回に作成された作業用下書きのURLを設定ファイルに記録する。以後の実行ではその下書きの編集画面を開き、開けない場合だけ新規作成する
- **Rationale**: 実行のたびに下書きが増えるのを防ぐ
- **Trade-offs**: 利用者がその下書きを削除すると、次回は新規作成に戻る(問題はない)

## Risks & Mitigations
- Qiitaの画面変更で自動化が壊れる — セレクタ・URL判定を `qiitaEditorProfile` に集約する。実行開始時に画面要素の存在を確かめ、なければ中止して手動手順へ案内する(8.1)
- 規約上の扱い・アカウント凍結の可能性 — 初回有効化時に同意を取る(1.4)。明示操作ごと・直列・1枚ずつに限定する
- セッション情報の漏洩 — 既定で保存しない。保存先はGit管理外の専用フォルダ。ログに出さない(5.x, 11.3)
- 実ブラウザを使うテストがCI環境で動かない — ブラウザ操作はインターフェースの裏に隠し、ユニット・統合テストは偽アダプタで行う。実ブラウザの確認は、ブラウザがある環境だけで実行する任意テストにする
- 容量上限の仕様が不明 — 上限値は定数にし、実装時に確認する。超過で拒否されてもURLが得られない失敗として安全に扱う

## References
- [Qiita利用規約](https://qiita.com/terms) — 第11条・第12条(禁止事項とアカウント凍結)
- [Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype) — `launchPersistentContext` と `channel`
- [playwright-core (npm)](https://www.npmjs.com/package/playwright-core) — 2026-10-25時点 1.64.1
- [Qiita画像アップロード上限についての個人記事(2018年)](https://qiita.com/saiteu/items/49f5415fe7043357a053) — 容量制限の参考(現行値は未確認)
