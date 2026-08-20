# クイックスタート

最短で動かすための手順。詳細は [README.md](README.md)。

## 1. 5分で動かす（対象サイト不要）

```bash
npm install
npm run prepare:browsers
npm test
npm run report          # ブラウザでレポートが開く
```

同梱のモックサイトが自動起動し、255テストが実行されます。
実サイトの URL は不要です。**まずこれで「何が出るか」を確認してください。**

## 2. 自社サイトに向ける（15分）

### ① URL を設定

```bash
cp .env.example .env
```

`.env` を編集（LP と申込ページの両方が必要）:

```
STAGING_BASE_URL=https://staging.example.jp
STAGING_APPLICATION_BASE_URL=https://staging-application.example-insurance.jp
```

### ② 実仕様を実測する

```bash
QA_ENV=staging npm run discover
```

代理店ごとのリダイレクト方式・引き継ぎ方式・CTA・hidden 項目名が実測されます。
**推測で設定を書かないための工程です。**

出力を確認:

```bash
cat reports/discovery/suggested-agencies.yml
```

### ③ 設定に反映

`config/agencies.yml` を実仕様に合わせます。最低限これだけ:

```yaml
agencies:
  - code: A001                        # 実際の代理店コード
    entryPath: /lp/                   # 流入する LP
    expectedFinalPath: /lp/           # 最終的に表示される URL
    redirected: false                 # リダイレクトするか
    redirectMechanism: none           # none | http | js | meta-refresh | spa
    expectedRedirectCount: 0
    expectedRedirectPaths: []
    visibleSections: [agency-contact] # 表示されるべき要素 (data-testid)
    hiddenSections: [default-contact] # 非表示であるべき要素
    expectedTexts:
      agency-name: 株式会社○○        # 表示されるべき代理店名
      agency-phone: 03-0000-0000
    expectedAssets: {}
    cta:
      testId: cta-primary
    application:
      expectedDomain: null            # null なら .env の申込ドメイン
      expectedPath: /entry/
      handoffMethod: query            # discover の結果に合わせる
      handoffParam: agency_code
      expectedCode: A001
      recognition:                    # 1つ以上必須
        - type: text
          testId: application-agency-name
          expected: 株式会社○○
      steps: []
```

`readyIndicator`（`config/agency.yml`）も合わせます:

```yaml
readyIndicator:
  type: selector
  selector: agency-contact    # 代理店セクションの data-testid
```

### ④ 実行

```bash
QA_ENV=staging npm run test:local        # 視覚差分以外をすべて
QA_ENV=staging npm run test:agency       # 代理店テストのみ
npm run report
```

設定に不備があれば**実行前にエラーで止まり、どこが問題か表示されます**。

## 3. 結果の見方

| 重大度 | 意味 | 対応 |
|---|---|---|
| **Critical** | 代理店の誤表示・コード欠落・申込への誤引き継ぎ | 即対応（CI も失敗） |
| **High** | 申込導線停止・主要リンク切れ・JSエラー | 即対応（CI も失敗） |
| Medium | 表示崩れ・画像欠損 | 計画的に対応 |
| Low | 誤字脱字・軽微な画像差分 | 余裕があれば |

レポートの「再現URL」をブラウザで開くと同じ状態を再現できます。

## 4. よく使うコマンド

```bash
npm test                    # 全テスト（モックサイト）
npm run test:local          # 視覚差分以外（ローカル向け・OS差のノイズなし）
npm run test:staging        # ステージング対象
npm run test:production     # 本番対象（読み取り専用・申込完了しない）
npm run test:agency         # 代理店テストのみ
npm run discover            # 実仕様の調査
npm run report              # レポートを開く
npm run clean               # レポートを削除（基準画像は残る）
```

## 5. 代理店を追加する

`config/agencies.yml` に1件追記するだけで、その代理店のテスト
（表示・リダイレクト・申込引き継ぎ・PC/SP・他代理店との組み合わせ）が
**自動で追加されます**。テストコードは触りません。

## つまずいたら

| 症状 | 対処 |
|---|---|
| `baseUrl が空です` | `.env` の URL 未設定 |
| 代理店テストが遅い | `readyIndicator` が実サイトに合っていない |
| 画像差分（Low）だけ出る | OS のフォント差。`npm run test:local` を使う |
| 設定エラーで止まる | メッセージに問題箇所が出ている |

詳細: [docs/operations.md](docs/operations.md)（トラブルシューティング）
