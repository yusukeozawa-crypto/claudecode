# 運用手順

## 1. 実サイトへの適用手順

同梱のモックサイトで動作を確認したあと、次の順で実サイトに向ける。

### 手順1: 対象環境を設定する

`.env` (ローカル) と GitHub Secrets (CI) に URL を設定する。

```bash
# .env
# LP ドメイン
STAGING_BASE_URL=https://staging.example.jp
PRODUCTION_BASE_URL=https://www.example.jp
# 申込ドメイン (LP とは別ドメイン)
STAGING_APPLICATION_BASE_URL=https://staging-application.example-insurance.jp
PRODUCTION_APPLICATION_BASE_URL=https://application.example-insurance.jp
```

`config/environments.yml` の `defaultEnvironment` を `staging` に変更すると、
`npm test` の既定環境が切り替わる。

### 手順2: 対象ページを登録する

`config/pages.yml` の `pages` を実サイトのページに書き換える。
まずは 1 ページだけ登録して動作確認するのが早い。

```bash
npx playwright test --grep @crawl --project=chromium-pc
```

### 手順3: 代理店ごとの仕様を実測して設定する

**引き継ぎ方式やリダイレクト仕様は推測しない。** まず調査ツールで実測する。

```bash
QA_ENV=staging npm run discover
cat reports/discovery/suggested-agencies.yml
```

出力を実装担当と確認したうえで `config/agencies.yml` に反映する
(代理店ごとの流入 LP・リダイレクト・表示内容・申込引き継ぎ)。
詳細は [handoff-discovery.md](handoff-discovery.md) と
[agency-code-scenarios.md](agency-code-scenarios.md) を参照。

```bash
QA_ENV=staging npm run test:agency      # 表示・リダイレクト・引き継ぎ
QA_ENV=staging npm run test:security    # セキュリティ検査
```

### 手順4: 描画完了の判定条件を合わせる

代理店情報がクライアント側で描画される場合、`load` 完了直後はまだ反映されていない。
`config/agency.yml` の `readyIndicator` を実サイトの実装に合わせる。

```yaml
readyIndicator:
  # 実サイトでは selector 方式が現実的 (代理店セクションの出現を待つ)
  type: selector
  selector: agency-contact      # data-testid として解決される
  timeoutMs: 5000
```

**この設定を合わせないと、テストごとに `timeoutMs` だけ待つことになる。**
実測では、条件が現れない場合と正しい場合で所要時間が 4 倍以上変わった
(代理店テスト 40 件で 64 秒 → 15 秒)。
条件が現れなかった場合はレポートに Low として記録されるため、設定漏れに気づける。

判定条件を使わない場合は `type: none` にする (`load` 完了のみで判断)。

### 手順5: 除外リストを調整する

実サイトでは計測タグ由来の console 出力やサードパーティのリクエスト失敗が出やすい。
`config/errors.yml` の `ignoreMessages` / `ignoreUrlPatterns` に追加して、
本質的な不具合だけが残るようにする。

### 手順6: 表記ルールを整備する

`config/text-rules.yml` の `canonical` / `unifyRules` / `prohibited` を
自社の表記ガイドラインに合わせる。初回は指摘が多く出るため、
`reports/text/` の抽出結果を見ながら `excludeWords` を整えていく。

### 手順7: 基準画像を作成する

基準画像は環境ごとに分かれているため、検査したい環境それぞれで初回作成を行う。

```bash
QA_ENV=staging npx playwright test --grep @visual    # 初回: 基準画像を作成
git add screenshots/baseline
git commit -m "chore: ステージングの基準画像を追加"
```

### 手順8: CI に載せる

1. まず `self-test` ジョブ (同梱モックサイト対象・Secrets 不要) が緑になることを確認する
2. GitHub Secrets を設定する (LP ドメインと申込ドメインの両方)
   - `STAGING_BASE_URL` / `STAGING_APPLICATION_BASE_URL`
   - `PRODUCTION_BASE_URL` / `PRODUCTION_APPLICATION_BASE_URL`
   - Basic 認証がある場合は `STAGING_BASIC_USER` / `STAGING_BASIC_PASS`
3. Actions から `qa` ジョブを手動実行して確認する

Secrets が未設定の場合、`qa` ジョブは実行前に明示的なエラーで停止する
(どの Secret が足りないかがログに出る)。

---

## 2. 日常運用

### 公開後の確認

```bash
npm run test:production      # 本番 (読み取り・画面遷移のみ)
npm run report               # レポートを確認
```

### 見た目を意図的に変更したとき

**基準画像を更新する前に、必ず全テストを実行して Critical / High が無いことを確認する。**
`npm run update:screenshots` は視覚差分のスイートだけを実行するため、
代理店の誤表示などの不具合が残った状態で更新すると、**その不具合を
基準画像に焼き付けてしまう** (以降その表示が「正常」として扱われる)。

