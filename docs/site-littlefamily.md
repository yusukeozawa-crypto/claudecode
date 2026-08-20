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
  (支店コードもリダイレクトする — 確認済み)
- リダイレクト後、URL に `insAgentNo` は**おそらく残らない**。
  そのため代理店の紐づけは URL 以外 (Cookie / サーバー側セッション) で
  行われている可能性が高い。`config/agency.yml` の `storage` は
  未確認のため `none` にしてあり、**保存値の検査は行っていない**。
  discover の出力に Cookie 名が出るので、それを見て設定する
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

### 導入中は最小の件数で確認する

`scope.perProfile` は **1** にしている (パターンごと 1 社 + 常時 2 社 = 4 社)。
件数が多いと、ツール側の問題とサイト側の問題が混ざって切り分けにくいため、
まず最小で「ツールが正しく動くこと」を確定させる。

確定したら、ブラウザ画面の「件数」で標準 (パターンごと 3 社) に上げる。
設定ファイルは書き換えない (`QA_AGENCY_PER_PROFILE` で切り替わる)。

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
期待結果が確定しないため除外している (`littlefamily06` `littlefamily47`)。

> `littlefamily99` はスプレッドシート内で `○` と `エラー` の 2 通りの記載があったが、
> 運用側の確認により **○ (掲載可)** で確定 (2026-08)。検査対象に含めている。
> `littlefamily06` / `littlefamily47` は `エラー` のままなので、
> 掲載可否が確定したら `agency-master.tsv` の `mirayaku` 列に `○` / `×` を入れる。

## 3. リダイレクトの仕様 (2026-08-20 運用側の確認で修正)

**流入時にリダイレクトは起きない。** 最初はここを誤解していた。

カカクコムの流入 URL は最初から専用 LP。

```
https://lp.littlefamily-ssi.com/lp/service-premium/?insAgentNo=littlefamily03
```

`/lp/service/?insAgentNo=littlefamily03` のような URL は**運用上存在しない**。
そのため「通常 LP にコード付きで入ると専用 LP へ飛ぶ」という検査は
成立しない (実際に飛ばないのは正しい挙動だった)。

リダイレクトが起きるのは **再訪のとき**。

| 段階 | URL | 結果 |
|---|---|---|
| 1. 流入 | `/lp/service-premium/?insAgentNo=littlefamily03` | 専用 LP を表示。コードが Cookie に保存される |
| 2. 再訪 | `/lp/service/` (コードなし) | **専用 LP へリダイレクト** |

判定の根拠は URL のパラメータではなく **Cookie に保存されたコード**。
Cookie が無い状態で `/lp/service/?insAgentNo=littlefamily03` を開いても飛ばない。

この 2 段階を `agency-profiles.yml` で分けて設定している。

```yaml
kakakucom:
  entryPath: /lp/service-premium/       # 流入はここ
  expectedFinalPath: /lp/service-premium/
  redirected: false                     # 流入時は飛ばない
  revisitRedirect:                      # 再訪時に飛ぶ
    fromPath: /lp/service/
    toPath: /lp/service-premium/
```

検査は 2 回開いて確認する (`@redirect`)。

1. コードを付けて `entryPath` に流入する (サイト側にコードを保存させる)
2. コードを付けずに `fromPath` を開き、`toPath` へ飛ぶかを見る

`revisitRedirect` が無い代理店については、
同じ手順で **飛ばないこと**を検査する。
他の代理店が専用 LP へ誤って飛ばされていないかの検査になる。

再訪時の遷移方式と回数は未実測のため、照合せず実測値を記録する。
判明したら設定に書けば、以降は方式や回数の変化を検知できる。

> Cookie 名は未確認のまま。上記の検査は「2 回開いて結果を見る」方式なので、
> Cookie 名を知らなくても成立する。
> `agency.yml` の `storage.type` は `none` のままにしている
> (キー名を推測して検査すると誤検知になるため)。

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

## 4. 実測結果 (2026-08-20 ステージング)

`npm run discover` をステージングに対して実行した結果。

### 4-1. リダイレクトが観測されなかった

**カカクコムのコードでも専用 LP へのリダイレクトが起きていない。**

