# 検査項目 仕様

各検査の判定ロジックと閾値。閾値はすべて設定ファイルで変更できる。

---

## 1. 表示崩れ (`utils/layout.ts` / `config/layout.yml`)

### 1.1 横スクロール

| 項目 | 内容 |
|---|---|
| 判定 | `document.documentElement.scrollWidth > clientWidth + tolerancePx` |
| 閾値 | `horizontalScroll.tolerancePx` (既定 2px) |
| 付加情報 | viewport 右端を超えている要素を最大 5 件、セレクタ・右端座標・幅つきで報告 |
| 重大度 | Medium (`horizontal-scroll`) |

はみ出し要素の特定は `data-testid` → `id` → `タグ名 + クラス名` の優先順で行う。

### 1.2 画像の読み込み

| 項目 | 内容 |
|---|---|
| 判定 | `img.naturalWidth === 0` |
| 事前処理 | `images.scrollThroughPage: true` の場合、遅延読み込み画像を読み込ませるためページ全体をスクロールし、全画像の `complete` を待つ |
| 除外 | `images.ignoreUrlPatterns` (glob) |
| 重大度 | Medium (`image-error`) |

ネットワーク監視側でも画像リクエストの 4xx/5xx を `image-error` として検知する
(両方で検知された場合は 2 件として記録され、原因の切り分けに使える)。

### 1.3 必須要素

| 項目 | 内容 |
|---|---|
| 判定 | `pages.yml` の `requiredTestIds` の要素が存在し、かつ表示されているか |
| 重大度 | High (`layout`) |

### 1.4 viewport はみ出し

| 項目 | 内容 |
|---|---|
| 対象 | `pages.yml` の `primaryTestIds` |
| 判定 | 要素の右端 > `viewport幅 + tolerancePx`、または左端 < `-tolerancePx` |
| 閾値 | `viewportOverflow.tolerancePx` (既定 4px) |
| 除外 | `viewportOverflow.ignoreTestIds` (意図的に画面幅より広いカルーセル等) |
| 重大度 | Medium (`layout`) |

### 1.5 要素の重なり

| 項目 | 内容 |
|---|---|
| 対象 | `primaryTestIds` の総当たり (表示されている要素のみ) |
| 判定 | 重なり面積 ÷ 小さい方の面積 > `maxOverlapRatio` |
| 閾値 | `overlap.maxOverlapRatio` (既定 0.25) |
| 除外 | DOM 上で入れ子関係にある要素同士 (親子は重なりとみなさない)、`overlap.ignoreTestIds` |
| 重大度 | Medium (`layout`) |

> 入れ子の除外は必須。除外しないと「ヘッダー内のボタン」のような正常な構造が
> 常に重なりとして誤検知される (実装時に自己検査で検出された事例)。

### 1.6 空白画面・極端に大きな要素

| 項目 | 内容 |
|---|---|
| 空白画面の判定 | `body.innerText` の空白除去後の文字数 < `minVisibleTextLength` (既定 50) |
| 空白画面の重大度 | High (`layout`) |
| 巨大要素の判定 | 最も高い要素の高さ > `viewport高さ × maxElementHeightRatio` (既定 12) |
| 巨大要素の重大度 | Medium (`layout`) |

---

## 2. エラー検知 (`utils/monitors.ts` / `config/errors.yml`)

`PageMonitor` がページに監視を仕掛け、4 種類のイベントを記録する。

| 監視対象 | 設定キー | 重大度 | 種別 |
|---|---|---|---|
| `console` (既定は `error` のみ) | `console.levels` | High | `js-error` |
| `pageerror` (未捕捉例外) | `pageError.enabled` | High | `js-error` |
| 4xx / 5xx レスポンス | `network.failStatuses` | High (画像は Medium) | `network-error` / `image-error` |
| リクエスト失敗 | `network.enabled` | High (タイムアウトは `timeout`、画像は `image-error`) | — |

### 除外設定

| 設定キー | 内容 |
|---|---|
| `console.ignoreMessages` | 部分一致、または `/正規表現/フラグ` 形式 |
| `pageError.ignoreMessages` | 同上 |
| `network.ignoreUrlPatterns` | glob (計測タグ・広告ドメインを既定で除外) |
| `network.ignoreThirdParty` | `true` の場合、baseUrl と別オリジンのリクエスト失敗を無視する |

### ページ読み込みの遅延・タイムアウト

