# Webサイト公開後 自動QAツール

Playwright + TypeScript による、Web サイト公開後の不具合自動検知ツールです。
PC / SP の両方で以下を自動検知します。

| # | 検知内容 | 実装 |
|---|---|---|
| 1 | 代理店コードごとのセクション表示・非表示 | `tests/agency/agency-display.spec.ts` |
| 2 | ページ遷移後の代理店コード保持 | 同上 |
| 3 | 代理店ごとの LP リダイレクト (経路・方式・ループ) | `tests/agency/agency-redirect.spec.ts` |
| 4 | 別ドメインの申込ページへの引き継ぎ | `tests/agency/agency-handoff.spec.ts` |
| 5 | 代理店コード起因のセキュリティ (open redirect / XSS / 情報漏えい) | `tests/security/agency-security.spec.ts` |
| 6 | 表示崩れ (はみ出し・重なり・空白画面) | `utils/layout.ts` |
| 7 | 横スクロール | 同上 |
| 8 | リンク切れ・リダイレクトループ | `utils/links.ts` |
| 9 | 画像読み込みエラー | `utils/layout.ts` / `utils/monitors.ts` |
| 10 | JavaScript エラー (console.error / pageerror) | `utils/monitors.ts` |
| 11 | 誤字脱字・表記揺れの候補抽出 | `utils/text-rules.ts` |
| 12 | スクリーンショット保存・基準画像比較 | `utils/screenshots.ts` |

**サイト固有の値はテストコードに一切書かれていません。** 対象 URL・端末・
**代理店ごとの個別仕様**・表示条件・文言ルールはすべて `config/*.yml` で管理します。

### 代理店コードは「有無」では判定しません

代理店コードごとに、最初に表示する LP・リダイレクトの有無と遷移先・表示/非表示セクション・
代理店名・電話番号・バナー・CTA の文言と遷移先・申込先ドメイン・引き継ぐ値がすべて異なります。
その差異は `config/agencies.yml` で管理し、**1 件追加すればその代理店のテストが自動生成されます**
(代理店ごとにテストコードを複製しません)。詳細は
[docs/agency-code-scenarios.md](docs/agency-code-scenarios.md)。

---

> **最短で動かしたい場合は [QUICKSTART.md](QUICKSTART.md) を見てください**（5分で動きます）。

## 1. 導入

### 必要環境

- Node.js 20 以上
- npm

### インストール

```bash
npm install                 # 依存関係
npm run prepare:browsers    # Chromium を取得 (初回のみ)
cp .env.example .env        # 環境変数テンプレートをコピー
```

### 動作確認 (対象サイトの準備不要)

リポジトリには検証用のモックサイト (`fixtures/mock-site`) が同梱されています。
`local` 環境で実行すると、モックサイトが自動起動して全テストが動きます。

```bash
npm test
```

初回実行時は基準画像 (`screenshots/baseline`) が作成され、2 回目以降は差分比較が行われます。
実行後、`reports/qa-report.html` に HTML レポートが生成されます。

```bash
npm run report              # レポートをブラウザで閲覧 (http://127.0.0.1:9323)
```

---

## 1.5 チームで使う場合

複数人が各自の PC で実行する場合の運用ルールです。

### 各メンバーの初回セットアップ

```bash
git clone <このリポジトリ>
cd <リポジトリ>
npm install
npm run prepare:browsers
cp .env.example .env      # URL を記入 (下記参照)
npm test                  # モックサイトで動作確認 (対象サイト不要)
```

Node.js のバージョンは `.nvmrc` に合わせてください (`nvm use`)。
`npm run typecheck` が通らない場合はバージョン違いを疑ってください。

### 共有するもの / しないもの

| 対象 | 扱い |
|---|---|
| `config/*.yml` (代理店仕様・ページ・ルール) | **リポジトリで共有**。全員が同じ期待値を使う |
| `screenshots/baseline/` | **リポジトリで共有**。ただし更新は CI のみ (下記) |
| `.env` (対象 URL・認証情報) | **共有しない**。各自が自分の PC に置く。値はパスワード管理ツール等で受け渡す |
| `reports/` `screenshots/current/` | 生成物。`.gitignore` 済み |

### 基準画像は各自の PC で更新しない

基準画像はフォント描画に依存するため、**Mac / Windows で更新すると CI と他メンバーで
差分が出続けます** (更新合戦になります)。`npm run update:screenshots` は
CI と同じ Linux 以外では中止するようになっています。

見た目を意図的に変更した場合の手順:

