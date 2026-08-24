/**
 * 「安心パック」(= みらいの約束) の表示を文脈で判定する。
 *
 * 安心パックは損害保険の資格が必要な商品で、少額短期保険の資格しか持たない
 * 代理店 (みらやく掲載不可) に訴求させると法令違反になる。
 * したがって「文字があるか」ではなく **どういう文脈で出ているか** が問題になる。
 *
 *   本文より小さい文字 (注釈・免責文)        … 可 (前提条件の記載)
 *   「安心パックなし」など否定表現            … 可 (訴求の正反対)
 *   訴求・見出し・商品仕様の項目              … 不可 (資格外の販売)
 *
 * 判定が構造から決められない文言 (div で組まれた商品仕様のテーブルなど) は、
 * 実物を見て決めた文言を設定で名指しする (禁止 / 許可の両方)。
 * これは文字の大きさを見ないため、PC とスマートフォンで判定がぶれない。
 *
 * 出現箇所ごとに判定し、許可したものも含めて全件を記録する
 * (判定の根拠を人が確認できるように)。
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
  /** 同じ行に注釈の目印 (※) があるか */
  hasMarker: boolean;
  /** 否定表現 (安心パックなし = 付かない場合) か。訴求ではない */
  negated: boolean;
  /** 名指しで禁止された文言か (商品仕様のテーブルなど、構造で判定できない場所) */
  explicitlyForbidden: boolean;
  /** 名指しで許可された文言か (掲載不可でも出てよいと運用側が決めたもの) */
  explicitlyAllowed: boolean;
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
  negations: string[] = [],
  /**
   * 文字の大きさに関係なく違反とする文言。
   *   商品仕様・商品比較のテーブルのように、構造では判定できない場所に
   *   ある訴求を、運用側の判断で名指しで禁止するために使う。
   */
  alwaysForbidden: string[] = [],
  /**
   * 文字の大きさに関係なく許可する文言。
   *   「安心パックなしの場合」のように、掲載不可の代理店でも出てよいと
   *   運用側が決めたものを名指しで登録する。
   *   端末で文字サイズが変わっても判定がぶれない。
   */
  alwaysAllowed: string[] = [],
): Promise<AnshinOccurrence[]> {
  if (keywords.length === 0) return [];
  return page
    .evaluate(
      ({ words, marks, nots, forbidden, permitted }: {
        words: string[]; marks: string[]; nots: string[]; forbidden: string[]; permitted: string[];
      }) => {
        const bodyFontPx = parseFloat(getComputedStyle(document.body).fontSize) || 16;
        const results: Array<{
          keyword: string;
          text: string;
          fontPx: number;
          bodyFontPx: number;
          hasMarker: boolean;
          negated: boolean;
          explicitlyForbidden: boolean;
          explicitlyAllowed: boolean;
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

          // 以降の照合は空白を 1 つにそろえた文字列で行う。
          //   実サイトの文は要素をまたいで改行やインデントが入るため
          //   (<span>※5</span><span>「安心パック」は…</span>)、
          //   そのまま比べると登録した文言と一致しない。
          const flat = own.replace(/\s+/g, ' ').trim();
          const trim = (phrase: string) => phrase.replace(/\s+/g, ' ').trim();

          /**
           * 語の出現ごとに「訴求ではない」と言える理由があるかを見る。
           *
           *   否定表現      … 「安心パックなし」= 付かない場合。訴求の正反対。
           *                    保険料の前提条件として注釈に出るもので、
           *                    資格の問題にはあたらない。
           *   登録した文言  … 運用側が「掲載不可でも出てよい」と決めたもの。
           *
           *   語が複数回出る場合は、**理由の無い出現が 1 つでもあれば**
           *   訴求とみなす (安全側)。「安心パックで安心！ 安心パックなしの
           *   場合は…」のような文を、後半だけを見て許さないため。
           */
          const notWords = nots.filter((not) => not !== '');
          const okPhrases = permitted.map(trim).filter((phrase) => phrase !== '');
          const spots: Array<{ index: number; word: string }> = [];
          for (const word of words) {
            let from = 0;
            for (;;) {
              const index = flat.indexOf(word, from);
              if (index < 0) break;
              spots.push({ index, word });
              from = index + word.length;
            }
          }
          let everyNegated = notWords.length > 0 && spots.length > 0;
          let everyKnown = spots.length > 0;
          let matchedOkPhrase = false;
          for (const spot of spots) {
            const after = flat.slice(spot.index + spot.word.length).replace(/^[」』"'）)\s]+/, '');
            const isNegated = notWords.some((not) => after.startsWith(not));
            const isPermitted = okPhrases.some((phrase) => flat.startsWith(phrase, spot.index));
            if (isPermitted) matchedOkPhrase = true;
            if (!isNegated) everyNegated = false;
            if (!isNegated && !isPermitted) everyKnown = false;
          }
          const negated = everyNegated;
          const explicitlyAllowed = matchedOkPhrase && everyKnown;

          /**
           * 名指しで禁止された文言か。
           *
           *   商品仕様のテーブルのように、HTML の <table> ではなく div で
           *   組まれている場所は構造から判定できない。
           *   実物を見て「掲載不可では出てはいけない」と判断したものは、
           *   文字の大きさに関係なく違反とする。
           *   端末で文字サイズが変わっても判定がぶれない。
           *
           *   文の途中に出てきても違反とする (含まれていたら違反)。
           *   注釈の目印が先に付いていたり (「※5 「安心パック」は…」)、
           *   前後に別の文が続いたりするため、先頭一致では取りこぼす。
           */
          const explicitlyForbidden = forbidden.some((phrase) => {
            const needle = trim(phrase);
            return needle !== '' && flat.includes(needle);
          });

          const markerInOwn = marks.some((mark) => mark !== '' && own.includes(mark));

          // 目印は「この要素のすぐ前」にあるものだけを認める。
          //
          //   実サイトの注釈は目印と本文が別の要素に分かれている:
          //     <p><span>※5</span><span>「安心パック」は…</span></p>
          //   そのため要素自身だけを見ると注釈と分からない。
          //
          //   一方、行 (囲み) のどこにあってもよいことにすると、
          //   一番近いブロックが大きな囲みだった場合に、離れた別の行の ※ が
          //   漏れ込んで訴求文まで注釈と判定してしまう (モックで実際に起きた)。
          //
          //   そこで、直前の兄弟要素の末尾だけを見る。
          //   注釈は「※5」のすぐ後ろに本文が来るため、これで足りる。
          const beforeText = (() => {
            let text = '';
            let node: Node | null = element.previousSibling;
            while (node !== null && text.length < 80) {
              // HTML コメントは画面に出ないので数えない。
              //   コメントの中に ※ が書かれていると、訴求文まで
              //   注釈と判定してしまう (モックで実際に起きた)。
              if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
                text = `${node.textContent ?? ''}${text}`;
              }
              node = node.previousSibling;
            }
            // 自分のテキストのうち、語より前の部分も見る
            const first = words
              .map((word) => own.indexOf(word))
              .filter((index) => index >= 0)
              .sort((a, b) => a - b)[0];
            const ownPrefix = first === undefined ? '' : own.slice(0, first);
            return `${text}${ownPrefix}`.slice(-40);
          })();
          const markerBeforeKeyword = marks.some((mark) => mark !== '' && beforeText.includes(mark));
          const hasMarker = markerInOwn || markerBeforeKeyword;
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
            negated,
            explicitlyForbidden,
            explicitlyAllowed,
            // 注釈として許す条件:
            //   ・否定表現 (安心パックなし = 付かない場合) … 訴求の正反対なので常に可
            //   または
            //   ・本文より小さい文字で、見出しの中でない … 注釈・免責文
            //
            // ※ の有無は判定に使わない (記録には残す)。
            //   ※ の位置はサイトの作りに左右されて不安定で、
            //   実際に 3 通りの取り違えを起こした:
            //     ・目印と本文が別要素に分かれている (注釈を違反と誤判定)
            //     ・見出しの末尾に ※ があり、次の段落に漏れ込む (訴求を許可)
            //     ・HTML コメントの中の ※ を数える (訴求を許可)
            //   さらに ※ が近くにあるだけで通るため、同じ要素が
            //   端末によって違反 / 許可に分かれていた。
            //   文字の大きさは客観的で、訴求は必ず本文以上の大きさになる。
            //   名指しで禁止された文言は、他の条件より先に違反とする。
            //   名指しで許可した文言は、文字の大きさに関係なく許す
            //   (禁止と許可が重なった場合は禁止を採る = 安全側)。
            allowed: !explicitlyForbidden
              && (explicitlyAllowed || negated || (fontPx < bodyFontPx && !inHeading)),
          });
        }
        return results;
      },
      {
        words: keywords,
        marks: markers,
        nots: negations,
        forbidden: alwaysForbidden,
        permitted: alwaysAllowed,
      },
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
  // 判定の理由を出す。※ は判定に使わないが、記録として併記する
  const why = entry.explicitlyForbidden
    ? '掲載不可では出せない文言 (設定で指定)'
    : entry.explicitlyAllowed
      ? '掲載不可でも出てよい文言 (設定で指定)'
      : entry.negated
        ? '否定表現 (なし)'
        : entry.fontPx < entry.bodyFontPx
          ? `本文より小さい${entry.hasMarker ? ' / ※あり' : ''}`
          : `本文より小さくない${entry.hasMarker ? ' / ※あり' : ''}`;
  return `「${entry.text}」 ${entry.fontPx}px (本文 ${entry.bodyFontPx}px) ${why} ${place}`;
}
