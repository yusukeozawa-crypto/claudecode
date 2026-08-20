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
import { matchesAnyGlob } from './patterns';

export interface BlockInfo {
  /** 要素を指す鍵。data-testid > id > タグ+クラス の優先順で決める */
  key: string;
  /** 鍵の種類 (設定に書くときのセレクタ形式を決めるため) */
  keyKind: 'testid' | 'id' | 'class';
  /** 画面に表示されているか */
  visible: boolean;
  /** 表示されていないと判定した理由 (レポートで「なぜ差分に出ないか」を説明するため) */
  hiddenReason?: string;
  /** 表示サイズ (px)。高さ 0 の潰れた要素を人が確認できるようにする */
  width: number;
  height: number;
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
  /**
   * 取得のたびに表示が変わった要素の鍵。
   * アニメーション・遅延読み込み・スライダーなど「まだ動いている」もの。
   * 差分比較から除外する (実行タイミングの違いを代理店の違いと誤認しないため)。
   */
  unstableKeys?: string[];
  /** 取得のたびに変わったテキスト行 (同上の理由で比較から除外する) */
  unstableTextLines?: string[];
}

/** 設定ファイルに書けるセレクタ表記へ変換する */
export function toSelectorHint(block: BlockInfo): string {
  if (block.keyKind === 'testid') return block.key;
  return `css=${block.key}`;
}

/** 表示が落ち着くまでの待ち方 */
export interface SettleOptions {
  /** 安定を確認するために取り直す回数 */
  settleAttempts?: number;
  /** 取り直しの間隔 (ms) */
  settleDelayMs?: number;
}

/**
 * 遷移が落ち着くのを待ってからシグネチャを取得する。
 *
 * リダイレクト (meta refresh / JavaScript) の途中で評価すると
 * 「Execution context was destroyed」で失敗するため、
 * 読み込み完了を待ち、それでも失敗した場合は取り直す。
 *
 * さらに **表示が安定するまで取り直す**。
 * 遅延読み込みの画像・スライダー・アニメーションは、
 * 取得した瞬間によって「表示されている / されていない」が変わる。
 * 1 回しか取らないと、その揺れを「代理店による表示の違い」として
 * 報告してしまう (実行するたびに結果が変わる原因になる)。
 * 2 回続けて同じになるまで取り直し、それでも変わる要素は
 * unstableKeys / unstableTextLines に記録して比較から除外する。
 */
export async function capturePageSignatureStable(
  page: Page,
  options: SettleOptions = {},
): Promise<PageSignature | null> {
  const settleAttempts = options.settleAttempts ?? 3;
  const settleDelayMs = options.settleDelayMs ?? 600;

  const capture = async (): Promise<PageSignature | null> => {
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
  };

  let previous = await capture();
  if (!previous) return null;

  const unstableKeys = new Set<string>();
  const unstableTextLines = new Set<string>();

  for (let attempt = 0; attempt < settleAttempts; attempt += 1) {
    await page.waitForTimeout(settleDelayMs);
    const current = await capture();
    if (!current) break;

    const changedKeys = symmetricDifference(visibleKeySet(previous), visibleKeySet(current));
    const changedLines = symmetricDifference(textLineSet(previous), textLineSet(current));
    previous = current;
    if (changedKeys.length === 0 && changedLines.length === 0) break;
    for (const key of changedKeys) unstableKeys.add(key);
    for (const line of changedLines) unstableTextLines.add(line);
  }

  return {
    ...previous,
    unstableKeys: [...unstableKeys],
    unstableTextLines: [...unstableTextLines],
  };
}

function visibleKeySet(signature: PageSignature): Set<string> {
  return new Set(signature.blocks.filter((block) => block.visible).map((block) => block.key));
}

function textLineSet(signature: PageSignature): Set<string> {
  return new Set(signature.textLines.map(normalizeLine));
}

/** どちらか一方にしか無い要素 */
function symmetricDifference(a: Set<string>, b: Set<string>): string[] {
  const result: string[] = [];
  for (const value of a) if (!b.has(value)) result.push(value);
  for (const value of b) if (!a.has(value)) result.push(value);
  return result;
}