1. 変更をコミットして push する
2. CI (`self-test`) の Artifact から `screenshots/baseline` を取得する
3. それをコミットする

### 各メンバーの普段の実行

視覚差分は OS 差で Low が出るため、ローカルでは除外した実行を使うと結果が読みやすくなります。

```bash
npm run test:local              # 視覚差分以外をすべて実行 (モックサイト)
npm run test:local:staging      # 同じくステージング対象
```

視覚差分の判定は CI (Linux) に任せる、という分担です。

### 設定を変更するときの流れ

`config/agencies.yml` などを変更したら、**push して CI が緑になることを確認**してから
他メンバーに伝えてください。設定不備は起動時に検証されるため、
壊れた設定を共有してもすぐ気づけます。

---

## 2. 実行

### 対象環境の切り替え

`.env` に検査対象の URL を設定してから、環境を指定して実行します。

```bash
# .env
# LP ドメイン
STAGING_BASE_URL=https://staging.example.jp
PRODUCTION_BASE_URL=https://www.example.jp
# 申込ドメイン (LP とは別ドメイン)
STAGING_APPLICATION_BASE_URL=https://staging-application.example-insurance.jp
PRODUCTION_APPLICATION_BASE_URL=https://application.example-insurance.jp
```

> LP と申込ページは別ドメインであるため、両方の URL が必要です。
> 通常の Cookie は共有されないため、引き継ぎ方式は `npm run discover` で実測して確認します。

```bash
npm test                    # 既定環境 (config/environments.yml の defaultEnvironment)
npm run test:staging        # ステージング
npm run test:production     # 本番 (読み取り専用モード)
```

環境変数で直接指定することもできます。

```bash
QA_ENV=staging npx playwright test
```

### 実行コマンド一覧

| コマンド | 内容 |
|---|---|
| `npm test` | 全テストを実行 (既定環境) |
| `npm run test:staging` | ステージング環境で全テストを実行 |
| `npm run test:production` | 本番環境で全テストを実行 (読み取り・画面遷移のみ) |
| `npm run test:local` | 視覚差分以外をすべて実行 (各メンバーのローカル実行向け) |
| `npm run test:local:staging` | 同じくステージング対象 |
| `npm run test:pc` | PC (1440×900) のみ実行 |
| `npm run test:sp` | SP (390×844 / モバイル UA) のみ実行 |
| `npm run test:agency` | 代理店ごとのテスト (表示 / リダイレクト / 引き継ぎ) を実行 |
| `npm run test:redirect` | 代理店ごとの LP リダイレクトのみ実行 |
| `npm run test:handoff` | 別ドメイン申込ページへの引き継ぎのみ実行 |
| `npm run test:security` | セキュリティ検査のみ実行 |
| `npm run discover` | **実サイトの仕様調査** (引き継ぎ方式・リダイレクト経路を実測して記録) |
| `npm run test:visual` | スクリーンショット比較のみ実行 |
| `npm run test:crawl` | 基本巡回のみ実行 |
| `npm run test:health` | リンク切れ・エラー検知のみ実行 |
| `npm run test:text` | 誤字脱字・表記揺れチェックのみ実行 |
| `npm run shortcut` | デスクトップにショートカットを作る (Windows。`make-shortcut.cmd` のダブルクリックでも同じ) |
| `npm run ui` | **ブラウザの操作画面を開く** (run-qa.cmd と同じ入口。実行・進行状況・結果・ロジックと設定・履歴) |
| `npm run selftest:ui` | 操作画面の自己検査 (受付・公開範囲・URL 検証) |
| `npm run update` | ツール自身を最新版に更新 (Git 不要。`.env` / `reports` / `screenshots` は残る) |
| `npm run discover:staging` / `npm run discover:production` | 実サイトの仕様を調査して `reports/discovery/` に記録 (読み取りのみ) |
| `npm run update:screenshots` | 基準画像を更新 (意図した見た目の変更時。**更新前に `npm test` で Critical / High が 0 であることを確認する** — 不具合を基準画像に焼き付けないため。CI と同じ Linux 以外では中止される) |
| `npm run export` | 保存済みの結果を CSV にする (`reports/export/`。Excel でそのまま開ける。ファイル名に日時が付き、直近 10 回分を残して古いものは自動で消える) |
| `npm run logic` | 判定ロジックの説明を `reports/export/logic.md` に書き出す (人に渡す・AI に読ませる用。内容は `config/` から自動生成) |
| `npm run report` | 生成済みレポートをローカルで閲覧 |
| `npm run gate` | 重大度ゲートの判定のみ実行 (CI 用) |
| `npm run typecheck` | 型チェック |
| `npm run mock:serve` | モックサイト (LP ドメイン) を単体起動 |
| `npm run mock:serve:application` | モックサイト (申込ドメイン) を単体起動 |
| `npm run clean` | レポート・現在画像を削除 (基準画像は残す) |

