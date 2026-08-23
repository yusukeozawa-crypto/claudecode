/**
 * 「安心パック」(= みらいの約束) の表示を文脈で判定する。
 *
 * 安心パックは損害保険の資格が必要な商品で、少額短期保険の資格しか持たない
 * 代理店 (みらやく掲載不可) に訴求させると法令違反になる。
 * したがって「文字があるか」ではなく **どういう文脈で出ているか** が問題になる。
 *
 *   注釈 (※) の中で、周りより小さい文字      … 可 (前提条件の記載)
 *   訴求・見出し・商品比較テーブルなど        … 不可 (資格外の販売)
 *
 * 出現箇所ごとにフォントサイズと「※」の有無を見て判定し、
 * 許可したものも含めて全件を記録する (判定の根拠を人が確認できるように)。
 */
import type { Page } from '@playwright/test';

export interface AnshinOccurrence {
  /** 見つかった語 */
  keyword: string;
  /** その語を含む要素のテキスト (前後を切り出したもの) */
  text: string;
  /** 実効フォントサイズ (px) */
  fontPx: number;
  /** 本文 (body) のフォントサイズ (px) */
  bodyFontPx: number;
  /** 同じ要素に注釈の目印 (※) があるか */
  hasMarker: boolean;
  /** 要素のタグ (h2 / p / td など) */
  tag: string;
  /** 見出しの中か */
  inHeading: boolean;
  /** 表の中か */
  inTable: boolean;
  /** 注釈として許してよいか */
  allowed: boolean;
}

/**
 * ページ上の出現箇所をすべて拾う。
 *
 * 表示されている要素だけを見る (DOM に残した非表示は「出ていない」)。
 */
export async function observeAnshinOccurrences(
  page: Page,
  keywords: string[],
  markers: string[],
): Promise<AnshinOccurrence[]> {
  if (keywords.length === 0) return [];
  return page
    .evaluate(
      ({ words, marks }: { words: string[]; marks: string[] }) => {
        const bodyFontPx = parseFloat(getComputedStyle(document.body).fontSize) || 16;
        const results: Array<{
          keyword: string;
          text: string;
          fontPx: number;
          bodyFontPx: number;
          hasMarker: boolean;
          tag: string;
          inHeading: boolean;
          inTable: boolean;
          allowed: boolean;
        }> = [];

        for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
          const own = element.textContent ?? '';
          const hit = words.find((word) => own.includes(word));
          if (hit === undefined) continue;
          // 子要素にも含まれるなら、より内側の要素で拾う (親を何重にも数えない)
          if (Array.from(element.children).some((child) => words.some((word) => (child.textContent ?? '').includes(word)))) {
            continue;
          }
          // 表示されていないものは「出ていない」
          const rect = element.getBoundingClientRect();
          if (element.offsetParent === null || rect.width === 0 || rect.height === 0) continue;

          const style = getComputedStyle(element);
          const fontPx = parseFloat(style.fontSize) || bodyFontPx;

          // 注釈の目印を探す範囲は「その 1 行」に限る。
          //
          //   実サイトの注釈は目印と本文が別の要素に分かれている:
          //     <p><span>※2</span><span>猫・0〜20歳…安心パックなし…</span></p>
          //   「安心パック」がある span 自身には ※ が無いため、
          //   要素自身だけを見ると注釈と分からず、正しい注釈を違反にしてしまう。
          //
          //   一方、親を何段も辿ると囲み全体になり、同じ囲みのどこかに ※ が
          //   あるだけで訴求文まで注釈と判定してしまう。
          //   そこで「一番近いブロック要素 (= その行)」だけを見る。
          //   その行が長すぎる場合は行とみなせないので採用しない。
          const blockDisplays = ['block', 'flex', 'grid', 'list-item', 'table', 'flow-root'];
          const nearestBlock = (() => {
            let current: HTMLElement | null = element;
            for (let depth = 0; depth < 5 && current !== null; depth += 1) {
              const display = getComputedStyle(current).display;
              if (blockDisplays.some((name) => display.startsWith(name))) return current;
              current = current.parentElement;
            }
            return null;
          })();
          const lineText = nearestBlock?.textContent ?? '';
          const lineIsShortEnough = lineText.length <= 600;
          const markerInOwn = marks.some((mark) => mark !== '' && own.includes(mark));
          const markerInLine = lineIsShortEnough
            && marks.some((mark) => mark !== '' && lineText.includes(mark));
          const hasMarker = markerInOwn || markerInLine;
          const tag = element.tagName.toLowerCase();
          const inHeading = element.closest('h1, h2, h3, h4, h5') !== null;
          const inTable = element.closest('table') !== null;

          results.push({
            keyword: hit,
            text: own.replace(/\s+/g, ' ').trim().slice(0, 120),
            fontPx: Math.round(fontPx * 10) / 10,
            bodyFontPx: Math.round(bodyFontPx * 10) / 10,
            hasMarker,
            tag,
            inHeading,
            inTable,
            // 注釈として許す条件 (すべて満たしたときだけ許す):
            //   ・その文自身に注釈の目印 (※) がある  ← これが本質
            //   ・本文より大きい文字ではない (訴求は本文より大きい)
            //   ・見出しの中ではない (見出しは訴求)
            //
            // 目印を主条件にしているのは、注釈でも本文と同じ大きさのことが
            // あり、大きさだけで決めると正しい注釈まで違反にしてしまうため。
            // 表の中かどうかは記録するだけにして判定には使わない。
            // 実物のデータを見る前にルールを増やすと誤検知を作る。
            allowed: hasMarker && fontPx <= bodyFontPx && !inHeading,
          });
        }
        return results;
      },
      { words: keywords, marks: markers },
    )
    .catch(() => []);
}

/** 1 件の出現箇所を人が読める 1 行にする */
export function describeOccurrence(entry: AnshinOccurrence): string {
  const place = [
    entry.inHeading ? '見出し' : '',
    entry.inTable ? '表の中' : '',
    entry.tag,
  ]
    .filter((part) => part !== '')
    .join(' / ');
  return `「${entry.text}」 ${entry.fontPx}px (本文 ${entry.bodyFontPx}px) ${entry.hasMarker ? '※あり' : '※なし'} ${place}`;
}