export async function capturePageSignature(page: Page): Promise<PageSignature> {
  const result = await page.evaluate(() => {
    const MAX_BLOCKS = 400;
    const MAX_LINES = 600;

    /**
     * 「人の目に見えているか」を判定する。
     *
     * 高さ 0 に潰れた要素・親要素で切り取られた要素・カルーセルの
     * 画面外スライドなどは、DOM にあっても利用者には見えていない。
     * これらを「表示」として数えると、見えていない要素が
     * 表示差分として報告されてしまう。
     */
    const visibility = (element: Element): { visible: boolean; reason?: string; width: number; height: number } => {
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      const size = { width, height };

      const style = window.getComputedStyle(element);
      if (style.display === 'none') return { visible: false, reason: 'display:none', ...size };
      if (style.visibility === 'hidden' || style.visibility === 'collapse') {
        return { visible: false, reason: `visibility:${style.visibility}`, ...size };
      }
      if (Number(style.opacity) === 0) return { visible: false, reason: 'opacity:0', ...size };
      if (element.getAttribute('aria-hidden') === 'true') return { visible: false, reason: 'aria-hidden', ...size };
      // 幅または高さが 0 なら見えていない (高さ 0 に潰れたバナー・アコーディオン)
      if (width === 0 || height === 0) return { visible: false, reason: `サイズ ${width}x${height}`, ...size };

      // 祖先による打ち消し。opacity は子に継承されないため個別に辿る必要がある
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const parentStyle = window.getComputedStyle(parent);
        if (Number(parentStyle.opacity) === 0) return { visible: false, reason: '親が opacity:0', ...size };
        const parentRect = parent.getBoundingClientRect();
        const clips = parentStyle.overflow !== 'visible' || parentStyle.overflowX !== 'visible' || parentStyle.overflowY !== 'visible';
        if (!clips) continue;
        // 親が潰れている / 親の表示範囲と重なっていない = 切り取られて見えない
        if (parentRect.width === 0 || parentRect.height === 0) {
          return { visible: false, reason: '親が高さ 0 (切り取られている)', ...size };
        }
        const overlapWidth = Math.min(rect.right, parentRect.right) - Math.max(rect.left, parentRect.left);
        const overlapHeight = Math.min(rect.bottom, parentRect.bottom) - Math.max(rect.top, parentRect.top);
        if (overlapWidth <= 0 || overlapHeight <= 0) {
          return { visible: false, reason: '親の表示範囲の外 (カルーセルの画面外スライドなど)', ...size };
        }
      }

      return { visible: true, ...size };
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

    interface Entry {
      key: string;
      keyKind: 'testid' | 'id' | 'class';
      visible: boolean;
      hiddenReason?: string;
      width: number;
      height: number;
      textSample: string;
      textLength: number;
    }

    const seen = new Map<string, Entry>();
    for (const element of candidates) {
      const described = describe(element);
      if (!described) continue;
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      const state = visibility(element);
      const existing = seen.get(described.key);
      if (existing) {
        // 同じ鍵が複数あるときは「1 つでも表示されていれば表示」とみなす
        if (!existing.visible && state.visible) {
          existing.visible = true;
          delete existing.hiddenReason;
          existing.width = state.width;
          existing.height = state.height;
        }
        continue;
      }
      if (seen.size >= MAX_BLOCKS) break;
      const entry: Entry = {
        key: described.key,
        keyKind: described.keyKind,
        visible: state.visible,
        width: state.width,
        height: state.height,
        textSample: text.slice(0, 80),
        textLength: text.length,
      };
      if (state.reason) entry.hiddenReason = state.reason;
      seen.set(described.key, entry);
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
export function normalizeLine(line: string): string {
  return line.replace(/[0-9０-９]+/g, '#');
}

/** 表示テキストの差分 (数字だけの違い・表示が安定しない行は無視する) */
export function diffTextLines(a: PageSignature, b: PageSignature): { onlyInA: string[]; onlyInB: string[] } {
  const linesA = new Set(a.textLines.map(normalizeLine));
  const linesB = new Set(b.textLines.map(normalizeLine));
  const unstable = new Set([...(a.unstableTextLines ?? []), ...(b.unstableTextLines ?? [])]);
  const stable = (line: string): boolean => !unstable.has(normalizeLine(line));
  return {
    onlyInA: a.textLines.filter((line) => !linesB.has(normalizeLine(line)) && stable(line)),
    onlyInB: b.textLines.filter((line) => !linesA.has(normalizeLine(line)) && stable(line)),
  };
}

export function diffSignatures(a: PageSignature, b: PageSignature): SignatureDiff {
  // 表示が安定しない要素は差分にしない (どちらのシグネチャで揺れていても除外する)
  const unstable = new Set([...(a.unstableKeys ?? []), ...(b.unstableKeys ?? [])]);
  const visibleMap = (signature: PageSignature): Map<string, BlockInfo> =>
    new Map(
      signature.blocks
        .filter((block) => block.visible && !unstable.has(block.key))
        .map((block) => [block.key, block]),
    );

  const visibleA = visibleMap(a);
  const visibleB = visibleMap(b);
  const text = diffTextLines(a, b);

  return {
    visibleOnlyInA: [...visibleA.values()].filter((block) => !visibleB.has(block.key)),
    visibleOnlyInB: [...visibleB.values()].filter((block) => !visibleA.has(block.key)),
    textOnlyInA: text.onlyInA,
    textOnlyInB: text.onlyInB,
  };
}

/** 表示されているブロックの鍵 (比較対象) */
/**
 * 除外指定に一致するか。
 *   完全一致のほか `*` を使ったパターンも書ける。
 *   月ごとに id が変わる要素 (例: #lf-campaign-banner-202609-1) を
 *   毎月書き換えずに除外できるようにするため。
 *   config には `css=#lf-campaign-banner-*` の形で書ける。
 */
export function matchesIgnoreKey(key: string, patterns: Iterable<string>): boolean {
  const list = [...patterns];
  if (list.includes(key)) return true;
  const normalized = list.map((pattern) => (pattern.startsWith('css=') ? pattern.slice(4) : pattern));
  return matchesAnyGlob(key, normalized.filter((pattern) => pattern.includes('*')));
}

export function visibleBlockKeys(signature: PageSignature, ignoreKeys: Iterable<string> = []): string[] {
  const patterns = [...ignoreKeys];
  // 表示が安定しない要素は比較しない (実行タイミングの違いを差分にしないため)
  const unstable = new Set(signature.unstableKeys ?? []);
  return signature.blocks
    .filter((block) => block.visible && !unstable.has(block.key) && !matchesIgnoreKey(block.key, patterns))
    .map((block) => block.key)
    .sort();
}

export interface BlockComparison {
  /** 基準にはあるが対象に無い */
  missing: string[];
  /** 対象にだけある */
  extra: string[];
  /** 双方にある */
  shared: string[];
}

/**
 * 表示されているブロックを比較する。
 *
 * 「同じ分類の代理店なら表示が一致するはず」「異なる分類なら相違があるはず」
 * を検査するための比較。どの要素が代理店によって変わるのかを
 * 事前に列挙できないサイトでも成立する。
 */
export function compareVisibleBlocks(
  reference: PageSignature,
  target: PageSignature,
  ignoreKeys: Iterable<string> = [],
): BlockComparison {
  const referenceKeys = visibleBlockKeys(reference, ignoreKeys);
  const targetKeys = visibleBlockKeys(target, ignoreKeys);
  const targetSet = new Set(targetKeys);
  const referenceSet = new Set(referenceKeys);
  return {
    missing: referenceKeys.filter((key) => !targetSet.has(key)),
    extra: targetKeys.filter((key) => !referenceSet.has(key)),
    shared: referenceKeys.filter((key) => targetSet.has(key)),
  };
}

export interface DisplayDifference {
  /** 表示ブロックの構成が違うか */
  blocksDiffer: boolean;
  /** 文言が違うか */
  textDiffers: boolean;
  /** 何らかの違いがあるか */
  differs: boolean;
  onlyInA: string[];
  onlyInB: string[];
  textOnlyInA: string[];
  textOnlyInB: string[];
  sharedBlocks: string[];
}

/**
 * 2 ページの表示が違うかを判定する。
 *
 * 「セクションが出る / 出ない」だけでなく、フッターの表記や注釈など
 * 文言だけの違いも「表示が違う」とみなす。
 * ブロックの有無しか見ないと、文言だけ変わるサイトで
 * 「切り替えが効いていない」と誤判定する。
 */
export function evaluateDisplayDifference(
  a: PageSignature,
  b: PageSignature,
  ignoreKeys: Iterable<string> = [],
): DisplayDifference {
  const blocks = compareVisibleBlocks(a, b, ignoreKeys);
  const text = diffTextLines(a, b);
  const blocksDiffer = blocks.missing.length > 0 || blocks.extra.length > 0;
  const textDiffers = text.onlyInA.length > 0 || text.onlyInB.length > 0;
  return {
    blocksDiffer,
    textDiffers,
    differs: blocksDiffer || textDiffers,
    onlyInA: blocks.missing,
    onlyInB: blocks.extra,
    textOnlyInA: text.onlyInA,
    textOnlyInB: text.onlyInB,
    sharedBlocks: blocks.shared,
  };
}