任意の条件で絞り込む場合は Playwright の引数をそのまま使えます。

```bash
npx playwright test --grep @agency --project=chromium-sp
npx playwright test tests/health/links.spec.ts
npx playwright test --headed --debug
```

### 出力先

| パス | 内容 |
|---|---|
| `reports/qa-report.html` | QA レポート (実行日時・環境・ページ・PC/SP・代理店コード・期待/実際・重大度・スクリーンショット・再現 URL) |
| `reports/qa-report.json` | 同内容の JSON (CI 判定・二次利用向け) |
| `reports/playwright-report/` | Playwright 標準レポート (トレース・差分画像) |
| `reports/text/<env>/` | ページごとの抽出テキスト (JSON / CSV) |
| `reports/test-results/` | 失敗時のスクリーンショット・視覚差分の 3 枚 (基準画像 / 現在画像 / 差分画像) |
| `screenshots/current/<env>/<browser>-<device>/` | フルページスクリーンショット |
| `screenshots/baseline/<env>/<project>/` | 基準画像 (環境別・Git にコミットする) |

---

## 3. 重大度と CI 判定

| 重大度 | 対象 | CI |
|---|---|---|
| **Critical** | 代理店の誤表示、代理店コードの欠落、申込への誤引き継ぎ | 失敗 |
| **High** | 申込導線の停止、主要リンク切れ、JavaScript エラー | 失敗 |
| Medium | 表示崩れ、画像欠損 | 継続 |
| Low | 誤字脱字、表記揺れ、軽微な画像差分 | 継続 |

Critical または High が 1 件でもあれば、テストが失敗し終了コード 1 で終了します
(判定対象は `config/runtime.yml` の `failOnSeverities` で変更できます)。

---

## 4. 設定の追加方法

すべての設定は `config/` 配下にあります。**設定の追加だけでページや代理店コードを増やせます。**

### 稼働していない代理店コードを検査対象から外す

`config/agency-master.tsv` の 2 列で決めます (どちらも任意。列が無ければ全件を稼働中として扱います)。

| 列 | 値 | 効果 |
| --- | --- | --- |
| `status` | 空欄 = 稼働中 / `未稼働` `停止` など | 空欄以外は**検査しない** |
| `startsOn` | `2026-09-01` | その日までは検査しない。**過ぎたら自動で検査対象に戻る** |

稼働していないコードは「代理店名が出ない」「表示が切り替わらない」のが正しい状態で、
検査すると必ず不具合として報告されてしまいます。理由は画面の「備考」に一覧で出ます。

変更したら `npm run agencies:build -- --all` で再生成してください。
`startsOn` の日付を過ぎると、生成結果が変わるため CI の `--check` が失敗し、
「再生成が必要」だと気づけます。

### 画面から変えられる設定 (設定ファイルを触らない方法)

`npm run ui` の「ロジックと設定」→ **設定** タブで、次を画面から変更できます。

| 変えられるもの | 保存先 |
| --- | --- |
| 対象サイトの URL / 申込サイトの URL / ベーシック認証 | `.env` |
| 安心パックの判定に使う語・否定表現 | `config/overrides.yml` |
| 掲載不可でも出てよい文言 / 出せない文言 (理由つき) | `config/overrides.yml` |
| 検査しない代理店コード | `config/overrides.yml` |

`config/overrides.yml` は**元の設定に重ねて使う差分ファイル**です。
`config/agency.yml` を画面から直接書き換えない理由は、`npm run update`
(最新版に更新) が `config/` を新しい版で置き換えるため、
直接書き換えると更新のたびに運用側の判断が消えてしまうからです。
このファイルは更新時に残し、Git にも入れません。

同じタブの「そのほかの設定」には、画面から変えられない設定
(安全装置・並列実行数・タイムアウト・重大度ゲートなど) を、
どのファイルの設定かと一緒に表示します。変更は設定ファイルを直します。

### ページを追加する

`config/pages.yml` の `pages` に追記します。

