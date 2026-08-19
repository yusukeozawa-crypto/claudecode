/**
 * スクリーンショットの保存と基準画像との比較。
 *   - 常に PC / SP のフルページスクリーンショットを screenshots/current に保存する
 *   - 基準画像は screenshots/baseline に保存される (初回実行時に自動作成)
 *   - 差分許容値は config/visual.yml で変更できる
 *   - 動的要素 (日時・カルーセル・外部チャット等) はマスクできる
 *   - 差分発生時は基準画像 / 現在画像 / 差分画像が HTML レポートに添付される
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { PROJECT_ROOT, resolveSelector } from './config';
import { sleep } from './throttle';
import type { FindingInput, QaConfig } from './types';

/** config/visual.yml の mask 設定から Locator を作る */
export function maskLocators(page: Page, config: QaConfig): Locator[] {
  return config.visual.mask.map((entry) => page.locator(resolveSelector(entry)));
}

function snapshotName(pageId: string): string {
  return `${pageId}.png`;
}

/** フルページスクリーンショットを保存する (常に実行) */
export async function captureFullPage(
  page: Page,
  config: QaConfig,
  options: { pageId: string; browserId: string; deviceId: string; suffix?: string },
): Promise<string> {
  const dir = path.join(
    PROJECT_ROOT,
    config.visual.capture.outputDir,
    config.environmentName,
    `${options.browserId}-${options.deviceId}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${options.pageId}${options.suffix ? `__${options.suffix}` : ''}.png`;
  const filePath = path.join(dir, fileName);

  await page.screenshot({
    path: filePath,
    fullPage: config.visual.capture.fullPage,
    mask: maskLocators(page, config),
    maskColor: config.visual.maskColor,
    animations: config.visual.compare.animations,
    caret: config.visual.compare.caret,
  });

  return filePath;
}

/**
 * 基準画像との比較。
 *   - 基準画像が無い場合は Playwright が自動作成する (初回実行)
 *   - 差分が許容値を超えた場合は Finding (visual-diff / Low) を返す
 *   - 期待画像・実際の画像・差分画像は Playwright により添付される
 */
export async function compareWithBaseline(
  page: Page,
  config: QaConfig,
  testInfo: TestInfo,
  options: { pageId: string; pageName: string },
): Promise<FindingInput[]> {
  if (!config.visual.enabled) return [];

  // 動的要素の描画が落ち着くのを待つ
  if (config.visual.compare.stabilizeDelayMs > 0) {
    await sleep(config.visual.compare.stabilizeDelayMs);
  }

  const name = snapshotName(options.pageId);
  const baselinePath = testInfo.snapshotPath(name);
  const screenshotOptions = {
    fullPage: config.visual.capture.fullPage,
    mask: maskLocators(page, config),
    maskColor: config.visual.maskColor,
    animations: config.visual.compare.animations,
    caret: config.visual.compare.caret,
    // toHaveScreenshot は既定で CSS ピクセル基準で比較するため、
    // 基準画像も同じスケールで作成する (SP の deviceScaleFactor に依存しないようにする)
    scale: 'css',
  } as const;

  // 初回実行: 基準画像を作成して比較は行わない
  if (!fs.existsSync(baselinePath)) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    await page.screenshot({ path: baselinePath, ...screenshotOptions });
    console.log(`[qa] 基準画像を作成しました: ${path.relative(PROJECT_ROOT, baselinePath)}`);
    await testInfo.attach(`baseline-created-${options.pageId}`, {
      path: baselinePath,
      contentType: 'image/png',
    });
    return [];
  }

  try {
    await expect(page).toHaveScreenshot(name, screenshotOptions);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 差分が出た場合、Playwright は出力先に 3 枚を書き出す。
    // QA レポートから直接参照できるよう、検知結果に相対パスを持たせる。
    const comparisonImages = collectComparisonImages(testInfo, options.pageId);

    return [
      {
        category: 'visual-diff',
        severity: 'low',
        title: `基準画像との差分を検知しました: ${options.pageName}`,
        expected: `差分が許容値以内であること (threshold=${config.visual.compare.threshold}, maxDiffPixelRatio=${config.visual.compare.maxDiffPixelRatio})`,
        actual: firstLines(message, 4),
        url: page.url(),
        pageId: options.pageId,
        pageName: options.pageName,
        screenshots: comparisonImages,
        detail: [
          `基準画像: ${path.relative(PROJECT_ROOT, baselinePath)}`,
          comparisonImages.length > 0
            ? '基準画像 (expected) / 現在画像 (actual) / 差分画像 (diff) をレポートから確認できます'
            : '基準画像 / 現在画像 / 差分画像は HTML レポートの添付ファイルから確認できます',
          '意図した変更の場合は npm run update:screenshots で基準画像を更新してください',
        ].join(' / '),
      },
    ];
  }
}

/**
 * 差分比較の 3 枚 (基準画像 / 現在画像 / 差分画像) を集める。
 * reports/ を起点とした相対パスで返す (QA レポートから参照するため)。
 */
function collectComparisonImages(testInfo: TestInfo, pageId: string): string[] {
  const reportDir = path.join(PROJECT_ROOT, 'reports');
  const suffixes = ['expected', 'actual', 'diff'];
  const images: string[] = [];

  for (const suffix of suffixes) {
    const filePath = testInfo.outputPath(`${pageId}-${suffix}.png`);
    if (fs.existsSync(filePath)) {
      images.push(path.relative(reportDir, filePath));
    }
  }

  return images;
}

function firstLines(text: string, count: number): string {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(0, count)
    .join(' / ');
}