| 事象 | 判定 | 重大度 |
|---|---|---|
| 読み込みが遅い | `goto` の所要時間 > `timeout.pageLoadWarnMs` (既定 15000ms) | Medium (`timeout`) |
| 読み込みタイムアウト | `goto` が `runtime.timeouts.navigation` を超過 | High (`timeout`) |
| リンク先のタイムアウト | `checkLink` の fetch が `runtime.timeouts.navigation` を超過 | High (`timeout`) |

いずれも `tests/self-check/timeout-cases.spec.ts` で検証している
(モックサイトの `/slow?ms=N` エンドポイントを使用し、閾値を下げた設定で確認)。

### リダイレクトループ

ページ遷移時のエラーメッセージが `ERR_TOO_MANY_REDIRECTS` を含む場合、
High (`redirect-loop`) として記録する。リンク検査側でも独立に検出する (下記)。

---

## 3. リンク切れ (`utils/links.ts` / `config/errors.yml`)

### 収集

| 項目 | 内容 |
|---|---|
| 対象 | `a[href]` の絶対 URL (`http` / `https` のみ) |
| 正規化 | ハッシュを除去して重複排除 |
| 範囲 | `links.scope` — `internal` (同一オリジンのみ) / `all` |
| 除外 | `links.ignoreUrlPatterns` (`mailto:` / `tel:` / `javascript:` / PDF 等) |
| 上限 | `links.maxLinksPerPage` (既定 40) — 対象サイトへの過剰リクエスト防止 |

### 検査

ページ遷移は行わず `APIRequestContext` で確認する (本番環境でも安全)。

| 項目 | 内容 |
|---|---|
| メソッド | 内部リンクは `GET`、外部リンクは `links.externalMethod` (既定 `HEAD`) |
| リダイレクト | `maxRedirects: 0` で 1 ホップずつ手動追跡 |
| ループ判定 | 同一 URL への再訪、または起点 URL への回帰、または `links.maxRedirects` 超過 |
| 並列数 | `runtime.throttle.linkCheckConcurrency` (既定 4) |
| 間隔 | `runtime.throttle.linkCheckDelayMs` (既定 150ms) |

### 重大度

| 事象 | 重大度 | 種別 |
|---|---|---|
| 内部リンクの 4xx / 5xx | High | `broken-link` |
| 外部リンクの 4xx / 5xx | Medium | `broken-link` |
| リダイレクトループ | High | `redirect-loop` |
| タイムアウト | High | `timeout` |
| 接続失敗 | High | `broken-link` |

---

## 4. スクリーンショット比較 (`utils/screenshots.ts` / `config/visual.yml`)

### 保存

| 項目 | 内容 |
|---|---|
| 保存先 | `screenshots/current/<env>/<browser>-<device>/<pageId>[__<suffix>].png` |
| 範囲 | `capture.fullPage: true` でフルページ |
| マスク | `mask` の要素を `maskColor` で塗り潰す |
| 添付 | レポートから参照できるようテストに添付する |

### 比較

基準画像は `screenshots/baseline/<環境>/<project>/` に保存される。
環境ごとに分離されているため、`local` の基準画像がステージング/本番の比較に使われることはない。

| 段階 | 挙動 |
|---|---|
| 初回 (基準画像なし) | 基準画像を作成し、比較は行わない (不具合として扱わない) |
| 2 回目以降 | 基準画像と比較し、許容値を超えたら Low (`visual-diff`) |
| 更新 | `npm run update:screenshots` |

| 設定キー | 内容 |
|---|---|
| `compare.threshold` | ピクセルの色差の閾値 (0-1、既定 0.2) |
| `compare.maxDiffPixelRatio` | 差分ピクセルの許容比率 (0-1、既定 0.01) |
| `compare.maxDiffPixels` | 差分ピクセル数の許容値 (既定 null = 比率のみで判定) |
| `compare.animations` | `disabled` でアニメーションを停止 |
| `compare.caret` | `hide` でテキストキャレットを隠す |
| `compare.stabilizeDelayMs` | 比較前の待機 (既定 300ms) |

差分が出た場合、基準画像 / 現在画像 / 差分画像が Playwright レポートに添付され、
`reports/test-results/` 配下にも出力される。

> 基準画像は CSS ピクセル基準 (`scale: 'css'`) で作成する。SP の
> `deviceScaleFactor: 3` のまま保存すると比較時に解像度が一致せず、
> 毎回差分として検出されてしまう (実装時に検出された事例)。

### 動的要素のマスク

`mask` に指定した要素は比較対象から除外される。既定では次を想定している。

- 日時表示 (`current-datetime`)
- カルーセル (`hero-carousel`)
- 外部チャットの iframe (`css=iframe[src*='chat']`)
- 広告枠 (`css=.ad-slot`)

