# 代理店ごとの個別仕様 テスト仕様

対象実装: `tests/agency/*.spec.ts` / `utils/agency*.ts` / `utils/redirect.ts` / `utils/handoff.ts`
設定ファイル: **`config/agencies.yml`** (代理店ごとの期待結果) / `config/agency.yml` (共通の仕組み)

## 0. 基本方針

**代理店コードが存在するかどうかだけで判定しない。** 代理店コードごとに次がすべて異なり、
その差異を `config/agencies.yml` で管理する。

| 期待結果 | 設定キー |
|---|---|
| 最初に表示する LP | `entryPath` |
| リダイレクトの有無 | `redirected` |
| リダイレクト先 URL | `expectedFinalPath` / `expectedRedirectPaths` |
| リダイレクト方式 | `redirectMechanism` |
| 表示するセクション | `visibleSections` |
| 非表示にするセクション | `hiddenSections` |
| 表示する代理店名 | `expectedTexts.agency-name` |
| 表示する電話番号 | `expectedTexts.agency-phone` |
| 表示するバナー・ロゴ | `expectedAssets` |
| CTA の文言 | `cta.expectedText` |
| CTA の遷移先 | `application.expectedDomain` / `expectedPath` |
| 申込先ドメイン | `application.expectedDomain` |
| 申込ページに引き継ぐ値 | `application.handoffMethod` / `handoffParam` / `expectedCode` |

**代理店設定を 1 件追加すれば、その代理店のテストが自動的に追加される。**
代理店ごとにテストコードを複製しない (テストは設定から生成される)。

## 1. 自動生成されるテストの組み合わせ

`config/agencies.yml` の内容から、次の組み合わせが自動生成される。

| テストファイル | 生成されるテスト |
|---|---|
| `agency-display.spec.ts` | 全代理店 × 表示検査 / 無効コード × 各件 / コードなし / 全代理店 × ページ遷移後の保持 / 代理店の全順列 × 再流入 / 全代理店 × 保存値削除 / リダイレクトのある代理店 × 専用LPへの直接アクセス |
| `agency-redirect.spec.ts` | 全代理店 × リダイレクト検査 / コードなし / 無効コード × 各件 / PC・SP のルール一致 |
| `agency-handoff.spec.ts` | 全代理店 × 申込引き継ぎ / 全代理店 × 誤帰属検査 / コードなし / 無効コード × 各件 |
| `agency-security.spec.ts` | 流入 LP × open redirect / 流入 LP × パラメータ注入 / 全代理店 × CTA 遷移先 / マスキング |

PC / SP は project (`chromium-pc` / `chromium-sp`) により両方で実行される。
現在の構成 (代理店 3 件 + 無効コード 3 件 + PC/SP) で **177 テスト**。

## 2. LP のリダイレクト検査 (`@redirect`)

各代理店コードについて 10 項目を検査する。

| # | 検査項目 | 実装 |
|---|---|---|
| 1 | 流入 URL | `buildEntryUrl()` — `entryPath` + 代理店コード |
| 2 | HTTP ステータス | `probeHttpChain()` — 3xx を 1 ホップずつ手動追跡 |
| 3 | リダイレクト回数 | `verifyRedirectTrace()` — `expectedRedirectCount` と比較 |
| 4 | リダイレクト途中の URL | `expectedRedirectPaths` を経路に含むか |
| 5 | 最終 URL | `expectedFinalPath` と一致するか (Critical) |
| 6 | 最終ページの代理店情報 | `verifySections()` / `verifyTexts()` |
| 7 | リダイレクト後のコード保持 | `verifyStoredCode()` |
| 8 | 不要なパラメータ・個人情報の付加 | `verifyUrlHygiene()` |
| 9 | リダイレクトループ | HTTP レベルとブラウザレベルの両方で検出 (Critical) |
| 10 | PC と SP で同じルール | 端末ごとに context を作り最終 URL と方式を比較 |

### 再訪時のリダイレクト (`revisitRedirect`)

流入時ではなく「コードが保存された状態で別の URL を開いたとき」に
リダイレクトするサイトがある (保存済みコードで遷移先を決める実装)。
URL のパラメータではなく Cookie が判定材料なので、
1 回開くだけでは検査できない。

```yaml
revisitRedirect:
  fromPath: /lp/service/          # コードなしで開く URL
  toPath: /lp/service-premium/    # 飛ぶ先
```

検査手順:

1. `entryPath` にコードを付けて流入する (サイト側にコードを保存させる)
2. `fromPath` をコードなしで開き、`toPath` へ飛ぶかを記録する

`revisitRedirect` が `null` の代理店は、同じ手順で
**飛ばないこと**を検査する (他の代理店の専用 LP へ誤って
飛ばされていないかの検査になる)。

遷移方式・回数が未実測の場合は `unknown` / `null` として扱い、
照合せず実測値を記録する。

### 経路の記録方法

`page.url()` による最終 URL 確認だけでは不十分なため、次を併用する。

- **`request` / `response` イベント** — メインフレームのドキュメント要求と
  レスポンスのステータス・`location` ヘッダーを記録 (`RedirectTracker`)