```yaml
  - id: campaign                 # 一意な ID (ファイル名・レポートに使用)
    name: キャンペーンページ       # レポートの表示名
    path: /campaign.html         # baseUrl からの相対パス
    agencyAware: true            # 代理店コードによる表示差分があるか
    checks: [layout, errors, links, visual, text]   # 実行する検査
    requiredTestIds: [campaign-main]                # 必ず表示されるべき要素
    primaryTestIds: [site-header, campaign-main, site-footer]  # はみ出し・重なりの検査対象
```

`checks` に指定できる値:

| 値 | 内容 |
|---|---|
| `layout` | 表示崩れ・横スクロール・画像・必須要素 |
| `errors` | JavaScript エラー・4xx/5xx |
| `links` | リンク切れ・リダイレクトループ |
| `visual` | 基準画像との比較 |
| `text` | テキスト抽出・表記チェック |

### 代理店を追加する

`config/agencies.yml` の `agencies` に追記します。**これだけでテストが自動追加されます。**

```yaml
agencies:
  - code: A004
    label: 追加の代理店
    entryPath: /lp/                    # 最初に表示する LP
    expectedFinalPath: /partner/a004/  # 最終的に表示されるべき URL
    redirected: true                   # リダイレクトの有無
    redirectMechanism: http            # none | http | js | meta-refresh | spa
    expectedRedirectCount: 1
    expectedRedirectPaths: [/partner/a004/]

    visibleSections: [partner-exclusive-hero, agency-contact]   # 表示すべき
    hiddenSections: [default-hero, fallback-notice]             # 非表示であるべき

    expectedTexts:
      agency-name: 株式会社エーフォー
      agency-phone: 011-0000-0004
    expectedAssets:
      agency-banner: /assets/banner-a004.svg

    cta:
      testId: cta-primary
      expectedText: お申し込みはこちら

    application:
      expectedDomain: null             # null なら環境の applicationBaseUrl を使用
      expectedPath: /entry/
      handoffMethod: query             # query | hidden | post | api | server-session | token
      handoffParam: agency_code
      expectedCode: A004
      recognition:                     # 申込側で「正しい代理店」と認識されたことの確認方法
        - type: text
          testId: application-agency-name
          expected: 株式会社エーフォー
        - type: api
          urlPattern: "**/api/session*"
          field: agency_code
          expected: A004
      steps:
        - testId: application-next
          expectedPath: /entry/step2/
```

追加した代理店には、次のテストが自動的に生成されます。

- 表示検査 (セクション・代理店名・電話番号・バナー・CTA 文言・保存値)
- リダイレクト検査 (HTTP ステータス・回数・経路・最終 URL・ループ・PC/SP 一致)
- 申込引き継ぎ検査 (ドメイン・パス・コード/トークン送信・認識・複数画面・戻る/再読み込み)
- 他代理店との組み合わせ (再流入・誤帰属)
- セキュリティ検査 (CTA の遷移先オリジン)

`recognition` は 1 つ以上必須です (URL にコードが載っていることだけでは合格にしないため)。

**設定に不備があれば実行前にエラーになります。** 代理店コードの重複、
リダイレクト設定の矛盾 (`redirected` と `expectedFinalPath` の不一致)、
`recognition` の空、表示・非表示セクションの重複、有効コードと無効コードの
二重定義、存在しないページ id の参照などを検出し、どこが問題かを列挙します
(この動作は `@selfcheck` のテストで担保しています)。

### 無効コード・コードなしの期待結果を変更する

`config/agencies.yml` の `invalidCodes` / `invalidExpectation` / `noCodeExpectation` を編集します。

```yaml
invalidCodes:
  - code: INVALID
    label: 未登録コード

invalidExpectation:
  expectedFinalPath: /lp/
  redirected: false
  visibleSections: [default-hero, fallback-notice]
  hiddenSections: [agency-campaign, agency-contact]
  expectStored: false                  # 保存されないこと
  application:
    expectDefaultRoute: true           # 通常経路へフォールバック
    defaultRouteTestId: application-default-route
    forbiddenTestIds: [application-agency-info]
```

### セキュリティ検査の設定を変更する

`config/agencies.yml` の `security` / `redirect` を編集します。

```yaml
redirect:
  allowedQueryParams: [agency_code, handoff_token, utm_source]
  forbiddenQueryParamKeywords: [mail, tel, name, card]   # 個人情報らしいキー
security:
  redirectParamNames: [next, redirect_to]                # open redirect 検査対象
  xssPayloads: ["<img src=x onerror=window.__qa_xss=1>"]
  maskParamNames: [handoff_token, token, session]         # レポートでマスクする値
```

### 端末を追加する

`config/devices.yml` の `devices` に追記すると、有効なブラウザとの組み合わせで
project が自動生成されます (`chromium-tablet` など)。

