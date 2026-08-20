/**
 * ページの構造シグネチャ。
 *
 * 「どのセクションが表示されているか」を、事前に data-testid を
 * 知らなくても比較できる形で取り出す。
 *
 * 用途: 代理店コードごとの表示差分を洗い出し、
 *       検査すべきセクションを特定する (推測で設定を書かないため)。
 */
import type { Page } from '@playwright/test';

export interface BlockInfo {
  /** 要素を指す鍵。data-testid > id > タグ+クラス の優先順で決める */
  key: string;
  /** 鍵の種類 (設定に書くときのセレクタ形式を決めるため) */
  keyKind: 'testid' | 'id' | 'class';
  /** 画面に表示されているか */
  visible: boolean;
  /** 表示テキストの先頭 (何のセクションか分かるように) */
  textSample: string;
  /** 表示テキストの長さ */
  textLength: number;
}

export interface PageSignature {
  url: string;
  blocks: BlockInfo[];
  /** 表示テキストを行単位で正規化したもの */
  textLines: string[];
}

/** 設定ファイルに書けるセレクタ表記へ変換する */
export function toSelectorHint(block: BlockInfo): string {
  if (block.keyKind === 'testid') return block.key;
  return `css=${block.key}`;
}

/**
 * 遷移が落ち着くのを待ってからシグネチャを取得する。
 *
 * リダイレクト (meta refresh / JavaScript) の途中で評価すると
 * 「Execution context was destroyed」で失敗するため、
 * 読み込み完了を待ち、それでも失敗した場合は 1 度だけ取り直す。
 */
export async function capturePageSignatureStable(page: Page): Promise<PageSignature | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => undefined);
    // 遷移直後に URL が変わり切っていない場合があるため少し待つ
    await page.waitForTimeout(400);
    try {
      return await capturePageSignature(page);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 遷移によるコンテキスト破棄以外は再試行しても直らない
      if (!/Execution context was destroyed|Target closed|navigation/i.test(message)) throw error;
    }
  }
  return null;
}

export async function capturePageSignature(page: Page): Promise<PageSignature> {
  const result = await page.evaluate(() => {
    const MAX_BLOCKS = 400;
    const MAX_LINES = 600;

    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };

    const describe = (element: Element): { key: string; keyKind: 'testid' | 'id' | 'class' } | null => {
      const testId = element.getAttribute('data-testid');
      if (testId) return { key: testId, keyKind: 'testid' };
      const id = element.getAttribute('id');
      // 自動生成されがちな id (数字混じりの長いもの) は鍵として使わない
      if (id && id.length <= 40 && !/^[0-9]/.test(id)) return { key: `#${id}`, keyKind: 'id' };
      const classes = (element.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter((name) => name !== '' && name.length <= 40)
        // 状態を表すクラス (is-active など) は表示差分の鍵にすると不安定
        .filter((name) => !/^(is-|has-|js-)/.test(name))
        .slice(0, 3);
      if (classes.length === 0) return null;
      return { key: `${element.tagName.toLowerCase()}.${classes.join('.')}`, keyKind: 'class' };
    };

    const candidates = Array.from(
      document.querySelectorAll('[data-testid], section, article, aside, header, footer, [id]'),
    ).slice(0, MAX_BLOCKS * 2);

    const seen = new Map<string, { key: string; keyKind: 'testid' | 'id' | 'class'; visible: boolean; textSample: string; textLength: number }>();
    for (const element of candidates) {
      const described = describe(element);
      if (!described) continue;
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      const visible = isVisible(element);
      const existing = seen.get(described.key);
      if (existing) {
        // 同じ鍵が複数あるときは「1 つでも表示されていれば表示」とみなす
        existing.visible = existing.visible || visible;
        continue;
      }
      if (seen.size >= MAX_BLOCKS) break;
      seen.set(described.key, {
        key: described.key,
        keyKind: described.keyKind,
        visible,
        textSample: text.slice(0, 80),
        textLength: text.length,
      });
    }

    const bodyText = (document.body?.innerText ?? '')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length >= 2)
      .slice(0, MAX_LINES);

    return { url: location.href, blocks: [...seen.values()], textLines: bodyText };
  });
  return result;
}

export interface SignatureDiff {
  /** 一方だけで表示されているブロック */
  visibleOnlyInA: BlockInfo[];
  visibleOnlyInB: BlockInfo[];
  /** 一方だけに存在する表示テキスト */
  textOnlyInA: string[];
  textOnlyInB: string[];
}

/**
 * 2 つのシグネチャを比較する。
 *
 * 「存在するか」ではなく「表示されているか」で比較する。
 * 非表示で DOM に残す実装 (display: none) が多いため、
 * 存在の有無だけでは表示差分を捉えられない。
 */
/**
 * テキスト比較用の正規化。
 *
 * 数字を伏せて比較する。現在時刻・残り時間・カウンタなどは
 * 実行するたびに変わるため、そのまま比較すると
 * 「代理店による違い」に混ざって差分が読めなくなる。
 */
function normalizeLine(line: string): string {
  return line.replace(/[0-9０-９]+/g, '#');
}

export function diffSignatures(a: PageSignature, b: PageSignature): SignatureDiff {
  const visibleMap = (signature: PageSignature): Map<string, BlockInfo> =>
    new Map(signature.blocks.filter((block) => block.visible).map((block) => [block.key, block]));

  const visibleA = visibleMap(a);
  const visibleB = visibleMap(b);
  const linesA = new Set(a.textLines.map(normalizeLine));
  const linesB = new Set(b.textLines.map(normalizeLine));

  return {
    visibleOnlyInA: [...visibleA.values()].filter((block) => !visibleB.has(block.key)),
    visibleOnlyInB: [...visibleB.values()].filter((block) => !visibleA.has(block.key)),
    textOnlyInA: a.textLines.filter((line) => !linesB.has(normalizeLine(line))),
    textOnlyInB: b.textLines.filter((line) => !linesA.has(normalizeLine(line))),
  };
}
