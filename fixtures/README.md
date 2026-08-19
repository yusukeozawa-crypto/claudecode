# fixtures — テストデータ

## mock-site/

QA ツール自体の動作確認用モックサイト。`local` 環境で **2 つのサーバー** が自動起動する
(`playwright.config.ts` の `webServer`)。実サイトの準備なしに全テストを実行できる。

| サーバー | 既定 URL | 役割 |
|---|---|---|
| `server.mjs` | http://127.0.0.1:4173 | LP ドメイン |
| `application-server.mjs` | http://localhost:4174 | 申込ドメイン (**別オリジン**) |

ホスト名を変えているため、LP 側の Cookie は申込側へ共有されない
(実サイトと同じ「別ドメインへの引き継ぎ」を再現している)。

```bash
npm run mock:serve                # LP ドメインのみ起動
npm run mock:serve:application    # 申込ドメインのみ起動
```

### 代理店マスタ (`agency-master.mjs`)

LP 側と申込側の双方が参照する「サイト仕様」データ。**検査対象 (SUT) 側の実装**であり、
テストの期待値は `config/agencies.yml` で管理する。

| コード | リダイレクト | 引き継ぎ方式 | 表示 |
|---|---|---|---|
| `A001` | なし (`/lp/` のまま) | URL クエリ (`agency_code`) | 共通 LP に代理店セクション |
| `A002` | **HTTP 302** → `/partner/a002/` | **一時トークン** (`handoff_token`) | 代理店専用 LP |
| `A003` | **meta refresh** → `/partner/a003/` | **hidden + POST** | 代理店専用 LP |

3 種類のリダイレクト方式と 3 種類の引き継ぎ方式を意図的に用意しており、
検出ロジックが方式の違いを判別できることを確認できる。

### LP ドメインのページ

| パス | 対応する id | 内容 |
|---|---|---|
| `/` | — | `/lp/` へ 302 |
| `/lp/` | `lp` | 共通 LP (代理店セクション・CTA) |
| `/partner/a002/` | `partner-a002` | A002 専用 LP |
| `/partner/a003/` | `partner-a003` | A003 専用 LP |
| `/product.html` | `product` | 商品詳細 |
| `/price.html` | `price` | 保険料 |
| `/faq.html` | `faq` | FAQ |
| `/agency.html` | `agency-only` | 代理店専用表示ページ |
| `/sitemap.xml` | — | `source: sitemap` の動作確認用 |

代理店コンテキスト (表示セクション・代理店名・電話番号・バナー・CTA) は
サーバーが `window.__AGENCY_CONTEXT__` として埋め込み、`assets/agency.js` が描画する
(実サイトのサーバーサイドレンダリングを模したもの)。
URL パラメータの値は `textContent` 経由でのみ設定し、HTML へそのまま出力しない。

### 申込ドメインのページ

| パス | 内容 |
|---|---|
| `/entry/` | 申込 1/3。クエリ / トークン / POST のいずれかでコードを受け取り、自ドメインのセッション Cookie に保存 |
| `/entry/step2/` | 申込 2/3 (セッションから代理店を復元) |
| `/entry/confirm/` | 申込 3/3 |
| `/api/session` | 申込側が認識している代理店を返す (`agency_code` / `agency_name`) |
| `/entry/complete` | 申込完了。**テストからは呼ばれない** (フィクスチャが遮断する) |

無効なコードを受け取った場合はセッションを作らず、通常経路 (`application-default-route`) を表示する。

### 検出ロジック検査用ページ (`broken/`)

`tests/self-check/detectors.spec.ts` が使用する、意図的に壊したページ。

| ファイル | 仕込んだ不具合 |
|---|---|
| `overflow.html` | SP 幅より広い固定幅要素 (横スクロール) + 重なり要素 |
| `js-error.html` | `console.error` と未捕捉例外 |
| `broken-image.html` | 存在しない画像への参照 (404) |
| `broken-link.html` | 404 / 500 / リダイレクトループへのリンク |
| `typos.html` | 表記揺れ・誤字・正式名称の誤表記・使用禁止表現・全角英数字 |

LP サーバー側も検査用エンドポイントを提供する。

| パス | 応答 |
|---|---|
| `/slow?ms=N` | N ミリ秒待ってから 200 (上限 5000ms)。タイムアウト検知の検証用 |
| `/server-error` | 500 |
| `/redirect-loop-a` / `/redirect-loop-b` | 相互に 302 (リダイレクトループ) |

### 注意

モックサイトは QA ツールの動作確認専用であり、実在の商品・会社とは関係ない。
実サイトへ向ける際にこのディレクトリを変更する必要はない。