```yaml
  - id: tablet
    label: タブレット
    viewport: { width: 820, height: 1180 }
    deviceScaleFactor: 2
    isMobile: true
    hasTouch: true
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) ..."
```

### Firefox / WebKit を追加する

`config/devices.yml` の `enabled` を `true` にするだけです。テストコードの変更は不要です。

```yaml
browsers:
  - id: chromium
    enabled: true
  - id: firefox
    enabled: true       # <- 追加
  - id: webkit
    enabled: true       # <- 追加
```

その後、ブラウザ本体を取得します。CI では `.github/workflows/qa.yml` の
`npx playwright install --with-deps chromium` を `npx playwright install --with-deps` に変更してください。

```bash
npx playwright install firefox webkit
```

project は「有効なブラウザ × 端末」で自動生成されます (`utils/projects.ts`)。
3 ブラウザを有効化すると project は 6 個 (chromium/firefox/webkit × pc/sp)、
テスト数は 3 倍になります。

| 有効なブラウザ | project | テスト数 |
|---|---|---|
| chromium のみ (既定) | 2 | 188 |
| chromium + firefox + webkit | 6 | 564 |

> 注1: `isMobile` / `hasTouch` は Firefox が非対応のため、Firefox では viewport と
> User-Agent のみが適用されます (`utils/projects.ts` で自動判定)。
> この挙動と project 生成そのものは `@selfcheck` のテストで検証しています。
>
> 注2: 実際の Firefox / WebKit での**テスト実行は未検証**です
> (開発環境からブラウザ本体を取得できなかったため)。
> 有効化して初回実行する際は、環境ごとの基準画像の作成が必要です
> (`screenshots/baseline/<環境>/<project>/`)。

### 表記ルールを追加する

`config/text-rules.yml` を編集します。

既定の中身は社内規定「LF表記・ブランドルール」(2025/12/11 版) を写したものです
(`id` が `lf-` で始まるルール)。

```yaml
unifyRules:
  - id: lf-noun-moushikomi
    preferred: 申込み                # 正しい表記 (名詞は送り仮名を省く)
    variants: [申し込み]             # 検出する表記
  - id: lf-ethics-kodomo
    preferred: 子ども
    variants: [子供]
    severity: medium                # 既定 (Low) 以外にする場合だけ書く
  - id: lf-basic-toki
    preferred: とき
    variants: [する時, した時]
    exceptWhenFollowedBy: [間, 期]   # 「時間」「時期」は対象外
  - id: hoshou
    preferred: null
    variants: [保障, 補償]
    detectOnly: true                # 併用のみ検出 (正解が文脈依存の場合)

prohibited:
  - pattern: 業界No.1
    reason: 客観的根拠のない優位性表示

excludeWords: [保健所, ペット保険]   # この語の範囲ではどのルールも検出しない
```

重大度は既定 Low、使用禁止表現は Medium、ブランド・マインドと倫理・配慮は
`severity: medium` を明示しています。
正しい用法まで拾ってしまう語は必ず `exceptWhenFollowedBy` か `excludeWords` で
除外してください (誤検知が増えると誰も結果を見なくなります)。

### 画像差分の許容値・マスクを変更する

`config/visual.yml` を編集します。

```yaml
compare:
  threshold: 0.2                    # ピクセルの色差の閾値 (0-1)
  maxDiffPixelRatio: 0.01           # 許容する差分ピクセル比率 (0-1)
mask:                               # 動的要素をマスクする
  - current-datetime
  - hero-carousel
  - "css=iframe[src*='chat']"
```

### 除外リスト (計測タグ・外部ドメイン) を変更する

`config/errors.yml` の `network.ignoreUrlPatterns` / `console.ignoreMessages` /
`links.ignoreUrlPatterns` を編集します。

### 並列実行数・リクエスト間隔・トレースを変更する

`config/runtime.yml` を編集します。外部サイトへの負荷を抑えたい場合はここで調整します。

```yaml
workers: 4
workersCi: 2
throttle:
  navigationDelayMs: 250            # ページ遷移前の待機
  linkCheckDelayMs: 150             # リンク検査の間隔
  linkCheckConcurrency: 4           # リンク検査の同時実行数

# トレースには通信内容 (トークン・Cookie・リクエストボディ) が含まれる。
# 秘密情報を Artifact に残したくない場合は off にする。
trace: on-first-retry               # off | on | retain-on-failure | on-first-retry
traceCi: retain-on-failure
```

---

## 5. ディレクトリ構成