---

## 5. 誤字脱字・表記揺れ (`utils/text-rules.ts` / `config/text-rules.yml`)

AI API は使用せず、まず表示テキストを抽出して保存し、ルールベースで検出する。

### 抽出 (`utils/text-extract.ts`)

| 項目 | 内容 |
|---|---|
| 対象 | 見出し・段落・リスト・表・リンク・ボタン・ラベル等の直下テキスト |
| 除外 | `extract.excludeSelectors` (`script` / `style` / `aria-hidden` 等) |
| 非表示要素 | `display: none` / `visibility: hidden` は除外 |
| 重複除去 | 入れ子による同一テキストの重複を除去 |
| 保存先 | `reports/text/<env>/<pageId>__<browser>-<device>.{json,csv}` |

### 検出ルール

| 種別 | 設定キー | 内容 | 重大度 |
|---|---|---|---|
| 表記揺れ | `unifyRules` | `variants` の出現を検出し `preferred` を提案 | Low |
| 併用検出 | `unifyRules[].detectOnly` | 「保障 / 補償」のように正解が文脈依存の語は、同一ページ内での併用のみ報告 | Low |
| 正式名称の誤表記 | `canonical.aliases` | 誤 → 正 の対応表 | Low |
| 保険用語 | `insuranceTerms` | 業界用語の表記統一 | Low |
| 使用禁止表現 | `prohibited` | 断定表現・優位性表示など。理由つきで報告 | **Medium** |
| 誤字候補 | `typoPatterns` | 誤 → 正。`exceptWhenFollowedBy` で正しい用法を除外 | Low |
| 体裁 | `formatting` | 連続スペース、全角英数字 | Low |
| ページ間の不統一 | `unifyRules` | 同じルールの語がページごとに異なる表記になっている | Low |

### 誤検知の抑制

| 仕組み | 内容 |
|---|---|
| `excludeWords` | 固有名詞・法令名など、ルールを適用しない語。該当範囲内の検出を無視する |
| `exceptWhenFollowedBy` | 「保健」は誤字候補だが、後続が「所」「師」等なら正しい用法として除外 |
| 正式表記との重なり除外 | 「お申込み」を検出する際、「お申し込み」の一部と重なる位置は除外する |

### AI チェックの拡張

`utils/ai-text-checker.ts` に `AiTextChecker` インターフェースのみを用意している。
既定 (`aiCheck.enabled: false`) では何も実行しない。実装を登録し設定を有効化すると、
抽出済みテキストに対して AI 指摘が Finding として追加される。API キーは
`aiCheck.apiKeyEnv` で指定した環境変数から取得し、設定ファイルには書かない。

---

## 6. 秘密情報・個人情報のマスキング (`utils/secrets.ts`)

レポート (HTML / JSON)・添付する証跡・検査文脈の URL に対して自動適用される。

| 対象 | 判定方法 | 適用範囲 |
|---|---|---|
| 一時トークン・セッション ID・認証情報 | `security.maskParamNames` のキー名 | クエリ形式・JSON/ログ形式の両方 |
| トークンらしい値 | `security.maskValuePatterns` (JWT・長い 16 進) | 文字列全体 |
| 個人情報らしいキー | `redirect.forbiddenQueryParamKeywords` | **クエリ形式のみ** |
| 個人情報らしい値 | `redirect.piiValuePatterns` | URL のクエリ値のみ |

設計上の注意点:

- **区切り文字とクォートを保持する。** 壊すと添付した証跡が JSON として
  解析できなくなり、証跡の意味が失われる (自己検査で担保)。
- **個人情報キーはクエリ形式のみを対象にする。** JSON のキー名 (`"name"` 等) まで
  潰すと、調査ツールの出力 (hidden 項目名の一覧) が読めなくなる。
- **値のパターンは本文に適用しない。** 代理店の電話番号は期待値として
  レポートに表示する必要があるため。

「URL に個人情報が含まれている」ことは Critical として報告するが、
その値自体はレポートへ出力しない。

> トレース (`config/runtime.yml` の `trace` / `traceCi`) には通信内容が
> そのまま含まれる。マスキングの対象外なので、Artifact の共有範囲に注意する。

## 7. 代理店ごとの検査

代理店コードに関する検査 (表示・リダイレクト・別ドメイン申込引き継ぎ・セキュリティ) は
[agency-code-scenarios.md](agency-code-scenarios.md) を参照。

## 8. 設定検証 (`utils/config.ts` の `validateConfig`)

