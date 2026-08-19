/**
 * 表示崩れの検査。
 *   - 横スクロール (documentElement.scrollWidth > clientWidth)
 *   - 画像の読み込み失敗 (naturalWidth === 0)
 *   - 主要要素の viewport はみ出し
 *   - 主要要素同士の重なり
 *   - 空白画面 / 極端に大きな要素
 * すべての閾値は config/layout.yml で変更できる。
 */
import type { Page } from '@playwright/test';
import { matchesAnyGlob } from './patterns';
import { resolveSelector } from './config';
import type { FindingInput, QaConfig } from './types';

export interface ScrollMetrics {
  scrollWidth: number;
  clientWidth: number;
  viewportWidth: number;
  overflowPx: number;
  /** はみ出しの原因になっている要素 (上位) */
  offenders: Array<{ selector: string; right: number; width: number }>;
}

export interface ImageInfo {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  displayed: boolean;
  /** src 属性が設定されているか (未設定なら読み込み対象がない) */
  hasSrc: boolean;
  alt: string;
}

export interface ElementBox {
  testId: string;
  found: boolean;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** この要素が DOM 上で内包している他の検査対象 (入れ子は重なりとみなさない) */
  containsTestIds: string[];
}

/** 遅延読み込み画像を読み込ませるためにページ全体をスクロールする */
export async function scrollThroughPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = window.innerHeight;
    const total = document.body.scrollHeight;
    for (let y = 0; y < total; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  // 画像の読み込み完了を待つ
  await page
    .waitForFunction(() => Array.from(document.images).every((img) => img.complete), null, { timeout: 10000 })
    .catch(() => undefined);
}

/** 横スクロールの計測 */
export async function measureHorizontalScroll(page: Page): Promise<ScrollMetrics> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const clientWidth = root.clientWidth;
    const offenders: Array<{ selector: string; right: number; width: number }> = [];

    const describe = (element: Element): string => {
      const testId = element.getAttribute('data-testid');
      if (testId) return `[data-testid="${testId}"]`;
      const id = element.id ? `#${element.id}` : '';
      const className =
        typeof element.className === 'string' && element.className
          ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      return `${element.tagName.toLowerCase()}${id}${className}`;
    };

    for (const element of Array.from(document.body.querySelectorAll('*'))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const right = rect.left + rect.width + window.scrollX;
      if (right > clientWidth + 1) {
        offenders.push({ selector: describe(element), right: Math.round(right), width: Math.round(rect.width) });
      }
    }

    offenders.sort((a, b) => b.right - a.right);

    return {
      scrollWidth: root.scrollWidth,
      clientWidth,
      viewportWidth: window.innerWidth,
      overflowPx: root.scrollWidth - clientWidth,
      offenders: offenders.slice(0, 5),
    };
  });
}

/** ページ内の img 要素の読み込み状況 */
export async function collectImages(page: Page): Promise<ImageInfo[]> {
  return page.evaluate(() =>
    Array.from(document.images).map((img) => {
      const rect = img.getBoundingClientRect();
      const style = window.getComputedStyle(img);
      const srcAttribute = img.getAttribute('src') ?? '';
      return {
        src: img.currentSrc || img.src,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        displayed:
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          !img.hasAttribute('hidden') &&
          rect.width > 0 &&
          rect.height > 0,
        hasSrc: srcAttribute.trim().length > 0,
        alt: img.alt ?? '',
      };
    }),
  );
}

/** 主要要素の位置・サイズ */
export async function collectElementBoxes(page: Page, testIds: string[]): Promise<ElementBox[]> {
  return page.evaluate((ids: string[]) => {
    const toSelector = (id: string): string => (id.startsWith('css=') ? id.slice(4) : `[data-testid="${id}"]`);
    const elements = new Map<string, Element | null>();
    for (const id of ids) elements.set(id, document.querySelector(toSelector(id)));

    return ids.map((id) => {
      const element = elements.get(id) ?? null;
      if (!element) {
        return { testId: id, found: false, visible: false, x: 0, y: 0, width: 0, height: 0, containsTestIds: [] };
      }
      const containsTestIds = ids.filter((otherId) => {
        if (otherId === id) return false;
        const other = elements.get(otherId);
        return Boolean(other && element !== other && element.contains(other));
      });
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0.01 &&
        rect.width > 0 &&
        rect.height > 0;
      return {
        testId: id,
        found: true,
        visible,
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        containsTestIds,
      };
    });
  }, testIds);
}

