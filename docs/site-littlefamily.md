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
| 申込ドメイン (ステージング) | `https://days.littlefamily-ssi-stg.com` |
| 申込の入口 (ステージング) | `/solicitation/step1` |
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
npm run agencies:build            # config/agencies.yml を再生成 (全 211 件を出力)
npm run agencies:build -- --check # 生成結果と一致するか確認する (CI 用)
```

`config/agencies.yml` には全 211 件が入る。**実際に検査する代理店は実行ごとに抽選する。**

| 実行方法 | 代理店 | テスト数 | 用途 |
|---|---|---|---|
| 既定 (抽選) | 11 件 | 約 350 | 変更後の日常的な確認 |
| `npm run test:agency:all` | 211 件 | 約 2,450 | 代理店ロジックを変更したときの全数確認 |

### 毎回同じ代理店を検査しない

毎回同じ 11 件だけを見ていると、そこは通るが**残り 200 件に潜む問題を見逃し続ける**。
そのため挙動パターンごとに実行ごとに抽選する。

- パターンごとに 3 件 (`scope.perProfile`)
- 挙動が 1 件しかなく外せないものだけ固定 (`scope.always`: `littlefamily01`, `littlefamily03`)
- 11 件のうち 8〜9 件が実行ごとに入れ替わる

抽選は 1 回の実行の中では必ず同じ結果になる。テストは複数のワーカープロセスで
実行されるため、プロセスごとに抽選し直すとテスト一覧が食い違って実行が壊れる。
`playwright.config.ts` がワーカー起動前にシードを確定させ、ワーカーは
環境変数として受け継ぐ。

**同じ組み合わせを再現する**: レポートに記録されたシードを指定する。

```
代理店 : 11 / 211 件 (抽選)  再現用: QA_AGENCY_SEED=m3k8xq-a71f9c
```

```powershell
$env:QA_AGENCY_SEED="m3k8xq-a71f9c"; npm run test:agency
```

代理店を追加・変更するときは `config/agency-master.tsv` を編集して再生成する。
テストコードは変更しない。

**検査対象外**: `みらやく掲載可否` が `エラー` / `要確認` / 空欄の代理店は、
期待結果が確定しないため除外している (`littlefamily06` `littlefamily47` `littlefamily99`)。

> `littlefamily99` はスプレッドシート内で `○` と `エラー` の 2 通りの記載がある。
> どちらが正か確認が必要。

## 3. リダイレクトの現在の想定

代理店コードごとに、次の 5 点を仕様として持ち、実測値と突き合わせている。

| 項目 | カカクコム (`littlefamily03*`) | それ以外 |
|---|---|---|
| 流入 URL | `/lp/service/?insAgentNo=<コード>` | 同じ |
| 最終的に表示される URL | `/lp/service-premium/` | `/lp/service/` |
| リダイレクトするか | する | しない |
| リダイレクト回数 | **未実測** (照合せず実測値を記録) | **0 回** |
| 経路に含まれるべき URL | `/lp/service-premium/` | — |
| 実装方式 | **未実測** (照合せず実測値を記録) | リダイレクトなし |

カカクコムの**回数と方式は実測していない**ため、照合せず実測値を Low で記録する。
推測した回数で判定すると、正常なサイトを不具合として報告してしまうため。
「専用 LP に着くこと」「他の代理店は着かないこと」は照合し続ける
(こちらが仕様として確定している部分)。

実測値が分かったら `config/agency-profiles.yml` の
`expectedRedirectCount` / `redirectMechanism` に設定する。
以降は回数や方式が変わったことを検知できるようになる。

「リダイレクト回数」は次の合計として数えている。

| 数えるもの | 内容 |
|---|---|
| HTTP 3xx | 301 / 302 / 303 / 307 / 308 |
| meta refresh | `<meta http-equiv="refresh" content="0;url=...">` |
| JavaScript による遷移 | メインフレームの追加のドキュメント要求 |
| SPA ルーティング | ドキュメント要求を伴わない**パスの変更** |

**数えないもの** (実サイトで誤検知の原因になるため除外している):

- クエリだけの書き換え (`history.replaceState` で `?utm_source=` を付ける等)
- フラグメントだけの変更 (`#section`)
- iframe 内の遷移 (広告・タグマネージャ)
- 同一 URL の再取得 (ループとみなさない。ループ判定は HTTP 3xx の重複のみ)

想定が合っているかは、レポートの「実際」に内訳が出るので判別できる。

```
実際: 2 回 (HTTP 3xx: 1, ドキュメント要求: 3, SPA: 0, meta refresh: 0)
```

- `HTTP 3xx` が 1 で回数も 1 → サーバー側の 302。想定どおり
- `ドキュメント要求` が多い → JavaScript による遷移が挟まっている
- `SPA` が 1 以上 → クライアント側のルーティング
- リダイレクトなしの代理店で回数が 1 以上 → **想定が違う**

## 4. 未実測の項目 (discover で確認する)

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
| 申込への引き継ぎ方式 | `agency-profiles.yml` の `application` | `null` | **申込導線の検査を一切行わない** |
| 申込完了 URL (押してはならない操作) | `agency.yml` の `forbiddenRequestPatterns` | 仮の値 | 申込導線の検査を有効にする前に必ず実物に合わせる |

### 実測の手順

```bash
# .env に URL と Basic 認証を設定 (run-qa.cmd の 2 を選ぶと対話で作成できる)
QA_ENV=staging npm run discover
cat reports/discovery/suggested-agencies.yml
```

出力される推奨値を `config/agency-profiles.yml` / `config/agency.yml` に反映し、
`npm run agencies:build` で再生成する。

## 5. いま実行して分かること

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

## 6. 申込導線 (days ドメイン)

申込は LP とは別ドメイン (`days.littlefamily-ssi-stg.com`)、入口は
`/solicitation/step1` であることが分かっている。ただし
**代理店コードをどう引き継いでいるかが未確認**のため、
`application` は `null` のまま (検査していない)。

有効にするには次が必要。

1. 引き継ぎ方式 — URL クエリ / hidden 項目 / POST / 一時トークン / サーバーセッション
2. 申込側で「その代理店として認識されている」ことの確認方法
   (表示される代理店名、hidden 項目、Cookie、API 応答 など)
3. **申込完了 URL** — 本番で絶対に押してはならない操作。
   `config/agency.yml` の `forbiddenRequestPatterns` に設定する

1 と 2 は `npm run discover` で実測できる。
3 は実測に頼らず、実装を確認して設定すること
(誤って申込を完了させると取り消せない)。

## 7. コーポレートサイト

`www.littlefamily-ssi.com` は LP とは別ホストのため、`config/pages.yml` には
入れられない (`baseUrl` 配下ではない)。検査する場合は
`config/environments.yml` に別環境として追加する。
代理店コードのロジックはないため、`pagesFile` を分けて表示・リンク・
文言の検査だけを行う構成になる。
