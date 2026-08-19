# 運用手順

## 1. 実サイトへの適用手順

同梱のモックサイトで動作を確認したあと、次の順で実サイトに向ける。

### 手順1: 対象環境を設定する

`.env` (ローカル) と GitHub Secrets (CI) に URL を設定する。

```bash
# .env
STAGING_BASE_URL=https://staging.example.com
PRODUCTION_BASE_URL=https://www.example.com
```

`config/environments.yml` の `defaultEnvironment` を `staging` に変更すると、
`npm test` の既定環境が切り替わる。

### 手順2: 対象ページを登録する

`config/pages.yml` の `pages` を実サイトのページに書き換える。
まずは 1 ページだけ登録して動作確認するのが早い。

```bash
npx playwright test --grep @crawl --project=chromium-pc
```

### 手順3: 代理店コード仕様を合わせる

`config/agency.yml` を実装に合わせる。詳細は
[agency-code-scenarios.md](agency-code-scenarios.md) の「実サイトへの適用手順」を参照。

```bash
npm run test:agency
```

### 手順4: 除外リストを調整する

実サイトでは計測タグ由来の console 出力やサードパーティのリクエスト失敗が出やすい。
`config/errors.yml` の `ignoreMessages` / `ignoreUrlPatterns` に追加して、
本質的な不具合だけが残るようにする。

### 手順5: 表記ルールを整備する

`config/text-rules.yml` の `canonical` / `unifyRules` / `prohibited` を
自社の表記ガイドラインに合わせる。初回は指摘が多く出るため、
`reports/text/` の抽出結果を見ながら `excludeWords` を整えていく。

### 手順6: 基準画像を作成する

基準画像は環境ごとに分かれているため、検査したい環境それぞれで初回作成を行う。

```bash
QA_ENV=staging npx playwright test --grep @visual    # 初回: 基準画像を作成
git add screenshots/baseline
git commit -m "chore: ステージングの基準画像を追加"
```

### 手順7: CI に載せる

GitHub Secrets を設定し、Actions から手動実行して確認する。

---

## 2. 日常運用

### 公開後の確認

```bash
npm run test:production      # 本番 (読み取り・画面遷移のみ)
npm run report               # レポートを確認
```

### 見た目を意図的に変更したとき

```bash
npm run update:screenshots
git add screenshots/baseline
git commit -m "chore: 基準画像を更新"
```

### レポートの見方

1. Critical / High があれば最優先で対応する (CI も失敗している)
2. 「再現URL」をブラウザで開くと同じ状態を再現できる
3. 「期待結果」と「実際の結果」で差分を確認する
4. スクリーンショットで表示状態を確認する
5. Medium / Low は影響範囲を見て計画的に対応する

---

## 3. トラブルシューティング

### `環境「staging」の baseUrl が空です`

`.env` または GitHub Secrets に URL が設定されていない。
`config/environments.yml` の参照先 (`${STAGING_BASE_URL}` 等) を確認する。

### 視覚差分が毎回出る

動的要素がマスクされていない可能性が高い。`config/visual.yml` の `mask` に
該当要素の `data-testid` を追加する。フォントの読み込みタイミングによる差分の場合は
`compare.stabilizeDelayMs` を増やすか、`compare.maxDiffPixelRatio` を緩める。

### CI と手元で差分が出る

OS によるフォントレンダリングの差が原因。基準画像は CI と同じ環境
(ubuntu-latest) で作成したものをコミットする。

### 計測タグの console エラーが大量に出る

`config/errors.yml` の `console.ignoreMessages` に追加する。
正規表現も使える (`/^Failed to load resource/` のようにスラッシュで囲む)。

### リンク検査が遅い

`config/errors.yml` の `links.maxLinksPerPage` を下げる、または
`config/runtime.yml` の `linkCheckConcurrency` を上げる (対象サイトへの負荷と相談)。

### 対象サイトへの負荷を下げたい

`config/runtime.yml` で調整する。

```yaml
workers: 1                        # 並列実行を抑える
throttle:
  navigationDelayMs: 1000         # ページ遷移の間隔を空ける
  linkCheckDelayMs: 500
  linkCheckConcurrency: 1
```

### 表記チェックの誤検知が多い

- 固有名詞は `excludeWords` に追加する
- 特定要素を対象外にしたい場合は `extract.excludeSelectors` に追加する
- 文脈依存で正解が変わる語は `detectOnly: true` にして併用検出のみにする

### `data-testid` が対象サイトに無い

サイト側に付与するのが最も安定する。暫定対応として `css=` 接頭辞で
任意セレクタを指定できるが、CSS の変更で壊れやすい点に注意する。

---

## 4. 安全上の注意

- 本番環境では申込完了ボタンを押さない (`readOnly: true` で機構的に遮断済み)
- 個人情報を入力しない
- テスト用代理店コードのみを使用する
- Cookie や認証情報をログに出力しない
- `.env` を Git にコミットしない
- 対象サイトの負荷を考慮し、定時実行の頻度は 1 日 1 回程度に留める
