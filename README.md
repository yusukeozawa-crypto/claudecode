# Webサイト公開後 自動QAツール

Playwright + TypeScript による、Web サイト公開後の不具合自動検知ツールです。
PC / SP の両方で以下を自動検知します。

| # | 検知内容 | 実装 |
|---|---|---|
| 1 | 代理店コードによるセクションの表示・非表示 | `tests/agency/agency-code.spec.ts` |
| 2 | ページ遷移後の代理店コード保持 | 同上 (シナリオ4) |
| 3 | 申込画面への代理店コード引き継ぎ | 同上 (シナリオ5) |
| 4 | 表示崩れ (はみ出し・重なり・空白画面) | `utils/layout.ts` |
| 5 | 横スクロール | 同上 |
| 6 | リンク切れ・リダイレクトループ | `utils/links.ts` |
| 7 | 画像読み込みエラー | `utils/layout.ts` / `utils/monitors.ts` |
| 8 | JavaScript エラー (console.error / pageerror) | `utils/monitors.ts` |
| 9 | 誤字脱字・表記揺れの候補抽出 | `utils/text-rules.ts` |
| 10 | スクリーンショット保存・基準画像比較 | `utils/screenshots.ts` |

**サイト固有の値はテストコードに一切書かれていません。** 対象 URL・端末・代理店コード・
表示条件・文言ルールはすべて `config/*.yml` で管理します。

---

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

## 2. 実行

### 対象環境の切り替え

`.env` に検査対象の URL を設定してから、環境を指定して実行します。

```bash
# .env
STAGING_BASE_URL=https://staging.example.com
PRODUCTION_BASE_URL=https://www.example.com
```

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
| `npm run test:pc` | PC (1440×900) のみ実行 |
| `npm run test:sp` | SP (390×844 / モバイル UA) のみ実行 |
| `npm run test:agency` | 代理店コードのテストのみ実行 |
| `npm run test:visual` | スクリーンショット比較のみ実行 |
| `npm run test:crawl` | 基本巡回のみ実行 |
| `npm run test:health` | リンク切れ・エラー検知のみ実行 |
| `npm run test:text` | 誤字脱字・表記揺れチェックのみ実行 |
| `npm run update:screenshots` | 基準画像を更新 (意図した見た目の変更時) |
| `npm run report` | 生成済みレポートをローカルで閲覧 |
| `npm run gate` | 重大度ゲートの判定のみ実行 (CI 用) |
| `npm run typecheck` | 型チェック |
| `npm run mock:serve` | モックサイトを単体起動 |
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
| `reports/test-results/` | 失敗時のスクリーンショット・基準画像との差分画像 |
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

### 代理店コードを追加する

`config/agency.yml` の `codes` に追記します。テスト用コードのみを記載してください。

```yaml
codes:
  - code: C003
    valid: true
    label: 追加の有効コード
    expectedName: テスト保険代理店C      # 表示されるべき代理店名
    expectedContact: 0120-000-003       # 表示されるべき電話番号
```

追加したコードは「シナリオ2 (有効コード)」「シナリオ3 (無効コード)」に自動的に含まれます。

### 表示条件を変更する

`config/agency.yml` の `selectors` と `expectations` を変更します。
セレクタは既定で `data-testid` として解決され、`css=` を付ければ任意のセレクタも使えます。

```yaml
selectors:
  defaultSection: default-section       # -> [data-testid="default-section"]
  agencySection: agency-section
  agencyName: agency-name
  agencyContact: agency-contact
  applicationButton: application-button
  fallbackNotice: fallback-notice

expectations:
  valid:
    visible: [agencySection, agencyName, agencyContact]   # 表示されるべき要素
    hidden: [defaultSection]                              # 非表示であるべき要素
    texts: {}                                             # 表示されるべき文言
```

対象サイトが `data-testid` を持たない場合は、まずサイト側に付与することを推奨します。
やむを得ない場合のみ `css=.agency-box` のように指定してください
(CSS クラス名や画面上の位置だけに依存した判定は壊れやすくなります)。

### URL パラメータ名・保存先を変更する

```yaml
paramName: agency_code          # URL パラメータ名
storage:
  type: both                    # cookie | localStorage | both
  key: agency_code              # Cookie 名 / localStorage キー
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

> 注: `isMobile` / `hasTouch` は Firefox が非対応のため、Firefox では viewport と
> User-Agent のみが適用されます (`playwright.config.ts` で自動判定)。

### 表記ルールを追加する

`config/text-rules.yml` を編集します。

```yaml
unifyRules:
  - id: application-noun
    preferred: お申し込み            # 正式表記
    variants: [お申込み, お申込]     # 検出する表記揺れ
  - id: hoshou
    preferred: null
    variants: [保障, 補償]
    detectOnly: true                # 併用のみ検出 (正解が文脈依存の場合)

prohibited:
  - pattern: 業界No.1
    reason: 客観的根拠のない優位性表示