```
.
├── config/                  # 設定 (ページ・端末・代理店コード・表示条件・ルール)
│   ├── environments.yml     #   対象環境 (本番 / ステージング / ローカル)
│   ├── devices.yml          #   PC / SP・ブラウザ
│   ├── pages.yml            #   テスト対象ページ
│   ├── agencies.yml         #   ★ 代理店ごとの個別仕様 (LP・リダイレクト・表示・申込引き継ぎ)
│   ├── agency.yml           #   代理店コードの共通の仕組み (パラメータ名・保存先・共通セレクタ)
│   ├── layout.yml           #   表示崩れの閾値
│   ├── visual.yml           #   スクリーンショット比較
│   ├── errors.yml           #   エラー検知・除外リスト
│   ├── known-issues.yml     #   既知の不具合 (修正日まで Low に落とす)
│   ├── text-rules.yml       #   誤字脱字・表記揺れルール
│   └── runtime.yml          #   並列数・待機・重大度ゲート
├── tests/                   # テストコード
│   ├── qa-fixtures.ts       #   共通フィクスチャ (検知結果の集約・本番の安全装置)
│   ├── crawl/               #   基本巡回 (PC / SP)
│   ├── agency/              #   代理店ごとの表示 / リダイレクト / 申込引き継ぎ
│   ├── security/            #   代理店コード起因のセキュリティ検査
│   ├── health/              #   リンク切れ
│   ├── visual/              #   スクリーンショット比較
│   ├── text/                #   誤字脱字・表記揺れ
│   ├── tools/               #   実サイトの仕様調査ツール (npm run discover)
│   └── self-check/          #   検出ロジックの自己検査 (ネガティブテスト)
├── utils/                   # 共通処理
│   ├── config.ts            #   設定読み込み・環境変数展開・検証
│   ├── types.ts             #   型定義
│   ├── findings.ts          #   検知結果の集約・重大度ゲート
│   ├── qa-session.ts        #   1 テスト分の検査セッション
│   ├── agency.ts            #   代理店ごとの表示検証
│   ├── agency-entry.ts      #   代理店コードでの流入 (リダイレクト完了待ち)
│   ├── redirect.ts          #   リダイレクト経路の記録・遷移方式の判定
│   ├── handoff.ts           #   別ドメイン申込ページへの引き継ぎ検証
│   ├── security.ts          #   open redirect / パラメータ注入の検査
│   ├── secrets.ts           #   秘密情報 (トークン) のマスキング
│   ├── layout.ts            #   表示崩れ・横スクロール・画像
│   ├── links.ts             #   リンク切れ・リダイレクトループ
│   ├── monitors.ts          #   console / pageerror / ネットワーク監視
│   ├── screenshots.ts       #   スクリーンショット・基準画像比較
│   ├── text-extract.ts      #   テキスト抽出 (JSON / CSV)
│   ├── text-rules.ts        #   表記ルール判定
│   ├── ai-text-checker.ts   #   AI 文章チェックの拡張ポイント
│   ├── page-source.ts       #   ページ取得 (config / sitemap.xml)
│   ├── patterns.ts          #   glob・正規表現の照合
│   └── throttle.ts          #   待機・並列制御
├── fixtures/mock-site/      # テストデータ (検証用モックサイト)
│   ├── server.mjs           #   LP ドメイン (代理店ごとのリダイレクト・表示)
│   └── application-server.mjs  # 申込ドメイン (別オリジン・引き継ぎ受け取り)
├── reporters/               # HTML レポート生成
├── scripts/                 # ゲート判定・レポート閲覧・クリーンアップ
├── reports/                 # レポート出力 (Git 管理外)
├── screenshots/             # スクリーンショット (baseline のみ Git 管理)
├── docs/                    # 仕様書
└── .github/workflows/qa.yml # CI
```

---

## 6. CI (GitHub Actions)

`.github/workflows/qa.yml` に 2 つのジョブがあります。

| ジョブ | 対象 | Secrets | 実行タイミング |
|---|---|---|---|
| `self-test` | 同梱モックサイト (`QA_ENV=local`) | 不要 | push / PR / 手動 |
| `qa` | ステージング / 本番 | 必要 | **手動実行のみ** |

実サイトを検査する `qa` ジョブは **Actions タブの「Run workflow」を押したときだけ**動きます。
定時実行は行いません。ABテストの開始後・セクションの追加後・設定変更後など、
**確認したいタイミングで実行する**運用を前提にしています。