運用者は `config/agencies.yml` を頻繁に編集するため、
起動時に設定を検証し、不備があれば内容を列挙して実行前に停止する。
検知されるのは次のような編集ミス (いずれも自己検査で担保)。

| 編集ミス | メッセージ |
|---|---|
| 代理店コードの重複 | 「代理店コードが重複しています: XXX」 |
| `redirected: true` なのに遷移先が流入 URL と同じ | 「redirected: true ですが expectedFinalPath が entryPath と同一です」 |
| `redirected: false` なのに遷移先が異なる | 「redirected: false ですが expectedFinalPath が entryPath と異なります」 |
| `recognition` が空 | 「recognition が空です (URL だけで合格にしないため 1 つ以上必要)」 |
| 表示・非表示セクションの重複 | 「visibleSections と hiddenSections が重複しています」 |
| 有効コードと無効コードの二重定義 | 「agencies と invalidCodes の両方に定義されています」 |
| 申込ドメインの未設定 | 「applicationBaseUrl が空です」 |
| 存在しないページ id の参照 | 「persistenceFlow の未知のページ id: XXX」 |
| 有効なブラウザが無い | 「有効なブラウザが 1 つもありません」 |

## 9. 検出ロジックの自己検査 (`tests/self-check/`)

| ファイル | 検証内容 |
|---|---|
| `detectors.spec.ts` | 表示崩れ・エラー・リンク・表記・リダイレクト判定・マスキング・project 生成・ページ取得 |
| `masking-cases.spec.ts` | 形式別のマスキング (クエリ / JSON) と過剰マスキングの防止 |
| `timeout-cases.spec.ts` | 読み込み遅延・タイムアウト・リンク先タイムアウト |
| `config-validation.spec.ts` | 設定検証のメッセージとセレクタ解決 |

意図的に壊したページ (`fixtures/mock-site/broken/`) に対して、
各検出ロジックが実際に反応することを確認する。`local` 環境でのみ実行。

| 検査 | 使用ページ | 確認内容 |
|---|---|---|
| 横スクロール・重なり | `overflow.html` | `horizontal-scroll` と重なりが検出される |
| 誤検知 (表示崩れ) | `/lp/` | 正常なページで検知が 0 件 |
| JavaScript エラー | `js-error.html` | `console.error` と `pageerror` が記録される |
| 画像読み込みエラー | `broken-image.html` | `naturalWidth === 0` と 404 が検出される |
| リンク切れ | `broken-link.html` | 404 / 500 / リダイレクトループが検出される |
| 表記揺れ | `typos.html` | 表記揺れ・誤字・正式名称・禁止表現・体裁が検出され、除外語は誤検知しない |
| 誤検知 (表記) | `/lp/` | 正常なページで指摘が 0 件 |
| 重大度ゲート | — | Low / Medium では失敗せず、Critical / High で失敗する |
| 遷移方式の判定 | — | HTTP 3xx / meta refresh / JavaScript / SPA / なし を判別できる |
| 別代理店へのリダイレクト | — | 想定外の最終 URL が Critical として検出される |
| リダイレクトループ | — | Critical として検出される |
| URL への個人情報付加 | — | 個人情報らしいパラメータが Critical として検出される |
| 別代理店の情報表示 | `/lp/` を改変 | 代理店名の誤表示・別代理店情報の表示が検出される |
| セクションの表示崩れ | `/lp/` を改変 | 表示すべき非表示 / 非表示すべき表示が検出される |
| トークンのマスキング | — | 検知結果の本文・URL からトークンが除去される |
| 読み込み遅延 | `/slow?ms=900` | 閾値超過が Medium として検出される |
| 読み込みタイムアウト | `/slow?ms=3000` | High として検出される |
| リンク先のタイムアウト | `/slow?ms=2500` | タイムアウトと判別できる |
| 誤検知 (遅延) | `/lp/` | 閾値内なら検知しない |
| マスキング (クエリ形式) | — | `?handoff_token=` / `&mail=` / `&tel=` の値が除去される |
| マスキング (JSON 形式) | — | 値が除去され、かつ JSON として解析できる (証跡が壊れない) |
| マスキング (過剰防止) | — | JSON のキー名 (`name` 等) と代理店の電話番号は保持される |
| project 生成 | — | ブラウザ有効化だけで PC/SP の project が生成される |
| Firefox の制約 | — | Firefox では `isMobile` / `hasTouch` を適用しない |
| Chromium 実体の指定範囲 | — | `QA_CHROMIUM_EXECUTABLE` が chromium 以外に適用されない |
