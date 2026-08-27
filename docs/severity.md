# 重大度の分類基準

`utils/findings.ts` の `DEFAULT_SEVERITY` が種別ごとの既定重大度を定義する。
個別の検査は必要に応じて重大度を上書きする。

## 分類

### Critical — CI 失敗

代理店に関する誤りは売上と信頼に直結するため最上位とする。

| 種別 | 具体例 |
|---|---|
| `agency-display` | 代理店の誤表示 (別代理店の名称・電話番号・バナーが表示される、表示すべきセクションが非表示、非表示にすべきセクションが表示) |
| `agency-persistence` | 代理店コードの欠落 (保存されない、ページ遷移で失われる、Cookie と localStorage の不一致) |
| `agency-handoff` | 申込への誤引き継ぎ (引き継がれない、申込側で別代理店として認識される、申込先ドメインが仕様と異なる、申込完了リクエストの発生) |
| `agency-redirect` | 別代理店の LP へリダイレクトされた、最終 URL が仕様と異なる |
| `redirect-loop` | リダイレクトループ (HTTP レベル / ブラウザレベル) |
| `security` | open redirect、任意の外部ドメインへの遷移、URL パラメータの HTML 出力、URL への個人情報付加 |

### High — CI 失敗

| 種別 | 具体例 |
|---|---|
| `js-error` | JavaScript エラー (`console.error` / 未捕捉例外) |
| `broken-link` | 主要リンク切れ (内部リンクの 4xx / 5xx) |
| `network-error` | ページ自体の 4xx / 5xx、API の失敗 |
| `timeout` | ページ・リンクのタイムアウト |
| `agency-redirect` (一部) | リダイレクト回数・中間 URL が仕様と異なる |
| `layout` (一部) | 必須要素の欠落、空白画面 — 申込導線の停止に相当する |
| `config` | 設定不備で検査が成立しない |
| `image-error` | 画像が表示できていない (2026-08-26 運用側の判断で Medium から上げた) |

### Medium — 記録のみ (CI 継続)

| 種別 | 具体例 |
|---|---|
| `layout` | 表示崩れ (viewport はみ出し、要素の重なり、極端に大きな要素) |
| `horizontal-scroll` | 横スクロールの発生 |
| `broken-link` (外部) | 外部リンクの 4xx / 5xx |
| `text-rule` (禁止表現) | 使用禁止表現 — 法務観点で必ず確認する必要があるため Low より上げる |
| `redirect-mechanism` | 仕様と異なる遷移方式 (HTTP 3xx / JS / meta refresh / SPA の違い) — 警告 |
| `security` (一部) | URL に不要なパラメータが付加されている |

### Low — 記録のみ (CI 継続)

| 種別 | 具体例 |
|---|---|
| `text-rule` | 誤字脱字、表記揺れ |
| `visual-diff` | 軽微な画像差分 |

## CI 判定

`config/runtime.yml` の `failOnSeverities` に含まれる重大度が 1 件でもあれば失敗とする。

```yaml
failOnSeverities:
  - critical
  - high
```

判定は二重に行われる。

1. `qa` フィクスチャの終了処理 — 該当する検知があればテスト自体を失敗させる
2. レポータ / `npm run gate` — `reports/qa-report.json` を集計して終了コード 1 を返す

CI では成果物のアップロード後にゲートを評価するため、失敗時もレポートと
スクリーンショットが Artifact として残る。

## 重大度を変更したい場合

### 種別ごとの既定値を変える

`utils/findings.ts` の `DEFAULT_SEVERITY` を編集する。

### CI 判定の対象を変える

`config/runtime.yml` の `failOnSeverities` を編集する。
例えば表示崩れも失敗扱いにする場合:

```yaml
failOnSeverities: [critical, high, medium]
```

### 個別の検査で上書きする

`qa.add({ severity: 'high', ... })` のように `severity` を明示する。
