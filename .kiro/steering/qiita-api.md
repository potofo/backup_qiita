# Qiita API 利用規約(プロジェクト標準)

本プロジェクトがQiitaへアクセスする際の標準パターン。詳細な調査根拠は
[research/qiita-api接続方法調査.md](../../research/qiita-api接続方法調査.md) を参照。

## 基本方針

- **Qiita API v2 のみ**を使用する。Webページのスクレイピング・ログインフォームの自動操作は行わない
  (理由: 非公式手段は画面変更で破損し、利用規約上もグレーなため。v1.2で方式決定済み)
  - **唯一の例外: 画像アップロード**(image-upload-automation)。Qiita API v2 に画像アップロード手段がないため、
    利用者が有効化+同意し、実行ごとに承認した場合に限り、画面ありブラウザでQiitaエディタへ画像を投入する。
    ログインは利用者が手で行い(ログインフォームは自動操作しない)、記事の保存・投稿・公開・設定変更は画面から行わない。
    画面の前提(URL・セレクタ・許可ホスト)は `src/infra/qiitaEditorProfile.ts` に集約する
- バックアップ(ダウンロード)は **Qiita → ローカルの読み取り専用**
- 書き込み(POST/PATCH)は**アップロード機能の明示的なユーザ操作に限定**する
  (article-upload-sync 8.1)。自動同期・定期実行による書き込みは行わない。
  **DELETEは実装しない**(記事の削除同期はスコープ外 — 8.2)
- ベースURL: `https://qiita.com/api/v2`(TLS必須、レスポンスはJSON、日時はISO 8601)

## 認証パターン

```http
Authorization: Bearer {QIITA_ACCESS_TOKEN}
```

- トークンは個人用アクセストークン(スコープ方針は [security.md](security.md) 参照:
  バックアップのみ= `read_qiita` / アップロード利用時= `read_qiita` + `write_qiita`)
- トークン検証は `GET /api/v2/authenticated_user` で行う(200=有効、401=無効、403=権限不足)
- **スコープ照会APIは存在しない**。書き込み権限は実績ベース
  (`writeAccess: unknown/granted/denied`)で管理し、denied既知時のみ事前拒否する
- トークンの取り扱い規律は [security.md](security.md) に従う

## 使用エンドポイント

| 用途 | エンドポイント | 備考 |
|---|---|---|
| 接続確認・総記事数 | `GET /authenticated_user` | `items_count` で全件取得の完了判定 |
| 記事一覧+本文 | `GET /authenticated_user/items?page={n}&per_page=100` | **`body` がraw Markdown。記事ごとの個別GETは不要**(レート節約) |
| 記事単体(補助) | `GET /items/:item_id` | 通常は使わない |

### 書き込みエンドポイント(アップロード機能 — 明示的なユーザ操作に限定)

| 用途 | エンドポイント | 備考 |
|---|---|---|
| 記事の新規登録 | `POST /items` | 必須: `title`/`body`/`tags`。**常に `private: true`(限定共有)+ `tweet: false`** で送信(誤公開防止 — 下書きAPIは存在しない) |
| 記事の本文更新 | `PATCH /items/:item_id` | **`title`・`body` が必須**。`private` は省略時挙動が未文書のため**現在値を常に明示送信**(公開範囲を変更しない) |

- 書き込みは1記事ずつ直列で行い、レスポンスの Item(`updated_at` 含む)で管理情報を即時更新する
- スコープ不足の書き込みは 403 を返す。初回403で残り全件を中止し再発行を案内する

レスポンスで使うフィールド: `id`, `title`, `body`, `created_at`, `updated_at`, `url`,
`private`, `tags`, `comments_count`, `likes_count`, `stocks_count`
(`rendered_body` は転送量が大きいだけなので参照しない)

## ページネーション

```javascript
// per_page=100 固定、Linkヘッダの rel="next" が無くなるまで page を進める
for (let page = 1; page <= 100; page++) {
  const res = await fetch(`${BASE}/authenticated_user/items?page=${page}&per_page=100`, { headers });
  items.push(...await res.json());
  if (!/rel="next"/.test(res.headers.get("link") ?? "")) break;
}
```

- 総件数は `Total-Count` ヘッダで取得できる
- 仕様上の取得上限は 10,000件(`page`≦100 × `per_page`≦100)

## レート制限への対応

- 認証ありで **1,000リクエスト/時**(ユーザ単位)。通常運用では一覧取得3〜4回/同期で収まる
- レスポンスヘッダ `Rate-Remaining` / `Rate-Reset` を監視する
  (ヘッダ名は公式ドキュメント未記載のため、実装時に実レスポンスで確認してから定数化する)
- **HTTP 429 は即時リトライしない**。`Rate-Reset`(UNIX時間)まで待機してから再開する

## 画像ダウンロード

- 記事Markdown中の画像URL(`camo.qiitausercontent.com` / `qiita-image-store.s3.*`)は
  **認証不要のGET**で取得する。**`Authorization` ヘッダを絶対に付けない**(トークン漏洩防止)
- APIレート制限の対象外だが、直列+数百msの間隔を置く(サーバ負荷への配慮)
- 拡張子はURLではなくレスポンスの `Content-Type` から決定する(Camo URLは拡張子を持たないため)

## エラー処理パターン

| 状況 | 対応 |
|---|---|
| 401 / 403 | 処理中断。トークン再発行の案内を表示(F-AUTH-03) |
| 429 | `Rate-Reset` まで待機して継続(F-BK-12) |
| 5xx・ネットワークエラー | 記事単位でリトライ(上限あり)。超過時は当該記事を失敗記録し、全体は継続(N-PERF-02) |
| 画像取得失敗 | 記事全体を失敗にしない。参照は元URLのまま残し、失敗を記録(F-BK-08) |

エラーレスポンス形式: `{ "message": "...", "type": "..." }`
