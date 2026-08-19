# 自動QAツール 仕様書

## 1. 目的

Web サイト公開後に、PC / SP の両方で以下の不具合を自動検知する。

1. 代理店コードごとのセクション表示・非表示 (コードの有無ではなく代理店単位の仕様で判定)
2. ページ遷移後の代理店コード保持
3. 代理店ごとの LP リダイレクト (経路・遷移方式・ループ)
4. 別ドメインの申込ページへの代理店情報引き継ぎ
5. 代理店コード起因のセキュリティ (open redirect / XSS / 情報漏えい)
6. 表示崩れ
7. 横スクロール
8. リンク切れ
9. 画像読み込みエラー
10. JavaScript エラー
11. 誤字脱字・表記揺れの候補抽出
12. スクリーンショット保存

## 2. 技術構成

| 項目 | 内容 |
|---|---|
| 実行環境 | Node.js 20 以上 |
| 言語 | TypeScript (strict) |
| テストランナー | Playwright Test 1.62 |
| 設定形式 | YAML (`config/*.yml`) |
| レポート | HTML (`reports/qa-report.html`) + JSON + Playwright 標準レポート |
| 対象ブラウザ | Chromium (Firefox / WebKit は設定変更のみで追加可能) |
| 対象端末 | PC 1440×900 / SP 390×844 (モバイル UA) |
| CI | GitHub Actions |

## 3. 設計方針

### 3.1 サイト固有の値をコードに書かない

テストコードには URL・代理店コード・セレクタ・文言を一切ハードコードしない。
すべて `config/*.yml` から読み込む。これにより次が成立する。

- 設定の追加だけでページ・代理店コード・端末・ブラウザを増やせる
- 対象サイトが変わってもテストコードを書き換えなくてよい

### 3.2 セレクタは data-testid を優先する

要素の特定は `data-testid` を第一とする。設定値は既定で
`[data-testid="<値>"]` に解決される。`css=` / `text=` / `xpath=` 接頭辞を付けた場合のみ
任意のセレクタとして扱う。CSS クラス名や画面上の位置だけに依存した判定は行わない。

### 3.3 検知結果を重大度付きで集約する

各検査は例外を投げるのではなく `Finding` (検知結果) を返し、
`FindingCollector` が 1 テスト分を集約する。テスト終了時に

1. 結果を JSON としてテストに添付する (レポート生成用)
2. `config/runtime.yml` の `failOnSeverities` に該当する検知があればテストを失敗させる

この分離により「1 テストで複数の不具合をまとめて報告する」「Low / Medium は
記録しつつ CI は継続する」が両立する。

### 3.4 代理店ごとの期待結果を設定で持つ

代理店コードの「有無」では判定しない。代理店ごとに異なる期待結果 (流入 LP・
リダイレクト・表示内容・申込引き継ぎ) を `config/agencies.yml` に持ち、
テストはそれを読んで組み合わせを生成する。代理店を 1 件追加すれば、
その代理店のテスト (表示・リダイレクト・引き継ぎ・PC/SP・他代理店との組み合わせ) が
自動的に追加される。

### 3.5 引き継ぎ方式を推測しない

LP と申込ページは別ドメインで Cookie を共有できないため、引き継ぎ方式は実装依存になる。
仕様を推測せず、`npm run discover` (`tests/tools/discover-handoff.spec.ts`) で
実際の通信・DOM・ストレージを記録し、その結果を設定に反映する。
テスト実行時も、観測した方式が設定と異なれば警告する。

### 3.6 本番環境では書き込みを行わない

`config/environments.yml` で `readOnly: true` の環境では、フィクスチャが
`GET` / `HEAD` / `OPTIONS` 以外のリクエストを遮断する。読み取り専用環境で行うのは
読み取りと画面遷移のみ。

さらに **全環境で** 申込完了・データ送信のリクエスト
(`config/agency.yml` の `application.forbiddenRequestPatterns`) を遮断し、
発生した場合は Critical として報告する。

### 3.7 ページ取得処理を分離する

テスト対象ページの取得は `utils/page-source.ts` に分離してある。
現在は `config/pages.yml` を参照するが、`source: sitemap` に切り替えると
`sitemap.xml` から自動取得する。テストコードの変更は不要。