- **`framenavigated` イベント** — ドキュメント要求を伴わない URL 変更 (SPA) を記録
- **HTTP レベルの追跡** — `APIRequestContext` で `maxRedirects: 0` を指定し、
  1 ホップずつ辿ってステータス・中間 URL・レスポンス本文の meta refresh を取得

### 遷移方式の判定

| 判定結果 | 判定条件 |
|---|---|
| `http` | HTTP 3xx (301 / 302 / 303 / 307 / 308) が 1 回以上 |
| `meta-refresh` | レスポンス本文または DOM に `<meta http-equiv="refresh">` |
| `js` | 3xx なし・meta refresh なしで、ドキュメント要求が 2 回以上 |
| `spa` | ドキュメント要求なしで `framenavigated` による URL 変更 |
| `none` | 流入 URL と最終 URL が同一 |

`redirectMechanism` と実際の方式が異なる場合は **警告 (Medium)** として報告する
(遷移先自体が正しければ CI は失敗させない。実装方式の変更を検知するのが目的)。

> meta refresh は遷移後の DOM には残らないため、HTTP レスポンス本文から検出した
> 遷移先をヒントとして経路判定に渡している (`build(entry, max, metaRefreshHints)`)。

## 3. 別ドメインの申込ページへの引き継ぎ検査 (`@handoff`)

LP ドメインと申込ドメインは別ドメインであり、通常の Cookie は共有されない。
**引き継ぎ方法を推測せず、実際のネットワーク通信を記録して検証する。**

| # | 検査項目 | 実装 |
|---|---|---|
| 1 | 遷移先ドメイン | `verifyApplicationDestination()` (Critical) |
| 2 | 遷移先パス | 同上 (Critical) |
| 3 | コード / トークンの送信 | `HandoffRecorder` が申込ドメイン宛の通信を記録 |
| 4 | 申込側が認識した代理店 | `verifyRecognition()` — 表示・hidden・storage・API |
| 5 | 数画面進めても保持 | `verifyApplicationPersistence()` — `application.steps` |
| 6 | 再読み込み・戻る後も保持 | 同上 (`reload()` / `goBack()`) |
| 7 | コード欠落時の誤帰属なし | `verifyFallbackHandoff()` (Critical) |
| 8 | 無効コード時のフォールバック | 同上 (Critical) |
| 9 | 別代理店に置き換わっていない | `verifyRecognition()` + 申込側 API の応答 |
| 10 | 申込完了処理を実行しない | フィクスチャが完了リクエストを遮断 (Critical) |

### 引き継ぎ方式が未確定な段階の検査 (`@cta`)

引き継ぎ方式が分からないうちは、方式を推測して合否を出さない。
`agencies.yml` の `application` が `null` の代理店については、
`tests/agency/agency-cta.spec.ts` が **DOM から読み取れる事実だけ**を記録する。

| 観測項目 | 記録 |
|---|---|
| 申込サイトへ向かうリンク / フォーム | 件数・表示中の件数・パス (Low `[確認OK]`) |
| ボタンの表示文言 | `agency.yml` の `selectors.ctaPrimary` を実物に合わせるため |
| リンク URL に代理店コードが乗っているか | 乗っていなければクエリ以外の方式 (Low) |
| リンクが 1 つも無い | Medium で記録。JavaScript 遷移の可能性があるため不具合と断定しない |

クリックも送信も行わないため、本番 (読み取り専用) でも安全に実行できる。
方式が確定したら `agency-profiles.yml` の `application` を設定し、
上表の `@handoff` 検査に移す。

### 認識確認の方法 (URL だけでは合格にしない)

`application.recognition` に 1 つ以上の確認方法を指定する (設定検証で必須)。

```yaml
recognition:
  - type: text                      # 画面に表示された代理店名
    testId: application-agency-name
    expected: 株式会社エーワン保険サービス
  - type: hidden                     # hidden 項目
    testId: application-agency-code
    expected: A001
  - type: storage                    # Cookie / localStorage
    storageType: localStorage
    key: agency_code
    expected: A001
  - type: api                        # サーバーが返した代理店識別情報
    urlPattern: "**/api/session*"
    field: agency_code
    expected: A001
```

### 引き継ぎ方式

| `handoffMethod` | 内容 | 検証 |
|---|---|---|
| `query` | 申込 URL のクエリパラメータ | クエリに `handoffParam` = コードがあるか |
| `hidden` | フォームの hidden 項目 | hidden 項目の値 + POST ボディ |
| `post` | POST 送信 | POST ボディに `handoffParam` があるか |
| `api` | API 経由 | XHR / fetch の発生と内容 |
| `server-session` | サーバー側セッション | トークン / セッション Cookie の存在 |
| `token` | 一時トークン | **トークン値は比較せず**、存在と復元結果を検証 |

観測された方式が設定と異なる場合は警告 (Medium) を出し、
`npm run discover` で実仕様を確認するよう促す。

### 一時トークンの扱い

