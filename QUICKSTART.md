# クイックスタート

最短で動かすための手順。詳細は [README.md](README.md)。

## 0. 押すだけで実行する（Windows）

`run-qa.cmd` を**ダブルクリック**すると、検査対象を番号で選んで実行し、
終わったらレポートが開きます。PowerShell にコマンドを打つ必要はありません。

```
  1 : 練習用サイト   （対象サイト不要。動作確認用）
  2 : ステージング   （.env の STAGING_BASE_URL）
  3 : 本番           （読み取りのみ。申込完了は行いません）
```

必要なのは Node.js だけです（https://nodejs.org/ja）。
初回は部品のダウンロードで 5〜10 分かかります。

macOS / Linux では `npm run qa` が同じ入口です。

**使うタイミング:** ABテストを開始したとき、セクションを追加したとき、
JS やタグを入れ替えたとき — 変更のあとに押して確認します。定期実行はしません。

## 1. コマンドで動かす（対象サイト不要）

```bash
npm install
npm run prepare:browsers
npm run test:local
```

同梱のモックサイト（LP ドメイン + 申込ドメイン）が自動起動し、246項目が実行されます。
実サイトの URL は不要です。**まずこれで「何が出るか」を確認してください。**

終わったら `reports/qa-report.html` をブラウザで開きます。

- Windows: `start reports\qa-report.html`
- macOS: `open reports/qa-report.html`

`npm test` は見た目のスクリーンショット比較（`@visual`）も含みます。基準画像は
Linux (CI) で作成しているため、Windows / macOS では**不具合でなくても差分が出ます**。
手元では `npm run test:local` を使ってください。

### Node.js だけで動かす（Git を入れない場合）

Git を入れずに済ませたい場合は、ZIP を取得して展開します（Windows PowerShell）:

```powershell
cd "$env:USERPROFILE"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/yusukeozawa-crypto/claudecode/archive/refs/heads/main.zip" -OutFile repo.zip
Expand-Archive -Path repo.zip -DestinationPath . -Force
cd claudecode-main
```

`C:\Windows\System32` では書き込みできないため、必ずユーザーフォルダで実行してください
（PowerShell を「管理者として実行」で開くと System32 から始まります）。

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
```

設定に不備があれば**実行前にエラーで止まり、どこが問題か表示されます**。

## 3. 結果の見方

見るのは `reports/qa-report.html` です。**問題があった項目だけ**が重大度順に並びます
（通った項目は「テスト実行一覧」に折りたたまれています）。
画面上部に「異常は検知されませんでした / 要対応 N 件」と出るので、そこだけ見れば足ります。

| 重大度 | 意味 | 対応 |
|---|---|---|
| **Critical** | 代理店の誤表示・コード欠落・申込への誤引き継ぎ | 即対応（CI も失敗） |
| **High** | 申込導線停止・主要リンク切れ・JSエラー | 即対応（CI も失敗） |
| Medium | 表示崩れ・画像欠損 | 計画的に対応 |
| Low | 誤字脱字・軽微な画像差分 | 余裕があれば |

レポートの「再現URL」をブラウザで開くと同じ状態を再現できます。

## 4. よく使うコマンド

```bash
npm run qa                  # 対話式（対象を選んで実行しレポートを開く）
npm run test:local          # 全項目（視覚差分以外・手元での既定）
npm test                    # 視覚差分も含む全テスト（CI/Linux 向け）
npm run test:staging        # ステージング対象
npm run test:production     # 本番対象（読み取り専用・申込完了しない）
npm run test:agency         # 代理店テストのみ
npm run discover            # 実仕様の調査
npm run report              # Playwright の詳細レポート（原因追跡用）
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