## 4. 構成要素

### 4.1 設定 (config/)

| ファイル | 管理内容 |
|---|---|
| `environments.yml` | 対象環境・baseUrl・読み取り専用フラグ・Basic 認証 |
| `devices.yml` | ブラウザの有効/無効、端末 (viewport / UA / DPR) |
| `pages.yml` | テスト対象ページ、実行する検査、必須要素、主要要素 |
| `agencies.yml` | **代理店ごとの個別仕様** (流入 LP・リダイレクト・表示/非表示セクション・代理店名・電話番号・バナー・CTA・申込先ドメイン・引き継ぎ方式・認識確認方法)、無効コード / コードなしの期待結果、URL 検査条件、セキュリティ検査条件 |
| `agency.yml` | 代理店コードの共通の仕組み (URL パラメータ名、保存先、共通セレクタ、申込完了の禁止パターン、遷移フロー) |
| `layout.yml` | 横スクロール・はみ出し・重なり・画像・空白画面の閾値 |
| `visual.yml` | 差分許容値、マスク対象、保存先 |
| `errors.yml` | console / pageerror / ネットワーク / リンクの検知条件と除外リスト |
| `text-rules.yml` | 正式名称、表記統一ルール、保険用語、使用禁止表現、誤字パターン、除外語、除外セレクタ、AI チェック設定 |
| `runtime.yml` | 並列実行数、リトライ、タイムアウト、リクエスト間隔、重大度ゲート |

環境変数は `${VAR}` 形式で展開される。`.env` は自動的に読み込まれる (Git 管理外)。
設定は `utils/config.ts` の `validateConfig()` で起動時に検証され、不備があれば
実行前に明示的なエラーになる。

### 4.2 project の自動生成

`utils/projects.ts` の `buildProjects()` が「有効なブラウザ × 端末」の組み合わせで
project を生成し、`playwright.config.ts` がそれを使用する。
project 名は `<browserId>-<deviceId>` (例: `chromium-pc`, `chromium-sp`)。
端末・ブラウザ情報は `project.metadata` 経由でテストとレポートに渡る。

`isMobile` / `hasTouch` は Firefox が非対応なので、Firefox では viewport と
User-Agent のみを適用する。ローカルの Chromium 実体を明示指定する
`QA_CHROMIUM_EXECUTABLE` は chromium の project にのみ適用する
(他ブラウザに適用すると起動できなくなる)。

生成ロジックを設定読み込みから分離してあるため、
「ブラウザを有効化するだけで対象に加わる」ことをテストで検証できる
(`tests/self-check/detectors.spec.ts`)。

### 4.3 テスト構成

| ファイル | タグ | 内容 |
|---|---|---|
| `tests/crawl/page-health.spec.ts` | `@crawl` `@health` | 全ページの表示・表示崩れ・エラー・スクリーンショット |
| `tests/crawl/sitemap-crawl.spec.ts` | `@crawl` `@sitemap` | sitemap.xml 取得時の巡回 (source: sitemap のときのみ) |
| `tests/agency/agency-display.spec.ts` | `@agency` | 代理店ごとの表示・保持・再流入・保存値削除 (設定から自動生成) |
| `tests/agency/agency-redirect.spec.ts` | `@agency` `@redirect` | 代理店ごとのリダイレクト経路・遷移方式・PC/SP 一致 |
| `tests/agency/agency-handoff.spec.ts` | `@agency` `@handoff` | 別ドメイン申込ページへの引き継ぎ |
| `tests/security/agency-security.spec.ts` | `@security` | open redirect / パラメータ注入 / マスキング |
| `tests/tools/discover-handoff.spec.ts` | `@discover` | 実サイトの仕様調査 (通常実行では起動しない) |
| `tests/self-check/detectors.spec.ts` | `@selfcheck` | 検出ロジックと project 生成の自己検査 (local 環境のみ) |
| `tests/health/links.spec.ts` | `@health` `@links` | リンク切れ・リダイレクトループ |
| `tests/visual/screenshot-diff.spec.ts` | `@visual` | 基準画像との比較 |
| `tests/text/wording.spec.ts` | `@text` | テキスト抽出・表記チェック・ページ間の表記統一 |
| `tests/self-check/detectors.spec.ts` | `@selfcheck` | 検出ロジックの自己検査 (local 環境のみ) |

