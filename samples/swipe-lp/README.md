# 縦スワイプ型 LP サンプル

`lp.littlefamily-ssi.com/lp/service/` を **縦スワイプ（1画面＝1メッセージ）形式**に置き換える
ための試作。依存ライブラリなし・単一ファイル（`index.html`）で動く。

## 動かす

```bash
cd samples/swipe-lp
python3 -m http.server 8080
# → http://localhost:8080/
# → http://localhost:8080/?insAgentNo=demo-agency-ok  （代理店名あり）
# → http://localhost:8080/?insAgentNo=demo-agency-ng  （安心パック非表示）
# → http://localhost:8080/?insAgentNo=littlefamily01  （自社コード＝代理店名なし）
```

スマートフォン想定。PC では `↓ / ↑ / PageDown / PageUp / Home / End` でも移動できる。

## 構成（12セクション）

| # | セクション | 役割 |
|---|---|---|
| 1 | ヒーロー | 商品名・最安保険料・スワイプ誘導 |
| 2 | 課題提起 | ペットの治療費は全額自己負担 |
| 3-5 | 特長 1〜3 | 保険料 / 補償範囲 / WEB完結 を1画面1メッセージに分割 |
| 6 | プラン比較 | 通常プラン vs Light の表 |
| 7 | 保険料例 | 犬・猫 × 年齢の例 |
| 8 | オプション | 安心パック / みらいの約束（**代理店により非表示**） |
| 9 | お客様の声 | 社会的証明 |
| 10 | 申込みの流れ | 3ステップ |
| 11 | FAQ | `<details>` のアコーディオン |
| 12 | 最終CTA | 申込ボタン＋募集代理店表記＋注記 |

## 縦スワイプの実装方針

- **CSS Scroll Snap**（`scroll-snap-type: y mandatory` + `scroll-snap-stop: always`）。
  JavaScript でスクロールを乗っ取らないので、慣性・アドレスバーの挙動が OS 標準のまま。
- 高さは `100dvh`。非対応ブラウザ向けに `window.innerHeight` のフォールバックあり。
- 長いセクション（プラン表・FAQ）は `.sec__scroll` で**内側だけスクロール**させ、
  スナップが壊れないようにしている。
- `IntersectionObserver` で現在位置を検出し、進捗バー・右のドット・固定CTAの表示、
  入場アニメーションを制御。`prefers-reduced-motion` を尊重。
- 固定CTAはヒーローと最終セクションでは隠す（それぞれに別のCTAがあるため）。

## 代理店コード（`insAgentNo`）の扱い

既存 LP の仕様（`docs/site-littlefamily.md` / `config/agency.yml`）に合わせてある。

1. **ヘッダーに代理店名／フッターに「募集代理店：<会社名>」** を表示
2. 自社コード `littlefamily01` は代理店名を表示しない
3. みらやく掲載不可の代理店では**「安心パック」セクションごと削除**する
   （保険料の前提条件としての「安心パックなし」という注記だけは残す — 訴求ではないため）
4. 申込みリンク（`.js-cta`）に `insAgentNo` を引き継ぐ

サンプルでは代理店マスタを `index.html` 内の `AGENTS` にべた書きしている。
本実装ではサーバー側で出し分けるか、既存 LP と同じ仕組みに合わせること。

## 差し替えが必要なところ

- **文言・保険料・補償内容はすべてデモ用の参考値**。実LPの原稿に差し替える。
- 絵文字（🐶🐱🐾）はプレースホルダ。実際の写真・イラストに差し替える。
- 申込先 URL は `https://days.littlefamily-ssi.com/solicitation/step1` を仮置き。
- 計測タグ（GA4 / Zoho PageSense 等）は未設置。
  スワイプ型では「どのセクションまで到達したか」が主要指標になるので、
  `setActive()` でセクション到達イベントを送ると効果測定しやすい。

## 既知の制約

- スナップ式のため、セクション内の文章量が増えると縦に収まらない。
  1画面1メッセージを守り、収まらない場合はセクションを分割する。
- iOS Safari のアドレスバー伸縮時にスナップ位置がわずかにずれることがある。