> 定期実行に切り替える場合は `.github/workflows/qa.yml` の `schedule:` の
> コメントを外し、`qa` ジョブの `if` に `github.event_name == 'schedule'` を追加します。

`self-test` は **Secrets を設定していない状態でもパイプラインを確認できる**ようにしてあります。
QA ツール自体を改修したときのリグレッション検知も兼ねています
(モックサイトは `playwright.config.ts` が自動起動します)。

> 基準画像を開発マシンで作成している場合、CI ではフォント描画の違いにより
> 画像差分 (Low) が出ます。Low はゲート対象外のためジョブは成功します。
> 詳細と対処は [docs/operations.md](docs/operations.md) を参照してください。

`qa` は実行前に必要な Secrets の設定を確認し、未設定なら明示的なエラーで停止します
(URL 未設定のまま実行して分かりにくいエラーになるのを防ぐため)。

実行タイミング:

1. **手動実行 (`qa` / `self-test`)** — Actions タブ →「公開後QA」→「Run workflow」。
   対象環境 (staging / production)、テスト種別、端末を選択できます
2. **push / Pull Request (`self-test` のみ)** — QA ツール自体が壊れていないかの確認。
   同梱モックサイトを対象とするため、実サイトには一切アクセスしません
3. **定時実行** — 行いません
   (デプロイ完了後に自動実行したい場合はファイル内の `workflow_run` を有効化)

成果物と判定:

- HTML レポート・JSON・抽出テキストを Artifact `qa-report-<run番号>` として保存
- スクリーンショット・差分画像を Artifact `qa-screenshots-<run番号>` として保存
- Critical / High が 1 件でもあればジョブを失敗させる (`npm run gate`)

### 必要な GitHub Secrets

| Secret | 用途 |
|---|---|
| `STAGING_BASE_URL` | ステージングの LP ドメイン URL |
| `PRODUCTION_BASE_URL` | 本番の LP ドメイン URL |
| `STAGING_APPLICATION_BASE_URL` | ステージングの申込ドメイン URL |
| `PRODUCTION_APPLICATION_BASE_URL` | 本番の申込ドメイン URL |
| `STAGING_BASIC_USER` | Basic 認証のユーザー名 (必要な場合のみ) |
| `STAGING_BASIC_PASS` | Basic 認証のパスワード (必要な場合のみ) |

URL や認証情報はコードにも設定ファイルにも書かず、Secrets から環境変数として渡します。

### 基準画像の扱い

基準画像 (`screenshots/baseline/<環境>/<project>/`) は Git にコミットします。
基準画像は**環境ごとに分離**されているため、`local` の基準画像がステージングや本番の
比較に使われることはありません (環境ごとに初回作成が必要です)。

CI 上に基準画像が無い場合はその回で作成され、比較は行われません
(Artifact から取得してコミットしてください)。見た目を意図的に変更した場合は
`npm run update:screenshots` で更新し、コミットします。

---

## 7. セキュリティ・安全設計

- **本番環境では申込完了ボタンを押しません。** `config/environments.yml` の
  `readOnly: true` の環境では、`GET` / `HEAD` / `OPTIONS` 以外のリクエストを
  フィクスチャ側で遮断します (`tests/qa-fixtures.ts`)。
- **POST / hidden 方式の引き継ぎ検査は、読み取り専用環境では送信を行いません。**
  フォームの `action` と hidden 項目から「申込先ドメイン・パス・引き継ぐ値」を
  検証し、実際の送信と申込側での認識はスキップして Low として記録します
  (誤検知で Critical を出さないため)。`query` / `token` 方式は GET 遷移のみで
  完結するため、読み取り専用環境でも全項目を検証します。
- 個人情報は入力しません。フォーム検査は hidden 項目と選択項目に限定しています。
- テスト用代理店コードのみを `config/agency.yml` に記載します。
- Cookie や認証情報はログに出力しません。保存値の検証は期待値との比較のみを行います。
- `.env` は `.gitignore` 済みです。認証情報は `.env` / GitHub Secrets で管理します。
- リクエスト間隔と並列実行数を `config/runtime.yml` で制御し、外部サイトへ過剰な
  リクエストを送りません。リンク検査には 1 ページあたりの上限があります
  (`config/errors.yml` の `links.maxLinksPerPage`)。
- **申込完了リクエストは全環境で遮断します。** `config/agency.yml` の
  `application.forbiddenRequestPatterns` に一致するリクエストが発生した場合、
  フィクスチャが遮断し Critical として報告します。
