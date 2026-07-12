# Requirements Document

## Project Description (Input)
./docs/外部要件書.md ./docs/images/*.svg

Qiita記事バックアップツール — Qiita API v2(個人用アクセストークン)で自分の全記事(限定共有含む)のMarkdownと画像をローカルへ単方向バックアップし、状態管理・更新検知とローカルGitによる世代管理を行うローカルWebツール。

入力資料:
- [docs/外部要件書.md](../../../docs/外部要件書.md)(v1.6。入力指定の「外部要件且.md」は本ファイルへ読み替え)
- [docs/images/screen-01-signin.svg](../../../docs/images/screen-01-signin.svg)(接続確認画面)
- [docs/images/screen-02-dashboard.svg](../../../docs/images/screen-02-dashboard.svg)(記事一覧・ダッシュボード画面)
- [docs/images/screen-03-progress.svg](../../../docs/images/screen-03-progress.svg)(実行状況表示)

関連調査: [research/qiita-api接続方法調査.md](../../../research/qiita-api接続方法調査.md)、[research/qiita-アクセストークン発行方法.md](../../../research/qiita-アクセストークン発行方法.md)

## Introduction

本仕様は、Qiitaに投稿した個人の記事(本文Markdownおよび記事内画像)をローカルPCへバックアップするローカルWebツール「バックアップツール」の要件を定義する。バックアップの方向はQiita→ローカルの単方向であり、認証はQiita API v2の個人用アクセストークン(スコープ: `read_qiita`)を使用する。バックアップの世代管理はbackupフォルダを独立したローカルGitリポジトリとすることで実現する。

各受入基準の末尾に、外部要件書v1.6の要件ID(F-xxx / N-xxx)を対応付けて記載する。

## Boundary Context

- **In scope**: トークン認証(画面入力・`.env` 保存を含む)、本人の全記事(限定共有含む)の一覧取得・状態管理、Markdown+画像のバックアップと相対パス書き換え、ローカルGitによる世代管理、ローカルWeb UI
- **Out of scope**: ローカル→Qiitaの同期(投稿・更新・復元)、他ユーザ/Qiita Teamの記事、コメント本文等の詳細情報の保全、バックアップリポジトリのリモート同期(push/pull)、過去世代の閲覧・復元UI、ローカルバックアップの自動削除、定期実行スケジューラ、外部からのリンク数の表示(Qiita API v2で取得不可)
- **Adjacent expectations**: Qiita API v2の仕様([research/qiita-api接続方法調査.md](../../../research/qiita-api接続方法調査.md))、トークン発行手順([research/qiita-アクセストークン発行方法.md](../../../research/qiita-アクセストークン発行方法.md))、`.kiro/steering/` のqiita-api・security・documentation-standards規約に準拠する

## Requirements

### Requirement 1: 認証・接続確認(アクセストークン)

**Objective:** As a Qiita利用者, I want アクセストークンによる接続確認を`.env`または画面から行いたい, so that パスワード・2FAコードをツールに渡すことなく安全に自分の記事へアクセスできる

#### Acceptance Criteria

1. When ツールが起動した場合, the バックアップツール shall `.env` ファイルから `QIITA_ACCESS_TOKEN` を読み込む(F-AUTH-01)
2. When ユーザが接続確認を実行した場合, the バックアップツール shall Qiita APIの認証中ユーザ取得によりトークンの有効性を検証する(F-AUTH-01)
3. When 接続確認に成功した場合, the バックアップツール shall 対象アカウントのユーザIDと投稿記事数を画面に表示する(F-AUTH-02)
4. If トークンが未設定・無効(HTTP 401)・権限不足(HTTP 403)である場合, then the バックアップツール shall 原因が判別できるメッセージ、発行手順の案内(画面遷移手順・発行ページへの導線)、およびトークン入力欄を表示する(F-AUTH-03, F-AUTH-06)
5. When ユーザがトークン入力欄(マスク表示)からトークンを入力して接続確認を実行した場合, the バックアップツール shall 入力されたトークンで有効性を検証する(F-AUTH-07)
6. When 画面入力トークンでの接続確認に成功し、かつユーザが保存に同意している場合, the バックアップツール shall `.env` の `QIITA_ACCESS_TOKEN` を他の設定項目を破壊せずに更新する(F-AUTH-08)
7. If ユーザが保存に同意しなかった場合, then the バックアップツール shall トークンをメモリ上でのみ保持しツール終了時に破棄する(F-AUTH-08)
8. The バックアップツール shall 接続状態(未確認/接続済(@ユーザID)/トークン無効)を画面上に常時表示する(F-AUTH-04)

### Requirement 2: 記事一覧の取得と表示

**Objective:** As a 記事の作者, I want 自分の全記事の一覧を反応数・バックアップ状態付きで見たい, so that どの記事をバックアップすべきか一目で判断できる

#### Acceptance Criteria

1. When ユーザが一覧取得(再取得)を実行した場合, the バックアップツール shall トークンに紐づくアカウントの全記事(限定共有記事を含む)をページングを追跡して全件取得する(F-LIST-01, F-LIST-04)
2. The バックアップツール shall 記事一覧に記事ID・タイトル・作成日時・最終更新日時・記事URL・公開範囲・コメント数・いいね(LGTM)数・ストック数を保持する(F-LIST-02)
3. The バックアップツール shall 記事一覧を表形式で表示し、各記事行にバックアップ状態とコメント数・いいね数・ストック数を表示する(F-LIST-03, F-LIST-05)
4. The バックアップツール shall 記事一覧の状態・タイトルによる絞り込みまたはソートを提供する(4.6.2)
5. The バックアップツール shall 記事一覧から対象記事のローカル記事フォルダを開く導線を提供する(4.6.2)

### Requirement 3: バックアップ実行

**Objective:** As a 記事の作者, I want 全件・差分・選択の各モードで記事と画像をバックアップしたい, so that Qiita側の障害や誤削除に備えて記事資産をローカルに保全できる

#### Acceptance Criteria

1. When ユーザが全件バックアップを実行した場合, the バックアップツール shall すべての記事を対象にバックアップを実行する(F-BK-01)
2. When ユーザが一覧で記事を選択して個別バックアップを実行した場合, the バックアップツール shall 選択された記事のみを対象にバックアップを実行する(F-BK-02)
3. When ユーザが差分バックアップ(既定モード)を実行した場合, the バックアップツール shall 未バックアップの記事およびQiita側で更新のあった記事のみを対象にする(F-BK-03)
4. When 記事をバックアップする場合, the バックアップツール shall 本文をraw Markdown形式で取得し記事フォルダに保存する(F-BK-04)
5. When 記事本文に画像参照(Markdown記法または `<img>` タグ)が含まれる場合, the バックアップツール shall すべての画像を `images/` サブフォルダにダウンロード保存する(F-BK-05)
6. When 画像を保存した場合, the バックアップツール shall 閲覧用Markdown内の画像参照を `images/` への相対パスに書き換える(F-BK-06)
7. The バックアップツール shall 取得したままのMarkdownを `original.md` として併せて保存する(F-BK-07)
8. If 画像のダウンロードに失敗した場合, then the バックアップツール shall 当該参照を元URLのまま残し、失敗を記録したうえで記事のバックアップを継続する(F-BK-08)
9. While バックアップが実行中である間, the バックアップツール shall 進捗(処理済み件数/対象件数・処理中の記事名)を表示する(F-BK-09)
10. When ユーザが中断を指示した場合, the バックアップツール shall 処理完了済みの記事のバックアップを保持したまま実行を停止する(F-BK-10)
11. When 同一記事を再バックアップする場合, the バックアップツール shall 記事フォルダ内の既存ファイルを最新内容で上書きする(F-BK-11)
12. If Qiitaからレート制限超過(HTTP 429)が返された場合, then the バックアップツール shall レスポンスヘッダが示すリセット時刻まで待機して処理を継続する(F-BK-12)

### Requirement 4: バックアップフォルダ・ファイル構成

**Objective:** As a 記事の作者, I want 記事ごとに整理されたフォルダにMarkdownと画像が保存されてほしい, so that 一般的なMarkdownビューワでそのまま画像付きの記事を閲覧できる

#### Acceptance Criteria

1. The バックアップツール shall バックアップ先ルートを `backups/`(`.env` で変更可)とし、存在しない場合は自動作成する(F-DIR-01)
2. When 記事を保存する場合, the バックアップツール shall `{サニタイズ済みタイトル}_{記事ID}` 形式の記事フォルダを作成する(F-DIR-02)
3. The バックアップツール shall 記事フォルダに閲覧用Markdown・`original.md`・`meta.json`・`images/` を配置する(F-DIR-03)
4. The バックアップツール shall 画像ファイル名を登場順の連番+元ファイル名(ファイル名相当がないプロキシURL等は連番のみ)とし、拡張子をHTTPレスポンスのContent-Typeから決定する(F-DIR-04)
5. The バックアップツール shall `meta.json` に記事ID・タイトル・記事URL・公開範囲・タグ・作成/更新日時・コメント数/いいね数/ストック数・バックアップ実行日時・画像ダウンロード結果を記録する(F-DIR-05)
6. If 記事タイトルの変更により記事フォルダ名が変わる場合, then the バックアップツール shall 記事IDで同一記事と判定し既存フォルダをリネームする(F-DIR-06)

### Requirement 5: バックアップ状態管理・更新検知

**Objective:** As a 記事の作者, I want 各記事のバックアップ状態と更新の有無を管理したい, so that バックアップ漏れや陳腐化したバックアップを確実に検知できる

#### Acceptance Criteria

1. The バックアップツール shall 記事ごとの管理情報(記事ID・最終バックアップ日時・バックアップ時点のQiita側更新日時・保存ファイルのハッシュ値等)を `backups/index.json` で永続管理する(F-ST-01)
2. The バックアップツール shall 各記事を「未バックアップ/バックアップ済(最新)/Qiita側更新あり/ローカル変更あり/Qiita側削除」の5状態に分類して一覧に表示する(F-ST-02)
3. When Qiita側の最終更新日時がバックアップ時点の更新日時より新しい場合, the バックアップツール shall 当該記事を「Qiita側更新あり」に分類する(F-ST-02)
4. If ローカルの保存ファイルがバックアップ後に変更または削除されている場合, then the バックアップツール shall 当該記事を「ローカル変更あり」に分類する(F-ST-02)
5. When 「ローカル変更あり」の記事を再バックアップする場合, the バックアップツール shall ローカル変更がQiita側の内容で上書きされる旨の確認を行う(F-ST-03)
6. The バックアップツール shall 「Qiita側削除」の記事のローカルバックアップを自動削除しない(F-ST-04)
7. The バックアップツール shall 状態の集計値(全記事数・未バックアップ数・要再バックアップ数等)を画面に表示する(F-ST-05)
8. The バックアップツール shall バックアップ実行履歴(実行日時・対象件数・成功/失敗件数)を確認できるようにする(F-ST-06)

### Requirement 6: 世代管理(ローカルGit)

**Objective:** As a 記事の作者, I want バックアップの過去世代がローカルGitの履歴として残ってほしい, so that 上書き後も過去のバックアップ内容を参照・復元できる

#### Acceptance Criteria

1. If `backups/` フォルダがGitリポジトリとして未初期化である場合, then the バックアップツール shall ツール本体と独立したGitリポジトリとして自動初期化する(F-GIT-01)
2. The バックアップツール shall バックアップリポジトリに対するリモート登録・push・pullを行わない(F-GIT-02)
3. When バックアップ実行が完了(中断を含む)した場合, the バックアップツール shall 変更のあったファイルをすべてステージし、実行日時・対象件数・成功/失敗件数を含むメッセージで自動コミットする(F-GIT-03)
4. If 変更されたファイルが1件もない場合, then the バックアップツール shall コミットを作成しない(F-GIT-04)
5. When 記事フォルダのリネームが発生した場合, the バックアップツール shall リネームを含めてコミットし履歴を追跡可能にする(F-GIT-05)
6. If 実行環境でGitが利用できない場合, then the バックアップツール shall 警告を表示したうえで世代管理なし(最新1世代のみ)でバックアップを実行する(F-GIT-07)
7. The バックアップツール shall バックアップのコミットを常に `backup` ブランチで実行する(初期化時は初期ブランチを `backup` とし、既存リポジトリが別ブランチの場合は履歴を引き継いで `backup` ブランチへ切り替える)(F-GIT-08)
8. The バックアップツール shall バックアップリポジトリに pre-push フックを自動設置し、`backup` ブランチのpush(手動操作を含む)を拒否する。If ユーザ独自のpre-pushフックが既に存在する場合, then the バックアップツール shall フックを上書きしない(F-GIT-09)

### Requirement 7: Web UI

**Objective:** As a ユーザ, I want ブラウザから操作できるローカルWeb画面がほしい, so that コマンド操作なしで接続確認からバックアップ・進捗確認までを完結できる

#### Acceptance Criteria

1. When ツールを起動した場合, the バックアップツール shall ローカルWebサーバとして待ち受け、ブラウザでアクセスするURLを表示する(1.2, N-OPS-03)
2. The バックアップツール shall 接続確認画面(接続確認ボタン・接続状態表示・トークン発行手順案内・トークン入力欄・`.env` 保存同意)を提供する(4.6, screen-01)
3. The バックアップツール shall 記事一覧・ダッシュボード画面(状態集計タイル・一覧再取得/全件/差分/選択バックアップの操作・記事一覧表)を提供する(4.6, screen-02)
4. While バックアップが実行中である間, the バックアップツール shall 実行状況表示(進捗バー・処理中記事・記事単位の結果ログ・中断ボタン)を提供する(4.6, screen-03)
5. When バックアップ実行が完了した場合, the バックアップツール shall 結果サマリ(成功/失敗件数・画像取得失敗の一覧)を表示する(4.6, screen-03)

### Requirement 8: セキュリティ

**Objective:** As a ユーザ, I want トークンと記事データがローカルの外へ漏れない設計にしてほしい, so that 限定共有記事や認証情報を安全に保てる

#### Acceptance Criteria

1. The バックアップツール shall `.env` の内容(アクセストークン)を `qiita.com` 以外の外部サーバへ送信しない(N-SEC-01)
2. The バックアップツール shall アクセストークンを画面・ログに平文出力しない(表示時は末尾4桁程度のマスク表示)(N-SEC-02, F-AUTH-05)
3. The バックアップツール shall Webサーバをループバックアドレス(localhost)のみで待ち受ける(N-SEC-03)
4. The バックアップツール shall `.env` と `backups/` を `.gitignore` に含める構成を既定とし、`.env.example` を同梱する(N-SEC-04)
5. When `qiita.com` 以外のホスト(画像取得先等)へアクセスする場合, the バックアップツール shall `Authorization` ヘッダ等の認証情報を送信しない(N-SEC-05)

### Requirement 9: 性能・信頼性

**Objective:** As a ユーザ, I want 実用的な時間で確実に完了するバックアップがほしい, so that 記事数が増えても安心して運用を継続できる

#### Acceptance Criteria

1. The バックアップツール shall 記事300件・記事あたり画像10枚程度の規模の全件バックアップを30分以内に完了する(N-PERF-01)
2. If 通信エラーまたはQiita側の一時的エラーが発生した場合, then the バックアップツール shall 記事単位で上限付きリトライを行い、上限超過時は当該記事を失敗として記録し処理を継続する(N-PERF-02)
3. The バックアップツール shall `index.json` の書き込みをアトミックに行い、異常終了時にも管理情報を破損させない(N-PERF-03)

### Requirement 10: 運用・保守

**Objective:** As a ユーザ, I want 簡単に起動でき問題時に調査できるツールがほしい, so that 日常的なバックアップ運用を負担なく続けられる

#### Acceptance Criteria

1. The バックアップツール shall 実行ログをファイルに出力し、エラー発生時に原因調査を可能にする(N-OPS-01)
2. The バックアップツール shall Windows 11環境で動作する(N-OPS-02)
3. The バックアップツール shall 単一のコマンド(またはスクリプト)で起動できる(N-OPS-03)