```
[littlefamily03]
  流入 URL : https://lp.littlefamily-ssi-stg.com/lp/service/?insAgentNo=littlefamily03
  最終 URL : https://lp.littlefamily-ssi-stg.com/lp/service/?insAgentNo=littlefamily03
  遷移方式 : リダイレクトなし (HTTP 3xx: 0, meta refresh: 0, SPA: 0)
```

`littlefamily03` `littlefamily03br37` `littlefamily03br46` すべて同じ。
支店コードも本体も、`/lp/service/` に留まっている。

仕様は「カカクコムのコードで流入したら `/lp/service-premium/` へリダイレクト」
なので、**設定と実際が食い違っている**。次のいずれか。

| 可能性 | 確認方法 |
|---|---|
| ステージングにリダイレクトが未反映 | 本番で `npm run test:production` を実行して比較する |
| リダイレクトの条件が別にある (Cookie・初回のみ・時間帯など) | 実装を確認する |
| 仕様が変わった | 仕様の確認 |

**この不一致は設定を書き換えて消してはいけない。**
リダイレクトが本当に不要なら `kakakucom` プロファイルの
`expectedFinalPath` を `/lp/service/` に変え、`redirected: false` にする。
それまでは Critical のまま残す (検知できている状態を維持する)。

### 4-2. みらやくの表示差分の実体

コードなしの通常 LP を基準にした差分。

| 代理店 | みらやく | 差分 |
|---|---|---|
| `littlefamily01` (ダイレクト) | ○ | **差分なし** (自社コード = オリジナル表示。仕様どおり) |
| `littlefamily18br14` | ○ | キャンペーンバナー 5 件が消える。文言の差分なし |
| `littlefamily03` (カカクコム) | ○ | バナー 5 件が消える + 「募集代理店：株式会社カカクコム・インシュアランス」が出る |
| `littlefamily12` (ドコモ) | × | バナー 5 件が消える + 募集代理店表記が出る + **24 行のテキストが消える** |

みらやく × で消えている 24 行には次が含まれる。

- 「月額780円〜でさらに安心」(保険料の訴求)
- 「安心パック※2 基本プランに追加できるオプション」
- 「保険料 提携先の保護団体を…」
- 約款・重要事項説明書への案内、補償内容の注記

つまり**みらやくの差分は 1 つのセクションではなく、
保険料・オプション・注記など複数箇所のテキストに及ぶ**。
セレクタを列挙する方式では取りこぼす。

そのため「同じ分類なら表示が一致する / ○ と × は表示が異なる」という
一貫性検査 (`tests/agency/agency-display-consistency.spec.ts`) を主とし、
セクションの列挙は補助とする。

### 4-3. 検査で確定した不具合 (ステージング)

`npm run test:agency` の結果。**カカクコムのリダイレクトが動いていない**ことが
PC / SP の両方で確定した。

```
[Critical] littlefamily03: リダイレクトされるべきですがリダイレクトされていません
  期待   : /lp/service-premium/ へリダイレクト
  実際   : リダイレクトなし
  経路   : /lp/service/?insAgentNo=littlefamily03 -> (同じ URL) [200]
```

`littlefamily03` `littlefamily03br02` `littlefamily03br11` の 3 件で同じ。
HTTP 200 が直接返っており、3xx も meta refresh も JavaScript 遷移も無い。

### 4-4. その他の実測

- **キャンペーンバナー** `#lf-campaign-banner-202609-1` 〜 `-5` は
  代理店コードが付くと消える (コードなしのときだけ表示)。
  みらやく可否とは無関係で、全代理店で同じ挙動。

  **2026-08-20: 運用側の確認により「実際の画面には表示されていない」ため、
  比較対象から除外した** (`displayIgnoreKeys` に `css=#lf-campaign-banner-*`)。
  id に年月が入るため、毎月書き換えずに済むようパターンで指定している。

  以下は経緯の記録。

  ただしこれは **検査ツール側の判定が甘かった可能性が高い**。
  運用側の確認では「画面上にそのようなバナーは見えていない」。
  以前の判定は「幅と高さの両方が 0 なら非表示」だったため、
  高さ 0 に潰れた枠 (公開前のキャンペーン枠) を表示として数えていた。
  現在は次を非表示として扱う (2026-08 修正):

  - 幅または高さが 0
  - `display:none` / `visibility:hidden` / `opacity:0` / `aria-hidden="true"`
  - 祖先が `opacity:0`
  - 祖先が `overflow:hidden` で潰れている / 表示範囲の外
    (カルーセルの画面外スライドなど)

  差分レポートには表示サイズ (例: `1200x0`) を出力するので、
  「画面のどこを見れば確認できるか」が分かる。
  修正後に再度 `npm run discover` を実行すれば、
  このバナーが差分として出るかどうかで実態が確定する。