### 4.4 共通フィクスチャ (tests/qa-fixtures.ts)

| フィクスチャ | 内容 |
|---|---|
| `qaConfig` | 読み込み済みの設定 |
| `qaPages` | 解決済みのページ一覧 (config / sitemap) |
| `qa` | 検査セッション (`QaSession`)。ページ遷移・各種検査・結果集約 |
| `page` (上書き) | 読み取り専用環境での書き込みリクエスト遮断 |

`qa` フィクスチャの終了処理で必ず結果の添付と重大度ゲートが実行される。
テスト本体が途中で失敗した場合も、それまでの検知結果はレポートに残る。

## 5. レポート

### 5.1 QA レポート (reports/qa-report.html)

`reporters/qa-html-reporter.ts` が生成する。以下を確認できる。

- 実行日時・所要時間
- 対象環境 (ラベル・環境名・baseUrl)
- 実行構成 (project 一覧)
- テスト件数 (合計 / 成功 / 失敗 / スキップ)
- 重大度別の検知件数 (Critical / High / Medium / Low)
- CI 判定結果
- 検知一覧: 重大度・種別・ページ・PC/SP・代理店コード・エラー内容・期待結果・
  実際の結果・再現に使用した URL・スクリーンショット
- テスト実行一覧: 結果・テスト名・ページ・PC/SP・代理店コード・検知件数・所要時間・再現 URL
- 重大度による表示フィルタ

### 5.2 その他の出力

- `reports/qa-report.json` — 同内容の JSON。`npm run gate` が判定に使用する
- `reports/playwright-report/` — Playwright 標準レポート (トレース・基準画像/現在画像/差分画像)
- `reports/text/<env>/<pageId>__<browser>-<device>.{json,csv}` — 抽出テキスト
- `screenshots/current/<env>/<browser>-<device>/` — フルページスクリーンショット
- `screenshots/baseline/<env>/<project>/` — 基準画像 (環境ごとに分離)

## 6. CI 構成と判定

ワークフローは 2 ジョブ構成。

| ジョブ | 対象 | Secrets |
|---|---|---|
| `self-test` | 同梱モックサイト (`QA_ENV=local`) | 不要 |
| `qa` | ステージング / 本番 | 必要 (未設定なら実行前に停止) |

`self-test` により、Secrets 未設定の状態でもパイプラインと QA ツール自体を検証できる。



Critical / High が 1 件でもあれば失敗とする。判定は二重に行う。

1. `qa` フィクスチャの終了処理でテスト自体を失敗させる
2. レポータが終了コードを 1 にする / `npm run gate` が JSON を読んで判定する

CI では成果物をアップロードした後にゲートを評価するため、失敗時もレポートと
スクリーンショットが Artifact として残る。

## 7. 完了条件との対応

| 完了条件 | 対応 |
|---|---|
| `npm install` 後、README どおりに実行できる | `npm install` → `npm run prepare:browsers` → `npm test` |
| PC / SP のテストが成功する | project `chromium-pc` / `chromium-sp` |
| 代理店コードあり・なし・無効のテストがある | シナリオ 1〜3 |
| ページ遷移後のコード保持を確認できる | シナリオ 4 (リンク遷移・直接遷移の両方) |
| 表示・非表示を自動判定できる | `utils/agency.ts` の `verifyDisplay()` |
| 画像切れと JavaScript エラーを検出できる | `utils/layout.ts` / `utils/monitors.ts` (自己検査つき) |
| SP の横スクロールを検出できる | `utils/layout.ts` の `measureHorizontalScroll()` (自己検査つき) |
| スクリーンショットが保存される | `screenshots/current/` に PC / SP 別で保存 |
| HTML レポートが生成される | `reports/qa-report.html` |
| GitHub Actions から実行できる | `.github/workflows/qa.yml` |
| 設定追加だけでページや代理店コードを増やせる | `config/pages.yml` / `config/agency.yml` |
| テストコードに対象サイト固有の値を直接書かない | 全設定を `config/*.yml` に外部化 |
