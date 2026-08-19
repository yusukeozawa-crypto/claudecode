# fixtures — テストデータ

## mock-site/

QA ツール自体の動作確認用モックサイト。`local` 環境で自動起動する
(`playwright.config.ts` の `webServer`)。実サイトの準備なしに全テストを実行できる。

```bash
npm run mock:serve      # 単体起動 (http://127.0.0.1:4173)
```

### 正常系ページ

`config/pages.yml` の既定定義と対応している。

| ファイル | 対応する id | 内容 |
|---|---|---|
| `index.html` | `top` | トップページ (メインビジュアル・申込ボタン・カルーセル) |
| `product.html` | `product` | 商品詳細 |
| `price.html` | `price` | 保険料 (表) |
| `faq.html` | `faq` | FAQ |
| `application.html` | `application` | 申込入力画面 (hidden 項目つき) |
| `agency.html` | `agency-only` | 代理店専用表示ページ |
| `sitemap.xml` | — | `source: sitemap` の動作確認用 |

### 代理店コードの実装 (`assets/agency.js`)

`config/agency.yml` の仮置き仕様をそのまま実装している。

1. URL パラメータ `agency_code` を受け取ると Cookie と localStorage に保存する
2. 保存済みのコードはページ遷移後も引き継ぐ (サイト内リンクにも付与する)
3. 有効コード (`A001` / `B002`) なら代理店セクションを表示し既定セクションを隠す
4. 無効コードは保存せず、フォールバック表示を出す
5. 申込画面へは URL パラメータと hidden 項目で引き継ぐ

### 検出ロジック検査用ページ (`broken/`)

`tests/self-check/detectors.spec.ts` が使用する、意図的に壊したページ。

| ファイル | 仕込んだ不具合 |
|---|---|
| `overflow.html` | SP 幅より広い固定幅要素 (横スクロール) + 重なり要素 |
| `js-error.html` | `console.error` と未捕捉例外 |
| `broken-image.html` | 存在しない画像への参照 (404) |
| `broken-link.html` | 404 / 500 / リダイレクトループへのリンク |
| `typos.html` | 表記揺れ・誤字・正式名称の誤表記・使用禁止表現・全角英数字 |

サーバー側 (`server.mjs`) も検査用エンドポイントを提供する。

| パス | 応答 |
|---|---|
| `/api/application` | 申込 API のモック (200) |
| `/server-error` | 500 |
| `/redirect-loop-a` / `/redirect-loop-b` | 相互に 302 (リダイレクトループ) |

### 注意

モックサイトは QA ツールの動作確認専用であり、実在の商品・会社とは関係ない。
実サイトへ向ける際にこのディレクトリを変更する必要はない。