- **代理店名の表示**: 「募集代理店：<会社名>」という文言が出る。
  `expectedTexts` に設定できる形 (要素のセレクタは未特定)
- **申込導線**: CTA の文言は「今すぐ申込む」(運用側に確認済み)。
  `agency.yml` の `selectors.ctaPrimary: "text=今すぐ申込"` に設定した。
  引き継ぎ方式は未確定 (一部の代理店で `api` 方式の通信が観測されたが、
  観測できない代理店もある)

### 4-5. 修正後の再調査 (2026-08-20 ステージング)

見えていない要素を除外する修正の後、もう一度 `discover` を実行した結果。

| コード | 分類 | コードなしとの差分 |
|---|---|---|
| A0010 | 旧命名規則 (みらやく×) | **差分なし** (募集代理店の表示も無い) |
| littlefamily01 | 自社コード (オリジナル表示) | `#lf-campaign-banner-202609-1`〜`-5` が **1440x292 で表示される** |
| littlefamily03 | カカクコム | 「募集代理店：株式会社カカクコム・インシュアランス」のみ。**リダイレクトなし** |
| littlefamily20 | みらやく○ | 「募集代理店：アントプロダクション株式会社」のみ |
| littlefamily33br30 | みらやく× (支店) | **差分なし** (募集代理店の表示も無い) |

読み取れること。

- **キャンペーンバナーは高さ 0 で潰れていた**のが正しかった。
  修正前に「コードなしのときだけ表示」と報告していたのは
  高さ 0 を表示として数えていたため。
  修正後は、`littlefamily01` でだけ実寸 (292px) で表示されている。
- **みらやく ○ と × の表示差分が観測できていない**。
  `littlefamily20` (○) と `littlefamily33br30` (×) の差は
  募集代理店の表記だけで、セクション・フッター・注釈の違いは出ていない。
  修正前に `littlefamily12` (×) で 24 行のテキストが消えていたのと矛盾するため、
  **代理店によって差分の出方が違う**か、
  **一部のコードが認識されていない**可能性がある。
- `A0010` と `littlefamily33br30` は募集代理店の表記も出ないため、
  **コードとして認識されていない疑い**がある (無効コードと同じ挙動)。

### 表示が安定しない要素は比較しない

遅延読み込みのバナー・スライダー・アニメーションは、
取得した瞬間によって表示状態が変わる。1 回しか取得しないと
その揺れを「代理店による表示の違い」として報告してしまう。

`capturePageSignatureStable()` は 2 回続けて同じ結果になるまで取り直し
(既定 600ms 間隔・最大 3 回)、それでも変わる要素は比較から除外する。
除外したものは差分レポートに
「表示が安定しなかったため比較から除外したもの」として出力する。

### 4-6. 運用側の確認で確定した仕様 (2026-08-20)

| 項目 | 確定内容 | 設定への反映 |
|---|---|---|
| `A0010` (Amazon) | 検査対象外。通常 LP のまま | assign に `exclude: true` |
| 支店コード (末尾 `brNN`) | 親コードと同じ挙動になるのが**仕様**。ただし 2026-08 現在は効いていない (既知の不具合・9/3 修正予定) | 期待結果は仕様どおり。`known-issues.yml` で既知として扱う |
| `littlefamily99` | みらやく ○ | マスタを ○ に修正 |

支店コードは 214 件のうち **151 件**を占める
(`littlefamily02` 1 件 / `03` 50 件 / `18` 30 件 / `33` 50 件 / `57` 20 件)。
マスタの各行が親と同じ みらやく可否を持っているため、
専用の割り当ては不要で、みらやく / カカクコムのルールで分類される。

