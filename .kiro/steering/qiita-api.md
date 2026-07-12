# Qiita API 利用規約(プロジェクト標準)

本プロジェクトがQiitaへアクセスする際の標準パターン。詳細な調査根拠は
[research/qiita-api接続方法調査.md](../../research/qiita-api接続方法調査.md) を参照。

## 基本方針

- **Qiita API v2 のみ**を使用する。Webページのスクレイピング・ログインフォームの自動操作は行わない
  (理由: 非公式手段は画面変更で破損し、利用規約上もグレーなため。v1.2で方式決定済み)
- 通信方向は **Qiita → ローカルの読み取り専用**。書き込み系エンドポイント(POST/PATCH/DELETE)は使用しない
- ベースURL: `https://qiita.com/api/v2`(TLS必須、レスポンスはJSON、日時はISO 8601)

## 認証パターン

```http
Authorization: Bearer {QIITA_ACCESS_TOKEN}
```

- トークンは個人用アクセストークン(スコープ: `read_qiita` のみ)
- トークン検証は `GET /api/v2/authenticated_user` で行う(200=有効、401=無効、403=権限不足)
- トークンの取り扱い規律は [security.md](security.md) に従う

## 使用エンドポイント

| 用途 | エンドポイント | 備考 |
|---|---|---|
| 接続確認・総記事数 | `GET /authenticated_user` | `items_count` で全件取得の完了判定 |
| 記事一覧+本文 | `GET /authenticated_user/items?page={n}&per_page=100` | **`body` がraw Markdown。記事ごとの個別GETは不要**(レート節約) |
| 記事単体(補助) | `GET /items/:item_id` | 通常は使わない |

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