export interface PageBodyMetrics {
  visibleTextLength: number;
  viewportHeight: number;
  tallestElement: { selector: string; height: number } | null;
}

/** 空白画面 / 極端に大きな要素の計測 */
export async function measureBody(page: Page): Promise<PageBodyMetrics> {
  return page.evaluate(() => {
    const text = (document.body.innerText ?? '').replace(/\s+/g, '');
    let tallest: { selector: string; height: number } | null = null;

    for (const element of Array.from(document.body.querySelectorAll('*'))) {
      const rect = element.getBoundingClientRect();
      const height = rect.height;
      if (!tallest || height > tallest.height) {
        const testId = element.getAttribute('data-testid');
        tallest = {
          selector: testId ? `[data-testid="${testId}"]` : element.tagName.toLowerCase(),
          height: Math.round(height),
        };
      }
    }

    return {
      visibleTextLength: text.length,
      viewportHeight: window.innerHeight,
      tallestElement: tallest,
    };
  });
}

function overlapRatio(a: ElementBox, b: ElementBox): number {
  const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
  const overlapArea = overlapWidth * overlapHeight;
  const smallestArea = Math.min(a.width * a.height, b.width * b.height);
  return smallestArea === 0 ? 0 : overlapArea / smallestArea;
}

export interface LayoutCheckOptions {
  /** 主要要素 (重なり・はみ出し検査の対象) */
  primaryTestIds?: string[];
  /** 必ず存在すべき要素 */
  requiredTestIds?: string[];
}