### 既知の不具合 (2026-09-03 リリースで修正予定)

運用側から共有された不具合一覧。**いずれも支店コードが
親コードとして扱われていない**という同じ原因に見える。

| LIST_ID | 代理店コード | 症状 |
|---|---|---|
| 301〜350 | `littlefamily03br01`〜`br50` | カカクコムなのに専用 LP へリダイレクトされない |
| 3301〜3350 | `littlefamily33br01`〜`br50` | みらやく × なのに安心パックが表示される |
| 5701〜5720 | `littlefamily57br01`〜`br20` | みらやく × なのに安心パックが表示される |

`config/known-issues.yml` に登録して **Low に落として**報告する。
期待結果 (`agencies.yml`) は**仕様どおりのまま**にしておく。

- 現状に合わせて期待結果を書き換えると、修正されたことも
  壊れ直したことも分からなくなる
- `fixedOn: 2026-09-03` を過ぎると既知扱いをやめ、元の重大度で報告する
  → 修正リリース後に直っていなければ、その日から Critical で出る
  → 直っていれば何も出ない

一覧に**入っていない支店コード**もある。

| コード | みらやく | 一覧にない |
|---|---|---|
| `littlefamily02br01` | × | 同じ症状が出る可能性がある (1 件) |
| `littlefamily18br01`〜`br30` | ○ | ○ なので表示されて正しい |

`littlefamily02br01` で「みらやく × なのに表示される」が出た場合は、
**一覧に無い不具合**として Critical で報告される (既知扱いしない)。

## 5. 未実測の項目 (discover で確認する)

以下は実サイトで確認できていない。**設定するまでその項目は検査されない**
(誤検知はしないが、見逃しになる)。

| 項目 | 設定場所 | 現在の値 | 影響 |
|---|---|---|---|
| リダイレクトの実装方式 | `agency-profiles.yml` の `redirectMechanism` | `unknown` | 方式の妥当性は判定せず、実測値を Low として記録する |
| みらやくセクションのセレクタ | `agency-profiles.yml` の `visibleSections` / `hiddenSections` | 空 | **「× なのに表示されている」を検知できない**。`npm run discover` の表示差分から特定する (下記) |
| 代理店名・電話番号などの表示 | `agency-profiles.yml` の `expectedTexts` | 空 | 表示内容の照合を行わない |
| 共通セレクタ | `agency.yml` の `selectors` | 仮の値 | 一致する要素が無い間、それを使う検査は「検出なし」になる |
| 代理店コードの保存先 | `agency.yml` の `storage` | `none` | 保存値の検査を行わない |
| 描画完了の判定 | `agency.yml` の `readyIndicator` | `none` | 待たずに検査する (クライアント描画なら取りこぼす可能性) |
| 申込への引き継ぎ方式 | `agency-profiles.yml` の `application` | `null` | **申込導線の検査を一切行わない** |
| 申込完了 URL (押してはならない操作) | `agency.yml` の `forbiddenRequestPatterns` | 仮の値 | 申込導線の検査を有効にする前に必ず実物に合わせる |

### みらやくの表示差分は 1 箇所ではない

みらやく掲載可否によって変わるのは 1 つのセクションだけではない。
フッターの表記、各所の注釈にも及ぶ。**どこが変わるかを列挙しきれない**ため、
セレクタを config に並べる方式だけでは漏れる。

そこで「どこが変わるか」を知らなくても成立する性質で検査している
(`tests/agency/agency-display-consistency.spec.ts`)。

| 検査 | 期待 | 外れた場合 |
|---|---|---|
| 同じ分類の代理店同士 | 表示が一致する | その代理店だけ扱いが違う (Critical) |
| みらやく ○ と × | 表示が異なる | 切り替えが効いていない (Critical) |

これで「みらやく × の代理店なのに、フッターの表記だけ ○ のままになっている」
のような**列挙していない箇所の不整合**も検知できる。

