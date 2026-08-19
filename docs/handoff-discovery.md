# 実サイトの仕様調査ツール (npm run discover)

## 目的

代理店情報の引き継ぎ方法は実装によって異なり、**推測すると誤ったテストになる**。
このツールは実サイトの通信を記録し、次を「実測値」として明らかにする。

- リダイレクトの有無・経路・遷移方式
- CTA から申込ドメインへ何がどう送られているか
- 申込ページ側が代理店をどう保持・認識しているか

出力をもとに `config/agencies.yml` を書く。

## 実行

```bash
# ステージングに対して実行 (.env に URL を設定しておく)
QA_ENV=staging npm run discover

# ローカルモックで動作確認
npm run discover
```

- 実行するのは **読み取りと画面遷移のみ**。フォーム送信・申込完了は行わない
- 申込完了リクエストはフィクスチャが遮断する
- 通常の `npm test` では起動しない (`QA_DISCOVER` 環境変数が必要)
- PC 構成のみで 1 回実行される

## 出力

| ファイル | 内容 |
|---|---|
| `reports/discovery/<code>.json` | 代理店ごとの観測結果 (詳細) |
| `reports/discovery/suggested-agencies.yml` | `config/agencies.yml` への推奨値 |

標準出力にも要約が表示される。

```
[A002]
  流入 URL   : https://www.example.jp/lp/?agency_code=A002
  最終 URL   : https://www.example.jp/partner/a002/?agency_code=A002
  遷移方式   : HTTP リダイレクト (301/302/303/307/308) (HTTP 3xx: 1, meta refresh: 0, SPA: 0)
  引き継ぎ   : token
  申込ページ : https://application.example-insurance.jp/entry/?handoff_token=***MASKED***
    hidden項目: agency_code
    localStorage: agency_code
    Cookie    : app_session
```

## 記録される内容

| 項目 | 用途 |
|---|---|
| 流入 URL / 最終 URL | `entryPath` / `expectedFinalPath` |
| HTTP 経路 (ステータス・`location`) | `redirected` / `expectedRedirectCount` / `expectedRedirectPaths` |
| 遷移方式の判定 | `redirectMechanism` |
| CTA 候補 (別ドメインを指すリンク・フォーム・申込らしいボタン) | `cta.testId` / `cta.expectedText` |
| 申込ドメイン宛リクエスト (メソッド・**キー名のみ**) | `application.handoffMethod` / `handoffParam` |
| 申込ページの hidden 項目名 | `recognition` (type: hidden) |
| 申込ページの localStorage キー・Cookie 名 | `recognition` (type: storage) |
| 申込ページの `data-testid` 一覧 | `recognition` (type: text) |
| 申込側 API の応答キー | `recognition` (type: api) |

### 値は記録しない

引き継ぎ通信は **キー名のみ** を記録し、値は出力しない。
トークン・セッション ID は `utils/secrets.ts` によりマスキングされる
(`config/agencies.yml` の `security.maskParamNames` / `maskValuePatterns`)。

## 注意メッセージ

| メッセージ | 意味と対応 |
|---|---|
| 設定された CTA が見つかりません | `ctaCandidates` を見て `cta.testId` を修正する。`data-testid` が無い場合はサイト側への付与を依頼する |
| CTA をクリックしても URL が変化しませんでした | 別タブ (`target="_blank"`) や JavaScript 遷移の可能性。実装を確認する |
| 別ドメインへの引き継ぎ通信を観測できませんでした | 同一ドメイン構成、または CTA が別方式 (POST・API) の可能性 |
| 複数の引き継ぎ方式を観測しました | クエリとトークンの併用など。どれが正なのか実装担当に確認する |

## 反映手順

1. `reports/discovery/suggested-agencies.yml` を開く
2. 内容を **実装担当と確認** する (自動生成値をそのまま使わない)
3. `config/agencies.yml` の該当代理店へ反映する
4. `recognition` を 1 つ以上設定する (URL だけで合格にしないため必須)
5. `QA_ENV=staging npm run test:agency` で確認する

## data-testid が無い場合

調査結果の `testIds` が空、または CTA に `data-testid` が無い場合は、
まずサイト側へ付与を依頼するのが最も安定する。
暫定対応として設定値に `css=` 接頭辞を使えるが、CSS 変更で壊れやすい。

```yaml
cta:
  testId: "css=.p-cta__button"     # 暫定 (推奨しない)
```