```bash
npm test                      # 1. Critical / High が 0 であることを確認
npm run update:screenshots    # 2. 基準画像を更新
npm test                      # 3. 差分が消えたことを確認
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

## 2.5 複数人で運用する場合

| 役割 | 担当 | 作業 |
|---|---|---|
| 設定の管理 | QA 担当 | `config/agencies.yml` の代理店仕様を維持する。変更時は push して CI 確認 |
| 基準画像の更新 | QA 担当 | CI の Artifact から取得してコミットする (各自の PC では更新しない) |
| 対象 URL・認証情報 | 各メンバー | 自分の `.env` に記入する (リポジトリには入れない) |
| 変更後の確認 | CI (手動実行) | ABテスト開始時・セクション追加時など、必要なときに Run workflow を押す |
| 手元での確認 | 各メンバー | `npm run test:local` (視覚差分を除外) |

### 各メンバーの PC で結果が食い違う場合

まず次を確認してください。

| 症状 | 原因 |
|---|---|
| 画像差分 (Low) だけが出る | OS のフォント描画差。`npm run test:local` を使う (視覚差分を除外) |
| 代理店テストが遅い | `readyIndicator` の設定が実サイトに合っていない |
| 型チェックが通らない | Node.js のバージョン違い (`.nvmrc` に合わせる) |
| 検知件数が人によって違う | `config/*.yml` が最新でない (`git pull`) / `.env` の対象環境が違う |

`.env` の対象環境 (`QA_ENV` や URL) が人によって違うと結果も変わります。
レポート冒頭の「対象環境」を見て、同じ環境を見ているかを確認してください。

## 3. トラブルシューティング

### `環境「staging」の baseUrl が空です`

`.env` または GitHub Secrets に URL が設定されていない。
`config/environments.yml` の参照先 (`${STAGING_BASE_URL}` 等) を確認する。

### 視覚差分が毎回出る

動的要素がマスクされていない可能性が高い。`config/visual.yml` の `mask` に
該当要素の `data-testid` を追加する。フォントの読み込みタイミングによる差分の場合は
`compare.stabilizeDelayMs` を増やすか、`compare.maxDiffPixelRatio` を緩める。

### CI の self-test で Low が出る (Critical / High は 0)

基準画像を開発マシンで作成している場合、CI (ubuntu-latest) ではフォント描画の
違いにより画像差分 (Low) が出る。**Low はゲート対象外なのでジョブは成功する。**

実測例 (モックサイト対象の self-test):

| 環境 | 検知件数 |
|---|---|
| 開発マシン | Critical 0 / High 0 / Medium 0 / Low 4 (情報記録のみ) |
| CI (ubuntu-latest) | Critical 0 / High 0 / Medium 0 / Low 11 (情報記録 4 + 画像差分 7) |

Low 4 の内訳は「一時トークンによる引き継ぎを確認」(PC/SP) と
マスキング検証 (PC/SP) で、いずれも不具合ではなく記録目的のもの。

差分を無くすには、CI の Artifact から `screenshots/baseline` を取得してコミットする。

> **本番環境の基準画像をコミットする場合は内容を確認すること。**
> 基準画像は対象サイトのフルページスクリーンショットであり、
> 本番の画面 (キャンペーン内容・代理店情報など) がリポジトリに残る。
> 公開リポジトリや広く共有されるリポジトリでは、
> ステージングの基準画像のみをコミットする運用を推奨する
> (`.gitignore` に `screenshots/baseline/production/` を追加する)。

### CI と手元で差分が出る

OS によるフォントレンダリングの差が原因。基準画像は CI と同じ環境
(ubuntu-latest) で作成したものをコミットする。
画像差分は Low のため CI は失敗しないが、差分が常時出る状態は避ける
(Artifact から CI で作成された基準画像を取得してコミットする)。

### npm ci が失敗する

`package.json` と `package-lock.json` が同期していない。
`npm install` を実行して lock ファイルを更新し、両方をコミットする。

### 計測タグの console エラーが大量に出る

`config/errors.yml` の `console.ignoreMessages` に追加する。
正規表現も使える (`/^Failed to load resource/` のようにスラッシュで囲む)。

### リンク検査が遅い

`config/errors.yml` の `links.maxLinksPerPage` を下げる、または
`config/runtime.yml` の `linkCheckConcurrency` を上げる (対象サイトへの負荷と相談)。

### リダイレクトの実装方式が変わったと警告が出る

`redirect-mechanism` の警告 (Medium) は、HTTP 3xx だったものが JavaScript 遷移に
変わった場合などに出る。遷移先が正しければ CI は失敗しない。
実装変更が意図したものであれば `config/agencies.yml` の `redirectMechanism` を更新する。

### 引き継ぎ方式が仕様と異なると警告が出る

`npm run discover` で実際の方式を確認し、`application.handoffMethod` を更新する。
複数の方式が併用されている場合は、どれが正なのかを実装担当に確認する。

### 申込ページで代理店が認識されない

`recognition` の確認方法が実装と合っていない可能性がある。
`npm run discover` の出力 (hidden 項目名・localStorage キー・`data-testid` 一覧・
API 応答キー) を見て `recognition` を修正する。

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
- 申込完了リクエストは全環境で遮断される (`application.forbiddenRequestPatterns`)
- 一時トークン・セッション ID はレポートに出力されない (マスキング済み)
- 個人情報を入力しない
- テスト用代理店コードのみを使用する
- Cookie や認証情報をログに出力しない
- `.env` を Git にコミットしない
- 対象サイトの負荷を考慮し、短時間に繰り返し実行しない (既定では定時実行を行わない)