- トークン文字列そのものは固定値比較しない (毎回変わる)
- 「トークンが送信されていること」と「申込側で復元された代理店コード」を検証する
- トークン値はレポート・ログに出力しない (`utils/secrets.ts` がマスキング)

### 申込完了の防止

`config/agency.yml` の `application.forbiddenRequestPatterns` に一致するリクエストは、
**全環境で** フィクスチャが遮断し Critical として報告する。
テストは `application.steps` に定義された遷移のみを行い、完了ボタンは押さない。

### 読み取り専用環境 (本番) での引き継ぎ検査

`post` / `hidden` 方式はフォーム送信 (非 GET) を伴うため、読み取り専用環境では
実行できない。この場合は **送信せずに DOM から読み取れる範囲だけを検証**する。

| 検査項目 | 読み取り専用環境での扱い |
|---|---|
| 申込先ドメイン | フォームの `action` から検証する (Critical) |
| 申込ページのパス | 同上 (Critical) |
| hidden 項目の代理店コード | DOM から読み取って検証する (Critical) |
| 実際の送信・申込側での認識 | **スキップし、その事実を Low として記録する** |

`query` / `token` 方式は GET 遷移のみで完結するため、読み取り専用環境でも
全項目を検証できる。

> この分岐がないと、本番実行で POST 方式の代理店が毎回 Critical (誤検知) になる。
> 誤検知が常態化するとゲートが信用されなくなるため、
> 「検証できないことを記録する」動作にしている。

## 4. 無効コード / コードなし

| 設定 | 内容 |
|---|---|
| `invalidCodes` | 無効コードの一覧 (未登録・大文字小文字違いなど) |
| `invalidExpectation` | 無効コード時の期待表示・保存有無・申込側フォールバック |
| `noCodeExpectation` | コードなし時の期待表示・保存有無・申込側フォールバック |

いずれの場合も **どの代理店の情報も表示されないこと** を全代理店の
`expectedTexts` の値でページ全体を走査して確認する (誤帰属検出)。

## 5. セキュリティ検査 (`@security`)

| 検査項目 | 実装 | 重大度 |
|---|---|---|
| open redirect が発生しない | `checkOpenRedirect()` — `redirectParamNames` に外部 URL を渡す | Critical |
| 任意の外部ドメインへ遷移できない | `checkExternalNavigationTargets()` — CTA の遷移先オリジン | Critical |
| 無効コードで他代理店の情報が出ない | `verifyFallback()` / `verifyNoOtherAgencyInfo()` | Critical |
| URL パラメータを HTML へそのまま出力しない | `checkParamInjection()` — ペイロードが innerHTML に生で現れないか | Critical |
| JavaScript が実行できる値を受け付けない | 同上 — `window.__qa_xss` とダイアログを監視 | Critical |
| ログ・レポートに秘密トークンを出さない | `utils/secrets.ts` — 全 Finding に自動適用 | — |
| 一時トークンをレポート上でマスキング | `maskParamNames` / `maskValuePatterns` | — |

## 6. 重大度 (すべて Critical → CI 失敗)

| 事象 | 検出箇所 |
|---|---|
| 別代理店の LP へリダイレクトされた | `verifyRedirectTrace()` (`agency-redirect`) |
| 別代理店の名称・電話番号・バナーが表示された | `verifyTexts()` / `verifyAssets()` / `verifyNoOtherAgencyInfo()` |
| 表示すべきセクションが非表示 | `verifySections()` |
| 非表示にすべきセクションが表示 | `verifySections()` |
| 申込ページへ代理店情報が引き継がれない | `verifyHandoffTransport()` / `verifyRecognition()` |
| 申込ページで別代理店として認識された | `verifyRecognition()` |
| 無効コードが有効な代理店として処理された | `verifyFallback()` / `verifyFallbackHandoff()` |
| リダイレクトループ | `verifyHttpChain()` / `verifyRedirectTrace()` / `QaSession.goto()` |
| 申込先ドメインが仕様と異なる | `verifyApplicationDestination()` |

## 7. 実サイトへの適用手順

実サイトの仕様は推測せず、実際の通信から特定する。

```bash
# 1. 対象環境の URL を .env に設定 (LP ドメインと申込ドメインの両方)
#    STAGING_BASE_URL / STAGING_APPLICATION_BASE_URL

# 2. 仕様調査ツールで実際の挙動を記録する
QA_ENV=staging npm run discover

# 3. 出力を確認して config/agencies.yml に反映する
cat reports/discovery/suggested-agencies.yml
cat reports/discovery/A001.json

# 4. 代理店テストを実行する
QA_ENV=staging npm run test:agency
```

`npm run discover` が記録する内容:

- 流入 URL / 最終 URL / リダイレクト経路 / 遷移方式
- CTA 候補 (別ドメインを指すリンク・フォーム・申込らしいボタン)
- 申込ドメイン宛の全リクエスト (**キー名のみ**。値は出力しない)
- 申込ページの hidden 項目名・localStorage キー・Cookie 名・`data-testid` 一覧
- 申込側 API の応答キー
- `config/agencies.yml` へ反映するための推奨値

詳細は [handoff-discovery.md](handoff-discovery.md) を参照。