/** 表示崩れの一括検査 */
export async function runLayoutChecks(
  page: Page,
  config: QaConfig,
  options: LayoutCheckOptions = {},
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const layout = config.layout;
  const url = page.url();

  if (layout.images.enabled && layout.images.scrollThroughPage) {
    await scrollThroughPage(page);
  }

  // --- 必須要素の存在 ---
  for (const testIdValue of options.requiredTestIds ?? []) {
    const locator = page.locator(resolveSelector(testIdValue));
    const count = await locator.count();
    if (count === 0) {
      findings.push({
        category: 'layout',
        severity: 'high',
        title: `必須要素が見つかりません: ${testIdValue}`,
        expected: `${resolveSelector(testIdValue)} が存在すること`,
        actual: '要素が存在しません',
        url,
      });
    } else if (!(await locator.first().isVisible())) {
      findings.push({
        category: 'layout',
        severity: 'high',
        title: `必須要素が表示されていません: ${testIdValue}`,
        expected: `${resolveSelector(testIdValue)} が表示されること`,
        actual: '要素が非表示です',
        url,
      });
    }
  }

  // --- 横スクロール ---
  if (layout.horizontalScroll.enabled) {
    const metrics = await measureHorizontalScroll(page);
    if (metrics.overflowPx > layout.horizontalScroll.tolerancePx) {
      findings.push({
        category: 'horizontal-scroll',
        title: '横スクロールが発生しています',
        expected: `documentElement.scrollWidth <= clientWidth + ${layout.horizontalScroll.tolerancePx}px`,
        actual: `scrollWidth=${metrics.scrollWidth}px / clientWidth=${metrics.clientWidth}px (超過 ${metrics.overflowPx}px)`,
        url,
        detail:
          metrics.offenders.length > 0
            ? `はみ出し候補: ${metrics.offenders.map((o) => `${o.selector} (right=${o.right}px, width=${o.width}px)`).join(', ')}`
            : undefined,
      });
    }
  }

  // --- 画像の読み込み ---
  if (layout.images.enabled) {
    const images = await collectImages(page);
    for (const image of images) {
      // src 未設定 (これから設定される代理店バナー等) は読み込み対象がないため対象外
      if (!image.hasSrc || !image.src) continue;
      // 非表示の画像はユーザーに見えないため表示崩れとして扱わない
      if (!image.displayed) continue;
      if (matchesAnyGlob(image.src, layout.images.ignoreUrlPatterns)) continue;
      if (image.naturalWidth === 0) {
        findings.push({
          category: 'image-error',
          title: '画像を読み込めていません',
          expected: 'naturalWidth > 0',
          actual: `naturalWidth=0 (${image.src})`,
          url,
          detail: image.alt ? `alt="${image.alt}"` : undefined,
        });
      }
    }
  }

  // --- 主要要素のはみ出し / 重なり ---
  const primaryTestIds = (options.primaryTestIds ?? []).filter(
    (id) => !layout.viewportOverflow.ignoreTestIds.includes(id) && !layout.overlap.ignoreTestIds.includes(id),
  );

  if (primaryTestIds.length > 0) {
    const boxes = await collectElementBoxes(page, primaryTestIds);
    const viewport = page.viewportSize();
    const viewportWidth = viewport?.width ?? 0;

    if (layout.viewportOverflow.enabled && viewportWidth > 0) {
      for (const box of boxes) {
        if (!box.found || !box.visible) continue;
        const right = box.x + box.width;
        if (right > viewportWidth + layout.viewportOverflow.tolerancePx) {
          findings.push({
            category: 'layout',
            title: `主要要素が viewport をはみ出しています: ${box.testId}`,
            expected: `右端 <= ${viewportWidth + layout.viewportOverflow.tolerancePx}px`,
            actual: `右端 ${right}px (x=${box.x}, width=${box.width})`,
            url,
          });
        }
        if (box.x < -layout.viewportOverflow.tolerancePx) {
          findings.push({
            category: 'layout',
            title: `主要要素が左方向にはみ出しています: ${box.testId}`,
            expected: `左端 >= -${layout.viewportOverflow.tolerancePx}px`,
            actual: `左端 ${box.x}px`,
            url,
          });
        }
      }
    }

    if (layout.overlap.enabled) {
      const visibleBoxes = boxes.filter((box) => box.found && box.visible);
      for (let i = 0; i < visibleBoxes.length; i++) {
        for (let j = i + 1; j < visibleBoxes.length; j++) {
          // 入れ子関係にある要素同士は「重なり」ではないため除外する
          if (
            visibleBoxes[i].containsTestIds.includes(visibleBoxes[j].testId) ||
            visibleBoxes[j].containsTestIds.includes(visibleBoxes[i].testId)
          ) {
            continue;
          }
          const ratio = overlapRatio(visibleBoxes[i], visibleBoxes[j]);
          if (ratio > layout.overlap.maxOverlapRatio) {
            findings.push({
              category: 'layout',
              title: `主要要素が重なっています: ${visibleBoxes[i].testId} / ${visibleBoxes[j].testId}`,
              expected: `重なり比率 <= ${layout.overlap.maxOverlapRatio}`,
              actual: `重なり比率 ${ratio.toFixed(2)}`,
              url,
            });
          }
        }
      }
    }
  }

  // --- 空白画面 / 極端に大きな要素 ---
  if (layout.emptyScreen.enabled) {
    const metrics = await measureBody(page);
    if (metrics.visibleTextLength < layout.emptyScreen.minVisibleTextLength) {
      findings.push({
        category: 'layout',
        severity: 'high',
        title: 'ページがほぼ空白です',
        expected: `可視テキストが ${layout.emptyScreen.minVisibleTextLength} 文字以上あること`,
        actual: `可視テキスト ${metrics.visibleTextLength} 文字`,
        url,
      });
    }
    const maxHeight = metrics.viewportHeight * layout.emptyScreen.maxElementHeightRatio;
    if (metrics.tallestElement && metrics.tallestElement.height > maxHeight) {
      findings.push({
        category: 'layout',
        title: '極端に大きな要素があります',
        expected: `要素の高さ <= viewport 高さ × ${layout.emptyScreen.maxElementHeightRatio} (${Math.round(maxHeight)}px)`,
        actual: `${metrics.tallestElement.selector} の高さ ${metrics.tallestElement.height}px`,
        url,
      });
    }
  }

  return findings;
}