excludeWords: [保健所]              # ルールを適用しない語
```

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

### 並列実行数・リクエスト間隔を変更する

`config/runtime.yml` を編集します。外部サイトへの負荷を抑えたい場合はここで調整します。

```yaml
workers: 4
workersCi: 2
throttle:
  navigationDelayMs: 250            # ページ遷移前の待機
  linkCheckDelayMs: 150             # リンク検査の間隔
  linkCheckConcurrency: 4           # リンク検査の同時実行数
```

---

## 5. ディレクトリ構成

```
.
├── config/                  # 設定 (ページ・端末・代理店コード・表示条件・ルール)
│   ├── environments.yml     #   対象環境 (本番 / ステージング / ローカル)
│   ├── devices.yml          #   PC / SP・ブラウザ
│   ├── pages.yml            #   テスト対象ページ
│   ├── agency.yml           #   代理店コード仕様
│   ├── layout.yml           #   表示崩れの閾値
│   ├── visual.yml           #   スクリーンショット比較
│   ├── errors.yml           #   エラー検知・除外リスト
│   ├── text-rules.yml       #   誤字脱字・表記揺れルール
│   └── runtime.yml          #   並列数・待機・重大度ゲート
├── tests/                   # テストコード
│   ├── qa-fixtures.ts       #   共通フィクスチャ (検知結果の集約・本番の安全装置)
│   ├── crawl/               #   基本巡回 (PC / SP)
│   ├── agency/              #   代理店コード 7 シナリオ
│   ├── health/              #   リンク切れ
│   ├── visual/              #   スクリーンショット比較
│   ├── text/                #   誤字脱字・表記揺れ
│   └── self-check/          #   検出ロジックの自己検査 (ネガティブテスト)
├── utils/                   # 共通処理
│   ├── config.ts            #   設定読み込み・環境変数展開・検証
│   ├── types.ts             #   型定義
│   ├── findings.ts          #   検知結果の集約・重大度ゲート
│   ├── qa-session.ts        #   1 テスト分の検査セッション
│   ├── agency.ts            #   代理店コードの共通処理
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
├── reporters/               # HTML レポート生成
├── scripts/                 # ゲート判定・レポート閲覧・クリーンアップ
├── reports/                 # レポート出力 (Git 管理外)
├── screenshots/             # スクリーンショット (baseline のみ Git 管理)
├── docs/                    # 仕様書
└── .github/workflows/qa.yml # CI
```

---

## 6. CI (GitHub Actions)

`.github/workflows/qa.yml` が以下のタイミングで実行されます。

1. **手動実行** — 対象環境 (staging / production)、テスト種別、端末を選択できます
2. **main ブランチへのデプロイ後** — `push: branches: [main]`
   (デプロイ用ワークフローの完了後に実行したい場合は、ファイル内の `workflow_run` を有効化)
3. **毎日定時** — UTC 00:00 (JST 09:00)

成果物と判定:

- HTML レポート・JSON・抽出テキストを Artifact `qa-report-<run番号>` として保存
- スクリーンショット・差分画像を Artifact `qa-screenshots-<run番号>` として保存
- Critical / High が 1 件でもあればジョブを失敗させる (`npm run gate`)

### 必要な GitHub Secrets

| Secret | 用途 |
|---|---|
| `STAGING_BASE_URL` | ステージングの URL |
| `PRODUCTION_BASE_URL` | 本番の URL |
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
- 申込 API への引き継ぎ検査は、読み取り専用環境では自動的にスキップされ、
  それ以外の環境でもリクエストを実際には送信せず内容のみ検査します。
- 個人情報は入力しません。フォーム検査は hidden 項目と選択項目に限定しています。
- テスト用代理店コードのみを `config/agency.yml` に記載します。
- Cookie や認証情報はログに出力しません。保存値の検証は期待値との比較のみを行います。
- `.env` は `.gitignore` 済みです。認証情報は `.env` / GitHub Secrets で管理します。
- リクエスト間隔と並列実行数を `config/runtime.yml` で制御し、外部サイトへ過剰な
  リクエストを送りません。リンク検査には 1 ページあたりの上限があります
  (`config/errors.yml` の `links.maxLinksPerPage`)。

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
| [docs/agency-code-scenarios.md](docs/agency-code-scenarios.md) | 代理店コード 7 シナリオの詳細 |
| [docs/checks.md](docs/checks.md) | 各検査項目の判定ロジックと閾値 |
| [docs/severity.md](docs/severity.md) | 重大度の分類基準 |
| [docs/operations.md](docs/operations.md) | 運用手順 (実サイト適用・トラブルシューティング) |

---

## 10. 検出ロジックの信頼性

「テストが緑であること」が「不具合が無いこと」を意味するために、
検出ロジック自体を検査するネガティブテストを同梱しています
(`tests/self-check/detectors.spec.ts`)。

意図的に壊したページ (`fixtures/mock-site/broken/`) に対して、
横スクロール・要素の重なり・JavaScript エラー・画像読み込みエラー・リンク切れ・
リダイレクトループ・表記揺れがそれぞれ検出されることを確認し、
併せて正常なページで誤検知が出ないことも確認しています。

```bash
npx playwright test --grep @selfcheck
```
