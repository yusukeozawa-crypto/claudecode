/**
 * 検出ロジックの自己検査 (ネガティブテスト)。
 *
 * 「不具合があるページ」に対して検出ロジックが実際に反応することを確認する。
 * ここが緑であることで、他のテストが緑のときに「本当に不具合が無い」と言える。
 *
 * 意図的に壊したページ (fixtures/mock-site/broken) を使用するため、
 * local 環境 (モックサイト) でのみ実行する。
 */
import { test, expect } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { runLayoutChecks, measureHorizontalScroll } from '../../utils/layout';
import { PageMonitor } from '../../utils/monitors';
import { checkPageLinks } from '../../utils/links';
import { detectTextIssues } from '../../utils/text-rules';
import { extractText } from '../../utils/text-extract';
import { FindingCollector } from '../../utils/findings';
import type { FindingCategory } from '../../utils/types';

const config = loadConfig();
const SP_VIEWPORT = { width: 390, height: 844 };

function categories(findings: Array<{ category: FindingCategory }>): FindingCategory[] {
  return findings.map((finding) => finding.category);
}

test.describe('検出ロジックの自己検査 @selfcheck', () => {
  test.skip(
    config.environmentName !== 'local',
    'モックサイト同梱の不具合ページを使用するため local 環境でのみ実行します',
  );

  test('横スクロールと要素の重なりを検出できる', async ({ page }) => {
    await page.setViewportSize(SP_VIEWPORT);
    await page.goto('/broken/overflow.html');

    const metrics = await measureHorizontalScroll(page);
    expect(metrics.scrollWidth, 'scrollWidth が clientWidth を超えていること').toBeGreaterThan(metrics.clientWidth);

    const findings = await runLayoutChecks(page, config, {
      primaryTestIds: ['too-wide', 'overlap-a', 'overlap-b'],
    });
    expect(categories(findings), '横スクロールが検出されること').toContain('horizontal-scroll');
    expect(
      findings.filter((finding) => finding.title.includes('重なっています')).length,
      '主要要素の重なりが検出されること',
    ).toBeGreaterThan(0);
  });

  test('正常なページでは表示崩れを検出しない (誤検知の確認)', async ({ page }) => {
    await page.setViewportSize(SP_VIEWPORT);
    await page.goto('/index.html');

    const findings = await runLayoutChecks(page, config, {
      requiredTestIds: ['main-visual', 'application-button'],
      primaryTestIds: ['site-header', 'main-visual', 'application-button', 'site-footer'],
    });
    expect(findings, `検知内容: ${JSON.stringify(findings, null, 2)}`).toEqual([]);
  });

  test('JavaScript エラー (console.error / pageerror) を検出できる', async ({ page }) => {
    const monitor = new PageMonitor(page, config);
    await page.goto('/broken/js-error.html');
    await page.waitForTimeout(500);
    monitor.detach();

    expect(monitor.pageErrors.length, 'pageerror が記録されること').toBeGreaterThan(0);
    expect(monitor.consoleEntries.length, 'console.error が記録されること').toBeGreaterThan(0);
    expect(categories(monitor.toFindings())).toContain('js-error');
  });

  test('画像の読み込みエラーを検出できる', async ({ page }) => {
    const monitor = new PageMonitor(page, config);
    await page.goto('/broken/broken-image.html');
    await page.waitForTimeout(300);
    monitor.detach();

    const layoutFindings = await runLayoutChecks(page, config, {});
    expect(categories(layoutFindings), 'naturalWidth=0 の画像が検出されること').toContain('image-error');
    expect(categories(monitor.toFindings()), '画像の 404 が検出されること').toContain('image-error');
  });

  test('リンク切れとリダイレクトループを検出できる', async ({ page, request }) => {
    await page.goto('/broken/broken-link.html');

    const { findings, checked } = await checkPageLinks(page, request, config);
    expect(checked, '検査対象のリンクが収集されること').toBeGreaterThan(0);

    const found = categories(findings);
    expect(found, '404 のリンク切れが検出されること').toContain('broken-link');
    expect(found, 'リダイレクトループが検出されること').toContain('redirect-loop');
    expect(
      findings.some((finding) => finding.actual?.includes('500')),
      '500 応答のリンクが検出されること',
    ).toBe(true);
  });

  test('表記揺れ・誤字・使用禁止表現を検出できる', async ({ page }) => {
    await page.goto('/broken/typos.html');
    const extracted = await extractText(page, config);
    const issues = detectTextIssues(extracted.fullText, config.text);

    const kinds = new Set(issues.map((issue) => issue.kind));
    expect(kinds, '表記揺れ (お申込み / WEB) が検出されること').toContain('unify');
    expect(kinds, '誤字候補 (保健金) が検出されること').toContain('typo');
    expect(kinds, '正式名称の誤表記が検出されること').toContain('canonical');
    expect(kinds, '使用禁止表現が検出されること').toContain('prohibited');
    expect(kinds, '体裁の不統一が検出されること').toContain('formatting');

    // 除外語 (保健所) が誤検出されないこと
    const typoFindings = issues.filter((issue) => issue.kind === 'typo');
    expect(
      typoFindings.every((issue) => !issue.excerpt.includes('保健所への届出')),
      '除外語「保健所」が誤字として検出されないこと',
    ).toBe(true);
  });

  test('正常なページでは表記の指摘が出ない (誤検知の確認)', async ({ page }) => {
    await page.goto('/index.html');
    const extracted = await extractText(page, config);
    const issues = detectTextIssues(extracted.fullText, config.text);
    expect(issues, `検知内容: ${JSON.stringify(issues, null, 2)}`).toEqual([]);
  });

  test('重大度ゲートが Critical / High を CI 失敗として扱う', async () => {
    const collector = new FindingCollector(config, {
      environment: config.environmentName,
      environmentLabel: config.environment.label,
      baseUrl: config.environment.baseUrl,
      browserId: 'chromium',
      deviceId: 'pc',
      deviceLabel: 'PC',
    });

    collector.add({ category: 'text-rule', title: '表記揺れ (Low)' });
    collector.add({ category: 'layout', title: '表示崩れ (Medium)' });
    expect(collector.blocking, 'Low / Medium だけでは CI を失敗させない').toEqual([]);

    collector.add({ category: 'agency-display', title: '代理店の誤表示 (Critical)' });
    collector.add({ category: 'js-error', title: 'JavaScript エラー (High)' });
    expect(collector.blocking.length, 'Critical / High はゲート対象になる').toBe(2);
    expect(collector.blocking.map((finding) => finding.severity).sort()).toEqual(['critical', 'high']);
  });
});