比較は「DOM にあるか」ではなく**「表示されているか」**で行う
(`display: none` で残す実装が多いため)。
実行ごとに出入りする要素 (ABテストの差し込み枠など) は
`config/agency-profiles.yml` の `displayIgnoreKeys` で除外する。

セレクタを特定して `visibleSections` / `hiddenSections` に書くと、
「何が表示されるべきか」を名前で明示できるので併用が望ましい。
特定手順は次のとおり。

### みらやくセクションの特定手順

どの要素が「みらやく」なのかは分かっていない。
`npm run discover` が**代理店コードによる表示差分**を出すので、そこから特定する。

```powershell
$env:QA_ENV="staging"; npm run discover
```

`reports/discovery/agency-section-diff.md` に、コードなしの通常 LP を基準として
「このコードでは出るブロック / 出ないブロック」が、
**設定にそのまま書ける形のセレクタ**で並ぶ。

```
## littlefamily04 (アドバンスクリエイト株式会社 — みらやく掲載可)

- コードなしでは出ないが、このコードでは出るブロック: 3 件

| セレクタ | 種類 | 表示テキストの先頭 |
|---|---|---|
| `mirayaku-section`  | testid | みらやく のご案内 ... |
| `css=#mirayaku`     | id     | ...                  |
```

みらやく ○ の代理店と × の代理店を見比べて、○ にだけ出るブロックが
みらやくセクション。特定できたら次のように設定する。

```yaml
profiles:
  mirayaku-visible:
    visibleSections: [mirayaku-section]
  mirayaku-hidden:
    hiddenSections: [mirayaku-section]
```

以降は「○ なのに出ていない」「× なのに出ている」を Critical として検知できる。

比較は「DOM にあるか」ではなく**「表示されているか」**で行う
(`display: none` で残す実装が多いため)。
時刻やカウンタのように数字だけが変わるテキストは差分から除外している。

### 実測の手順

```bash
# .env に URL と Basic 認証を設定 (run-qa.cmd の 2 を選ぶと対話で作成できる)
QA_ENV=staging npm run discover
cat reports/discovery/suggested-agencies.yml
```

出力される推奨値を `config/agency-profiles.yml` / `config/agency.yml` に反映し、
`npm run agencies:build` で再生成する。

## 6. いま実行して分かること

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

## 7. 申込導線 (days ドメイン)

申込は LP とは別ドメイン (`days.littlefamily-ssi-stg.com`)、入口は
`/solicitation/step1` であることが分かっている。
申込サイトの URL は `.env` の `STAGING_APPLICATION_BASE_URL` /
`PRODUCTION_APPLICATION_BASE_URL` で環境ごとに切り替える。
CTA は「今すぐ申込む」ボタン。

**代理店コードをどう引き継いでいるかが未確認**のため、
`application` は `null` のまま = 合否判定は行わない。
その代わり `@cta` 検査 (`tests/agency/agency-cta.spec.ts`) が
代理店ごとに次を実測して記録する (クリック・送信はしないので本番でも安全)。

- 申込サイトへ向かうリンク / フォームの件数とパス
- ボタンの表示文言
- リンク URL に `insAgentNo` が乗っているか (乗っていればクエリ方式)

`npm run discover` は `selectors.ctaPrimary` を使って
実際にボタンを押し、遷移先と引き継ぎ通信を記録する。

有効にするには次が必要。

1. 引き継ぎ方式 — URL クエリ / hidden 項目 / POST / 一時トークン / サーバーセッション
2. 申込側で「その代理店として認識されている」ことの確認方法
   (表示される代理店名、hidden 項目、Cookie、API 応答 など)
3. **申込完了 URL** — 本番で絶対に押してはならない操作。
   `config/agency.yml` の `forbiddenRequestPatterns` に設定する

1 と 2 は `npm run discover` で実測できる。
3 は実測に頼らず、実装を確認して設定すること
(誤って申込を完了させると取り消せない)。

## 8. コーポレートサイト

`www.littlefamily-ssi.com` は LP とは別ホストのため、`config/pages.yml` には
入れられない (`baseUrl` 配下ではない)。検査する場合は
`config/environments.yml` に別環境として追加する。
代理店コードのロジックはないため、`pagesFile` を分けて表示・リンク・
文言の検査だけを行う構成になる。
