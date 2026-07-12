# Qiita API 接続方法 調査報告

| 項目 | 内容 |
|---|---|
| 調査日 | 2026-07-12 |
| 調査目的 | Qiita記事バックアップツール([外部要件書](../docs/外部要件書.md))の内部設計に向けた、Qiitaからの記事・画像取得手段の技術調査 |
| 主な情報源 | [Qiita API v2 公式ドキュメント](https://qiita.com/api/v2/docs) ほか(末尾の参考資料参照) |

---

## 1. 結論サマリ

| 観点 | 結論 |
|---|---|
| 推奨接続方式 | **個人用アクセストークン(スコープ `read_qiita`)によるQiita API v2** が最も安定・簡単・公式サポートあり |
| 記事Markdown取得 | `GET /api/v2/items/:item_id` および `GET /api/v2/authenticated_user/items` のレスポンス `body` フィールドが **raw Markdown**。追加のスクレイピング不要 |
| 限定共有記事 | `authenticated_user/items` で自分の限定共有記事(`private: true`)も取得可能 |
| 画像取得 | 記事Markdown中の画像URL(`camo.qiitausercontent.com` / `qiita-image-store.s3.*`)は **認証不要のHTTP GETでダウンロード可能** |
| レート制限 | 認証ありで **1,000リクエスト/時**。記事300件+画像規模なら差分バックアップ運用で十分収まる |
| ID/パスワード+2FAサインイン方式 | 技術的には可能(フォームPOST or ブラウザ自動操作)だが、**非公式・脆弱・実装コスト大**。要件書の前提の再検討を推奨(9章) |

---

## 2. Qiita API v2 の全体像

- ベースURL: `https://qiita.com/api/v2/`(Qiita Teamは `https://*.qiita.com/api/v2/`)
- 全エンドポイントで **TLS(HTTPS)必須**
- リクエスト/レスポンスは **JSON**。ボディを送る場合は `Content-Type: application/json`
- 日時は **ISO 8601形式**(例: `2026-07-10T18:24:00+09:00`)
- 成功時ステータス: GET/PATCH → `200`、POST → `201`、PUT/DELETE → `204`
- エラー時ステータス: `400` / `401` / `403` / `404` / `429`(レート制限超過)/ `500`

エラーレスポンスの形式:

```json
{
  "message": "Not found",
  "type": "not_found"
}
```

---

## 3. 認証方式(3通り)

### 3.1 個人用アクセストークン(推奨)

もっとも簡単な方式。OAuthアプリ登録不要で、ユーザ自身が画面から発行する。

**発行手順:**

1. Qiitaにブラウザでサインイン(このとき2FAはブラウザ上で通常どおり実施)
2. 「設定」→「アプリケーション」→「個人用アクセストークン」→「新しくトークンを発行する」
3. スコープを選択して発行(読み取り専用バックアップなら **`read_qiita` のみ** でよい)
4. トークンは **発行直後の1回しか表示されない** ため、その場でコピーして `.env` 等に保存する

**使い方(リクエストヘッダ):**

```http
Authorization: Bearer 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd
```

```bash
curl -H "Authorization: Bearer $QIITA_TOKEN" \
  "https://qiita.com/api/v2/authenticated_user/items?page=1&per_page=100"
```

**スコープ一覧:**

| スコープ | 権限 |
|---|---|
| `read_qiita` | Qiitaのデータ読み取り(限定共有記事含む自分のデータ) |
| `write_qiita` | Qiitaへの書き込み |
| `read_qiita_team` / `write_qiita_team` | Qiita Team用(本プロジェクト対象外) |

> バックアップは単方向(Qiita→ローカル)なので `write_qiita` は不要。最小権限の原則からも `read_qiita` のみとすべき。

### 3.2 OAuth 2.0 認可コードフロー

第三者に配布するアプリ向けの方式。アプリケーション登録をして `client_id` / `client_secret` を得る。

1. ユーザを認可URLへ誘導:
   `GET https://qiita.com/api/v2/oauth/authorize?client_id={client_id}&scope=read_qiita&state={ランダム値}`
2. ユーザが許可すると `redirect_uri` に `code`(と `state`)が返る
3. コードをトークンに交換:

```http
POST /api/v2/access_tokens
Content-Type: application/json

{
  "client_id": "a91f0396...",
  "client_secret": "01fc259c...",
  "code": "fefef5f0..."
}
```

レスポンス(`201 Created`):

```json
{
  "client_id": "a91f0396...",
  "scopes": ["read_qiita"],
  "token": "ea5d0a59..."
}
```

- トークン無効化: `DELETE /api/v2/access_tokens/:access_token` → `204`
- 取得後の使い方は個人用アクセストークンと同じ(`Authorization: Bearer`)

> 本ツールは自分専用のローカルツールなので、OAuthアプリ登録の手間をかける意義は薄い。

### 3.3 ID/パスワード+2FAによるセッション認証(非公式・スクレイピング)

外部要件書 v1.1 が前提としている方式。公式APIの認証手段ではなく、Web画面のログインフォームを模倣する。

**仕組み(HTTPクライアント直叩きの場合):**

1. `GET https://qiita.com/login` でログインページを取得し、HTML内の `authenticity_token`(RailsのCSRFトークン)とセッションCookieを取得
2. `POST https://qiita.com/login` に `identity`(ID/メール)・`password`・`authenticity_token` を送信
3. 2FA有効アカウントの場合、2段階認証コード入力ページへ遷移するので、ユーザが入力したコードを同様にPOST
4. 成功するとセッションCookieが認証済みになり、以後そのCookieでページ取得が可能

**代替: ブラウザ自動操作(Playwright / Selenium)** — 実ブラウザでログインフローを再現し、2FA入力欄にユーザ入力値を流し込む。CSRFやJS依存の変化に強いが、ブラウザ同梱で配布サイズ・実行環境が重くなる。

**この方式の問題点:**

- Qiitaの画面構造・ログインフロー変更で **いつでも壊れる**(公式互換性保証なし)
- CAPTCHA・ボット検知が導入された場合に突破不可(突破を試みるべきでもない)
- 平文パスワードを `.env` に保持することになり、トークン方式(漏洩時に失効・権限限定が可能)よりセキュリティ上不利
- 利用規約上、自動化アクセスはAPI経由が想定されており、スクレイピングはグレー

**注目点:** セッションCookieを持っていても、記事のraw Markdownを安定して取るには結局 API(または後述の `.md` URL)を使うことになる。つまりこの方式の利点はほぼない。

---

## 4. 記事取得に使うエンドポイント

### 4.1 認証中ユーザ情報 — `GET /api/v2/authenticated_user`

トークンの有効性確認と、総記事数の取得に使える。

| フィールド | 型 | 内容 |
|---|---|---|
| `id` | string | ユーザID(@なし) |
| `items_count` | integer | 投稿記事数(**全件取得時の完了判定に利用可**) |
| `profile_image_url` | string | プロフィール画像URL |
| `image_monthly_upload_remaining` | integer | 月間画像アップロード残容量 |

### 4.2 自分の記事一覧 — `GET /api/v2/authenticated_user/items`(本命)

認証中ユーザの記事一覧を作成日時の降順で返す。**限定共有記事(`private: true`)も含まれる**(公開記事のみでよい場合は `private` フィールドでフィルタする)。

| パラメータ | 範囲 | 既定値 |
|---|---|---|
| `page` | 1〜100 | 1 |
| `per_page` | 1〜100 | 20 |

### 4.3 記事1件取得 — `GET /api/v2/items/:item_id`

一覧と同じ記事オブジェクトを返す。一覧レスポンスに `body` が含まれるため、**通常は一覧取得だけでMarkdownまで揃い、記事ごとの個別GETは不要**(=レート消費を大幅節約できる)。

**記事オブジェクトの主要フィールド:**

| フィールド | 型 | バックアップでの用途 |
|---|---|---|
| `id` | string | 記事ID(フォルダ名・同一性判定キー) |
| `title` | string | タイトル(フォルダ名・ファイル名) |
| `body` | string | **raw Markdown本文(保存対象そのもの)** |
| `rendered_body` | string | HTML変換済み本文(不要。転送量が増えるだけ) |
| `created_at` / `updated_at` | date-time | Qiita側更新検知(`index.json` に記録) |
| `url` | string | 記事URL(meta.json に記録) |
| `private` | boolean | 公開/限定共有の区別 |
| `tags` | array | タグ(`[{"name": "...", "versions": [...]}]`) |
| `comments_count` / `likes_count` / `stocks_count` / `reactions_count` | integer | 参考情報としてmeta.jsonに記録可 |
| `page_views_count` | integer \| null | 通常null(取得不可) |
| `user` | object | 投稿者情報 |

### 4.4 (参考)他ユーザの公開記事 — `GET /api/v2/users/:user_id/items`

公開記事のみ。認証なしでも呼べる(レート制限60回/時)。本プロジェクトでは限定共有記事が漏れるため使わない。

### 4.5 (参考)API外の代替: 記事URL + `.md`

Qiitaは記事URLの末尾に `.md` を付けると raw Markdown をそのまま返す公式機能を持つ(ヘルプ「[Qiitaの投稿をMarkdown表示にする方法](https://help.qiita.com/ja/articles/qiita-show-raw-body)」)。

```bash
curl -s "https://qiita.com/nagura/items/xxxxxxxxxxxxxxxxxxxx.md"
```

- APIトークンなしで取得できる(公開記事のみ。限定共有はセッション認証が必要)
- ただしメタデータ(更新日時等)が取れないため、一覧はどのみちAPIが必要。**APIの `body` で足りる本プロジェクトでは補助手段の位置づけ**

---

## 5. ページネーション

- `page`(1〜100)と `per_page`(1〜100)で制御
- レスポンスヘッダ:
  - `Total-Count`: 総件数
  - `Link`: RFC5988形式で `first` / `prev` / `next` / `last` のURLを返す

```http
Link: <https://qiita.com/api/v2/authenticated_user/items?page=2&per_page=100>; rel="next",
      <https://qiita.com/api/v2/authenticated_user/items?page=3&per_page=100>; rel="last"
Total-Count: 242
```

**全件取得の実装方針:** `per_page=100` で `page` を1から進め、`Link` ヘッダの `next` が無くなる(またはレスポンスが空配列になる)まで繰り返す。`page` 上限が100のため取得可能上限は10,000件(個人記事では実質問題なし)。

---

## 6. レート制限

| 状態 | 制限 |
|---|---|
| 認証あり(トークン付き) | **1,000リクエスト/時**(ユーザ単位) |
| 認証なし | 60リクエスト/時(IPアドレス単位) |

- 超過時は `429 Too Many Requests` (エラーtype: `rate_limit_exceeded`)
- 残回数はレスポンスヘッダで通知される。公式ドキュメントにヘッダ名の明記はないが、実際のレスポンスでは `Rate-Limit` / `Rate-Remaining` / `Rate-Reset`(リセット時刻のUNIX時間)が返ることが広く報告されている。**実装時は実レスポンスで名前を確認し、`Rate-Remaining` を監視して閾値を下回ったら `Rate-Reset` まで待機する制御を推奨**
- 画像ファイルのダウンロードはAPIではなくCDN/プロキシへのアクセスのため、このレート制限とは別枠。ただしサーバ負荷への配慮として直列+数百ms程度の間隔を置くのが行儀がよい

**本プロジェクトの消費見積り(記事300件想定):**

| 処理 | リクエスト数 |
|---|---|
| 記事一覧取得(per_page=100) | 3回(bodyも同時に取得済み) |
| 認証確認 | 1回 |
| 合計(API) | **4回/同期** — 1,000回/時に対して余裕 |
| 画像ダウンロード | 記事外アクセス(レート制限対象外)。300記事×10枚=3,000ファイル |

---

## 7. 画像の取得方法

記事Markdown中の画像は主に次の2種類のURLで現れる:

| URL | 実体 |
|---|---|
| `https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/...` | Qiitaにアップロードされた画像(S3直リンク) |
| `https://camo.qiitausercontent.com/{hex}/...` | Camoプロキシ経由URL。外部画像やS3画像がプロキシされたもの |

- どちらも **認証不要の GET でダウンロード可能**(限定共有記事に貼った画像も、URLを知っていればアクセスできる仕様)
- Camo URLのパス部分はプロキシ元URLのhexエンコードであり、デコードすれば元URLを復元できるが、**バックアップ用途ではCamo URLをそのままGETすれば足りる**
- 拡張子がURLに含まれない場合があるため、レスポンスの `Content-Type` から拡張子を決定する(要件 F-DIR-04 と整合)
- `<img src="...">` タグ(HTML直書き)とMarkdown記法 `![alt](url)` の両方を抽出対象にする(要件 F-BK-05 と整合)

---

## 8. 実装サンプル(Node.js)

```javascript
const BASE = "https://qiita.com/api/v2";
const headers = { Authorization: `Bearer ${process.env.QIITA_TOKEN}` };

// 全記事(限定共有含む)を body 付きで取得
async function fetchAllItems() {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const res = await fetch(
      `${BASE}/authenticated_user/items?page=${page}&per_page=100`,
      { headers }
    );
    if (res.status === 429) throw new Error("rate limit exceeded");
    const batch = await res.json();
    items.push(...batch);
    if (!/rel="next"/.test(res.headers.get("link") ?? "")) break;
  }
  return items; // 各要素の item.body が raw Markdown
}

// Markdownから画像URLを抽出
function extractImageUrls(markdown) {
  const urls = new Set();
  for (const m of markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)/g)) urls.add(m[1]);
  for (const m of markdown.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/g)) urls.add(m[1]);
  return [...urls];
}
```

---

## 9. 本プロジェクトへの適用提案(要件書へのフィードバック)

3方式の比較:

| 観点 | ①個人用アクセストークン | ②OAuth | ③ID/PW+2FAセッション |
|---|---|---|---|
| 公式サポート | ◎ | ◎ | ✕(非公式) |
| 実装コスト | ◎ 最小 | △ アプリ登録+コールバック | ✕ ログインフロー模倣/ブラウザ同梱 |
| 安定性 | ◎ | ◎ | ✕ 画面変更で破損 |
| 限定共有記事の取得 | ◎ | ◎ | △(画面経由) |
| セキュリティ | ◎ 読取専用・失効可能 | ◎ | ✕ 平文パスワード保持 |
| 2FAとの関係 | 発行時にブラウザで1回だけ | 認可時にブラウザで1回だけ | 実行のたびにコード入力 |
| ユーザの初期作業 | トークン発行(1〜2分) | ほぼ不要(アプリ側登録は開発者) | `.env` にID/PW記載 |

**推奨: 方式①(個人用アクセストークン)への要件変更。**

- 現要件(F-AUTH-01/02: `.env` のID/PW+画面での2FA入力)は方式③を意味するが、上表のとおり利点がほぼなく、保守リスクとセキュリティリスクだけが残る
- 方式①なら「2FAはユーザ入力」という要望は「**トークン発行時にユーザ自身がブラウザで2FAを通す**」ことで自然に満たされる(ツール側に2FA処理は不要になる)
- `.env` は `QIITA_ACCESS_TOKEN=xxxx` の1行になり、要件書 4.1 のサインイン画面は「トークン検証+ユーザ名表示」に簡素化できる
- どうしてもID/PW方式を維持する場合は、Playwright等のブラウザ自動操作(方式③)で実装し、「Qiita側の画面変更で動作しなくなるリスクを許容する」旨を制約事項に追記すべき

---

## 10. 参考資料

- [Qiita API v2 ドキュメント(公式)](https://qiita.com/api/v2/docs)
- [Qiitaの投稿をMarkdown表示にする方法(公式ヘルプ)](https://help.qiita.com/ja/articles/qiita-show-raw-body)
- [画像のアップロード・削除方法(公式ヘルプ)](https://help.qiita.com/ja/articles/qiita-image-upload)
- [Qiita API v2 を使って自身の全投稿をエクスポートする Python スクリプト](https://qiita.com/sta/items/5074df5fcb81d890897b)
- [Qiita 記事を Markdown (.md) ファイルとしてダウンロードして保存する方法](https://qiita.com/IoriGunji/items/610dc1b6b3e64feb2469)
- [Qiita の記事を markdown で一括取得するコマンド](https://blog.yumenomatayume.net/2021/08/17/03/)
- [Qiita:Teamの記事をダウンロードして Markdown + 画像 にする](https://qiita.com/567000/items/8ff81a0d0eba53cc52a5)
- [Camoでプロキシした画像の元URLを展開するワンライナー](https://qiita.com/tomoasleep/items/c5cfa16e9ea9e9306e23)
- [Qiita APIのレート制限を気にせず大量取得する方法](https://qiita.com/kotajobs0/items/1d8c4ae8c86516e25b2b)
- [Pythonでqiitaにログインしてみる(セッション認証の例)](https://qiita.com/sssssssiiiiinnn/items/14f7035abe9ce4111323)
- [Qiitaに投稿した内容をローカルにバックアップする](https://blog.bedrock.day/008b1bade5ec7792df14)
