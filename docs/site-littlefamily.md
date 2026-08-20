# 検査対象サイトの前提と設定 (littlefamily-ssi)

このツールを実サイトへ向けるための設定と、**まだ実測できていない項目**をまとめる。
推測で設定を書かないこと。未実測の項目は `npm run discover` で確認してから設定する。

## 1. 確認済みの前提

| 項目 | 値 |
|---|---|
| 代理店コードのパラメータ名 | `insAgentNo` |
| 共通 LP (本番) | `https://lp.littlefamily-ssi.com/lp/service/` |
| 価格コム限定プラン専用 LP (本番) | `https://lp.littlefamily-ssi.com/lp/service-premium/` |
| 共通 LP (ステージング) | `https://lp.littlefamily-ssi-stg.com/lp/service/` |
| 専用 LP (ステージング) | `https://lp.littlefamily-ssi-stg.com/lp/service-premium/` |
| コーポレートサイト | `https://www.littlefamily-ssi.com/` / `https://www.littlefamily-ssi-stg.com/` |
| ステージングの認証 | Basic 認証 (`.env` の `STAGING_BASIC_USER` / `STAGING_BASIC_PASS`) |
| 代理店コード数 | 214 件 (`config/agency-master.tsv`) |

挙動の前提:

- `littlefamily01` は自社コード。代理店コードを無効化してオリジナルを表示する
- 株式会社カカクコム・インシュアランス (`littlefamily03` および支店コード
  `littlefamily03br01`〜`br50`) だけ、LP に入った時点で専用 LP へリダイレクトする
- 「みらやく掲載可否」(○ / ×) によってセクションの表示・非表示が決まる

## 2. 214 件をどう扱うか

代理店ごとに固有の挙動があるわけではなく、いくつかのパターンに分かれる。
そのため 214 件を個別に書かず、次の 2 ファイルから `config/agencies.yml` を生成する。

| ファイル | 内容 |
|---|---|
| `config/agency-master.tsv` | 代理店コードと属性 (会社名・みらやく掲載可否) |
| `config/agency-profiles.yml` | パターンごとの期待結果、割り当てルール、絞り込み |

```bash
npm run agencies:build            # 各パターンの代表のみ (既定)
npm run agencies:build -- --all   # 全 211 件を対象にする
npm run agencies:build -- --check # 生成結果と一致するか確認する (CI 用)
```

| 絞り込み | 代理店 | テスト数 | 用途 |
|---|---|---|---|
| `sample` (既定) | 11 件 | 約 350 | 変更後の日常的な確認 |
| `--all` | 211 件 | 約 2,450 | 代理店ロジックを変更したときの全数確認 |

代理店を追加・変更するときは `config/agency-master.tsv` を編集して再生成する。
テストコードは変更しない。

**検査対象外**: `みらやく掲載可否` が `エラー` / `要確認` / 空欄の代理店は、
期待結果が確定しないため除外している (`littlefamily06` `littlefamily47` `littlefamily99`)。

> `littlefamily99` はスプレッドシート内で `○` と `エラー` の 2 通りの記載がある。
> どちらが正か確認が必要。

## 3. 未実測の項目 (discover で確認する)

以下は実サイトで確認できていない。**設定するまでその項目は検査されない**
(誤検知はしないが、見逃しになる)。

| 項目 | 設定場所 | 現在の値 | 影響 |
|---|---|---|---|
| リダイレクトの実装方式 | `agency-profiles.yml` の `redirectMechanism` | `unknown` | 方式の妥当性は判定せず、実測値を Low として記録する |
| みらやくセクションの `data-testid` | `agency-profiles.yml` の `visibleSections` / `hiddenSections` | 空 | **「× なのに表示されている」を検知できない** |
| 代理店名・電話番号などの表示 | `agency-profiles.yml` の `expectedTexts` | 空 | 表示内容の照合を行わない |
| 共通セレクタ | `agency.yml` の `selectors` | 仮の値 | 一致する要素が無い間、それを使う検査は「検出なし」になる |
| 代理店コードの保存先 | `agency.yml` の `storage` | `none` | 保存値の検査を行わない |
| 描画完了の判定 | `agency.yml` の `readyIndicator` | `none` | 待たずに検査する (クライアント描画なら取りこぼす可能性) |
| 申込ページの URL・引き継ぎ方式 | `agency-profiles.yml` の `application` | `null` | **申込導線の検査を一切行わない** |
| 申込完了 URL (押してはならない操作) | `agency.yml` の `forbiddenRequestPatterns` | 仮の値 | 申込導線の検査を有効にする前に必ず実物に合わせる |

### 実測の手順

```bash
# .env に URL と Basic 認証を設定 (run-qa.cmd の 2 を選ぶと対話で作成できる)
QA_ENV=staging npm run discover
cat reports/discovery/suggested-agencies.yml
```

出力される推奨値を `config/agency-profiles.yml` / `config/agency.yml` に反映し、
`npm run agencies:build` で再生成する。

## 4. いま実行して分かること

未実測の項目があっても、次は検査できる。

- ページが表示されるか (HTTP エラー・空白画面・読み込み遅延)
- JavaScript エラー (ABテストのタグが干渉していないか)
- レイアウト崩れ・横スクロール・要素の重なり (PC / SP)
- 画像の読み込み失敗
- リンク切れ
- カカクコムのコードで専用 LP へ遷移するか (遷移先 URL とリダイレクト回数)
- 無効コード・コードなしで専用 LP へ飛ばされないか
- 前回実行時との画面差分
- URL に個人情報や不要なパラメータが付いていないか
- open redirect / URL パラメータの HTML への出力

## 5. コーポレートサイト

`www.littlefamily-ssi.com` は LP とは別ホストのため、`config/pages.yml` には
入れられない (`baseUrl` 配下ではない)。検査する場合は
`config/environments.yml` に別環境として追加する。
代理店コードのロジックはないため、`pagesFile` を分けて表示・リンク・
文言の検査だけを行う構成になる。
