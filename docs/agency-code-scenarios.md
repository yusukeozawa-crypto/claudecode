# 代理店コード シナリオ仕様

対象実装: `tests/agency/agency-code.spec.ts` / `utils/agency.ts`
設定ファイル: `config/agency.yml`

## 前提となる仕様 (すべて設定で変更可能)

| 項目 | 設定キー | 既定値 (仮置き) |
|---|---|---|
| URL パラメータ名 | `paramName` | `agency_code` |
| 保存先 | `storage.type` | `both` (Cookie と localStorage) |
| 保存キー | `storage.key` | `agency_code` |
| 有効コード | `codes[].valid: true` | `A001`, `B002` |
| 無効コード | `codes[].valid: false` | `INVALID` |

### 判定に使う要素 (data-testid)

| 用途 | 設定キー | 既定値 |
|---|---|---|
| 既定セクション | `selectors.defaultSection` | `default-section` |
| 代理店セクション | `selectors.agencySection` | `agency-section` |
| 代理店名 | `selectors.agencyName` | `agency-name` |
| 代理店の連絡先 | `selectors.agencyContact` | `agency-contact` |
| 申込ボタン | `selectors.applicationButton` | `application-button` |
| フォールバック表示 | `selectors.fallbackNotice` | `fallback-notice` |

### 条件ごとの期待表示 (`expectations`)

| 状態 | 表示されるべき | 非表示であるべき | 期待文言 |
|---|---|---|---|
| `none` (コードなし) | `defaultSection` | `agencySection` | — |
| `valid` (有効コード) | `agencySection`, `agencyName`, `agencyContact` | `defaultSection` | コードごとの `expectedName` / `expectedContact` |
| `invalid` (無効コード) | `defaultSection`, `fallbackNotice` | `agencySection` | `fallbackNotice` に「代理店情報を確認できませんでした」 |

---

## シナリオ一覧

### シナリオ1: 代理店コードなし

対象: `agencyAware: true` の全ページ

| 確認項目 | 期待結果 |
|---|---|
| 表示 | 既定セクションが表示され、代理店セクションは非表示 |
| 保存値 | Cookie / localStorage に代理店コードが保存されていない |
| エラー | JavaScript エラー・4xx/5xx が発生しない |

検知時の重大度: **Critical** (`agency-display` / `agency-persistence`)

### シナリオ2: 有効な代理店コードあり

対象: `agencyAware: true` の全ページ × 有効コード全件

| 確認項目 | 期待結果 |
|---|---|
| 表示 | 代理店セクションが表示され、既定セクションは非表示 |
| 表示内容 | 代理店名が `expectedName`、連絡先が `expectedContact` と一致 |
| 保存値 | 保存先に当該コードが保存されている |
| 保存の整合性 | `storage.type: both` の場合、Cookie と localStorage の値が一致 |
| 証跡 | フルページスクリーンショットを保存 |

代理店名が別の代理店のものになっていた場合は「代理店の誤表示」として **Critical**。

### シナリオ3: 無効な代理店コードあり

対象: `agencyAware: true` の全ページ × 無効コード全件

| 確認項目 | 期待結果 |
|---|---|
| 表示 | 既定セクション + フォールバック表示が表示され、代理店セクションは非表示 |
| 期待文言 | フォールバック表示に指定文言が含まれる |
| 保存値 | 無効コードは保存されない |
| 証跡 | フルページスクリーンショットを保存 |

### シナリオ4: 有効コードで流入後、別ページへ遷移

対象: `persistenceFlow` に列挙したページ (既定: `top` → `product` → `price`)

2 通りの遷移方法をどちらも検証する。

| 遷移方法 | 確認項目 |
|---|---|
| (a) サイト内リンクをクリック | 遷移後も保存値が維持され、代理店表示が継続する |
| (b) URL パラメータなしで直接遷移 | 保存値から代理店表示が復元される |

(b) は「Cookie / localStorage による保持が実際に機能しているか」を検証するため、
URL パラメータに依存しない形で確認する。

検知時の重大度: **Critical** (`agency-persistence`)

### シナリオ5: 有効コードで流入後、申込画面へ遷移

流入ページから申込ボタンをクリックして申込画面へ遷移し、4 点を確認する。

| # | 確認項目 | 設定キー | 期待結果 |
|---|---|---|---|
| 1 | 申込 URL への引き継ぎ | `application.expectParamInUrl` | 申込 URL に `agency_code=<コード>` が付与される |
| 2 | hidden 項目への引き継ぎ | `application.hiddenField` | hidden 項目の値が当該コード、`name` 属性が期待どおり |
| 3 | 保存値の保持 | `storage` | 申込画面でも保存値が維持されている |
| 4 | 申込 API への引き継ぎ | `application.requests[]` | リクエストの指定フィールドに当該コードが含まれる |

**申込完了は行わない。** #4 の検査では `page.route()` でリクエストを捕捉し、
内容を検査した上でモックレスポンスを返す (サーバーには到達しない)。
`skipWhenReadOnly: true` かつ読み取り専用環境の場合は検査自体をスキップし、
スキップした事実を Low として記録する。

検知時の重大度: **Critical** (`agency-handoff`)

### シナリオ6: 別の代理店コードで再流入

| 確認項目 | 期待結果 |
|---|---|
| 表示内容 | 後から流入したコードの代理店名・連絡先に切り替わる |
| 保存値 | 後から流入したコードで上書きされている |
| 残存確認 | 前の代理店名が画面に残っていない |

有効コードが 1 件しか設定されていない場合はスキップされる。

### シナリオ7: Cookie または localStorage を削除して再訪問

| 確認項目 | 期待結果 |
|---|---|
| 保存値 | 削除後の再訪問で保存値が存在しない |
| 表示 | 既定表示 (コードなしの状態) に戻る |

削除は `clearStoredCode()` が Cookie と localStorage / sessionStorage の両方を対象に行う。

### 設定の妥当性チェック (`@config`)

- 設定された各コードの有効・無効判定が `codes[].valid` と一致しているか
- 有効コードに `expectedName` が設定されているか
  (未設定の場合は代理店名の表示内容を検証できないため Medium で報告)

---

## 保存値の検証ロジック

`storage.type` に応じて「保持されているコード」を決定する。

| `storage.type` | 判定対象 |
|---|---|
| `cookie` | Cookie の値 |
| `localStorage` | localStorage の値 |
| `both` | Cookie を優先し、無ければ localStorage。さらに両者の不一致も検出する (High) |

Cookie / localStorage の値はログに出力しない。期待値との比較結果のみをレポートに記録する。

---

## 実サイトへの適用手順

1. サイト側の該当要素に `data-testid` を付与する (推奨)
2. `config/agency.yml` の `selectors` を実際の値に合わせる
3. `paramName` / `storage` を実装に合わせる
4. `codes` にテスト用コードと期待表示 (代理店名・連絡先) を設定する
5. `expectations` を実際の表示仕様に合わせる
6. `application` の引き継ぎ方式 (URL / hidden / API) を実装に合わせる
7. `persistenceFlow` に遷移確認したいページ id を並べる
8. `npm run test:agency` で確認する

`data-testid` を付与できない場合は `css=` 接頭辞で任意セレクタを指定できるが、
CSS クラス名の変更で壊れやすくなるため推奨しない。