- **一時トークン・セッション ID・URL に付加された個人情報はレポートに出力しません。**
  検知結果・検査文脈の URL・添付する証跡 (リダイレクト経路など) のすべてに
  マスキング処理が自動適用されます (`utils/secrets.ts`)。
  「URL に個人情報が含まれている」ことは Critical として報告しますが、
  その値自体はレポートへ出力しません (レポートは CI の Artifact になるため)。
- **トレースには通信内容がそのまま含まれます。** Playwright のトレースには
  一時トークン・Cookie・リクエストボディが含まれるため、Artifact の共有範囲に
  注意してください。秘密情報を一切残したくない場合は `config/runtime.yml` の
  `trace` / `traceCi` を `off` にします (デバッグ容易性とのトレードオフ)。
- 代理店コード起因のセキュリティ (open redirect、任意ドメインへの遷移、
  URL パラメータの HTML 出力、URL への個人情報付加) を検査します
  (`npm run test:security`)。

---

## 8. 拡張

### sitemap.xml からページを自動取得する

`config/pages.yml` の `source` を `sitemap` に変更します。取得処理は
`utils/page-source.ts` に分離されており、テストコードの変更は不要です。

```yaml
source: sitemap
sitemap:
  path: /sitemap.xml
  maxPages: 50
  excludePatterns: ["**/preview/**", "**/*.pdf"]
  defaults:
    agencyAware: false
    checks: [layout, errors, links, visual, text]
```

取得に失敗した場合は `config/pages.yml` の `pages` にフォールバックします。
この切り替えと除外パターン (`excludePatterns`)、フォールバック動作は
`@selfcheck` のテストで検証しています。

### AI による文章チェックを追加する

`utils/ai-text-checker.ts` の `AiTextChecker` を実装して登録し、
`config/text-rules.yml` の `aiCheck` を有効化します。テストコードの変更は不要です。

```ts
import { registerAiTextChecker } from '../utils/ai-text-checker';

registerAiTextChecker({
  name: 'my-provider',
  async review({ text, pageId }) {
    const apiKey = process.env.QA_AI_API_KEY;   // キーは環境変数から取得
    // ... API 呼び出し ...
    return [{ severity: 'low', message: '表現の重複があります', excerpt: '...' }];
  },
});
```

```yaml
aiCheck:
  enabled: true
  provider: my-provider
  apiKeyEnv: QA_AI_API_KEY
  maxCharsPerPage: 4000
```

---

## 9. 仕様書

| ドキュメント | 内容 |
|---|---|
| [docs/specification.md](docs/specification.md) | ツール全体の仕様 |
| [docs/agency-code-scenarios.md](docs/agency-code-scenarios.md) | 代理店ごとの個別仕様・リダイレクト・申込引き継ぎ・セキュリティ |
| [docs/handoff-discovery.md](docs/handoff-discovery.md) | 実サイトの仕様調査ツール (npm run discover) |
| [docs/ui.md](docs/ui.md) | ブラウザの操作画面 (実行・進行状況・結果・設定・履歴) |
| [docs/checks.md](docs/checks.md) | 各検査項目の判定ロジックと閾値 |
| [docs/severity.md](docs/severity.md) | 重大度の分類基準 |
| [docs/operations.md](docs/operations.md) | 運用手順 (実サイト適用・トラブルシューティング) |
| [docs/verification-log.md](docs/verification-log.md) | 検証記録 (何をどう確認したか・未検証の項目) |

---

## 10. 検出ロジックの信頼性

「テストが緑であること」が「不具合が無いこと」を意味するために、
検出ロジック自体を検査するネガティブテストを同梱しています
(`tests/self-check/detectors.spec.ts`)。

意図的に壊したページ (`fixtures/mock-site/broken/`) と、検証用に組み立てた経路データに対して、
次がそれぞれ検出されることを確認しています。

- 横スクロール・要素の重なり・画像読み込みエラー
- JavaScript エラー (console.error / pageerror)
- リンク切れ・リダイレクトループ
- 表記揺れ・誤字・使用禁止表現
- 遷移方式の判定 (HTTP 3xx / meta refresh / JavaScript / SPA)
- 別代理店の LP へのリダイレクト・リダイレクトループ (Critical)
- 別代理店の情報表示・セクションの表示崩れ (Critical)
- URL への個人情報・不要パラメータの付加 (Critical)
- レポートへの一時トークン出力の防止

併せて、正常なページで誤検知が出ないことも確認しています。

```bash
npx playwright test --grep @selfcheck
```

何をどう確認したか、どの項目が未検証かは
[docs/verification-log.md](docs/verification-log.md) に記録しています。
