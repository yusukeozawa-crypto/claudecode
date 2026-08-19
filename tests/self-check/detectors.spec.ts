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
import { detectMechanism, verifyRedirectTrace, verifyUrlHygiene } from '../../utils/redirect';
import { verifyNoOtherAgencyInfo, verifySections, verifyTexts } from '../../utils/agency';
import { maskUrl } from '../../utils/secrets';
import type { FindingCategory, RedirectTrace } from '../../utils/types';

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
    await page.goto('/lp/');

    const findings = await runLayoutChecks(page, config, {
      requiredTestIds: ['default-hero', 'common-benefits'],
      primaryTestIds: ['site-header', 'default-hero', 'common-benefits', 'site-footer'],
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
    await page.goto('/lp/');
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

  // ------------------------------------------------------------------
  // 代理店ごとの検出ロジック (リダイレクト / 誤表示 / URL / マスキング)
  // ------------------------------------------------------------------

  test('遷移方式 (HTTP / meta refresh / JS / SPA) を判定できる', async () => {
    const base = { entryUrl: 'https://example.jp/lp/', finalUrl: 'https://example.jp/partner/a/' };

    expect(
      detectMechanism({ ...base, httpRedirectCount: 1, documentRequestCount: 2, historyChangeCount: 0, metaRefreshTargets: [] }),
      'HTTP 3xx があれば http',
    ).toBe('http');

    expect(
      detectMechanism({ ...base, httpRedirectCount: 0, documentRequestCount: 2, historyChangeCount: 0, metaRefreshTargets: ['https://example.jp/partner/a/'] }),
      'meta refresh を検出できる',
    ).toBe('meta-refresh');

    expect(
      detectMechanism({ ...base, httpRedirectCount: 0, documentRequestCount: 2, historyChangeCount: 0, metaRefreshTargets: [] }),
      'ドキュメント要求が増えていれば JavaScript による遷移',
    ).toBe('js');

    expect(
      detectMechanism({ ...base, httpRedirectCount: 0, documentRequestCount: 1, historyChangeCount: 1, metaRefreshTargets: [] }),
      'history 変更のみなら SPA ルーティング',
    ).toBe('spa');

    expect(
      detectMechanism({
        entryUrl: 'https://example.jp/lp/',
        finalUrl: 'https://example.jp/lp/',
        httpRedirectCount: 0,
        documentRequestCount: 1,
        historyChangeCount: 0,
        metaRefreshTargets: [],
      }),
      'URL が変わらなければリダイレクトなし',
    ).toBe('none');
  });

  test('別代理店のLPへのリダイレクトとリダイレクトループを検出できる', async () => {
    const spec = config.agencies.agencies[0];
    const wrongTrace: RedirectTrace = {
      entryUrl: `${config.environment.baseUrl}${spec.entryPath}`,
      // 別代理店の専用 LP へ飛ばされた状態
      finalUrl: `${config.environment.baseUrl}/partner/other/`,
      hops: [],
      httpRedirectCount: 1,
      documentRequestCount: 2,
      historyChangeCount: 0,
      metaRefreshTargets: [],
      mechanism: 'http',
      loopDetected: false,
    };

    const findings = verifyRedirectTrace(
      wrongTrace,
      {
        code: spec.code,
        entryPath: spec.entryPath,
        expectedFinalPath: spec.expectedFinalPath,
        redirected: spec.redirected,
        redirectMechanism: spec.redirectMechanism,
        expectedRedirectCount: spec.expectedRedirectCount,
        expectedRedirectPaths: spec.expectedRedirectPaths,
      },
      config,
    );
    expect(categories(findings), '想定外のリダイレクトが Critical として検出されること').toContain('agency-redirect');
    expect(
      findings.some((finding) => finding.severity === 'critical'),
      '重大度が Critical であること',
    ).toBe(true);

    const loopFindings = verifyRedirectTrace(
      { ...wrongTrace, loopDetected: true },
      {
        code: spec.code,
        entryPath: spec.entryPath,
        expectedFinalPath: spec.expectedFinalPath,
        redirected: spec.redirected,
        redirectMechanism: spec.redirectMechanism,
      },
      config,
    );
    expect(categories(loopFindings), 'リダイレクトループが検出されること').toContain('redirect-loop');
    expect(loopFindings[0].severity, 'リダイレクトループは Critical').toBe('critical');
  });

  test('URL への個人情報・不要パラメータの付加を検出できる', async () => {
    const withPii = `${config.environment.baseUrl}/lp/?agency_code=A001&mail=test@example.com`;
    const findings = verifyUrlHygiene(withPii, config, '自己検査');
    expect(categories(findings), '個人情報らしいパラメータが検出されること').toContain('security');
    expect(
      findings.some((finding) => finding.severity === 'critical'),
      '重大度が Critical であること',
    ).toBe(true);

    const clean = verifyUrlHygiene(`${config.environment.baseUrl}/lp/?agency_code=A001`, config, '自己検査');
    expect(clean, '許可されたパラメータのみなら検知しない').toEqual([]);
  });

  test('別代理店の情報表示・セクションの表示崩れを検出できる', async ({ page }) => {
    const specs = config.agencies.agencies;
    test.skip(specs.length < 2, '代理店が 2 件以上必要です');
    const [first, second] = specs;

    // first のコードで流入したページに second の情報が出ている状況を作る
    await page.goto(`${config.environment.baseUrl}${first.entryPath}?${config.agency.paramName}=${first.code}`);
    await page.waitForLoadState('load');
    await page.evaluate((otherName: string) => {
      const element = document.querySelector('[data-testid="agency-name"]');
      if (element) element.textContent = otherName;
    }, second.expectedTexts['agency-name']);

    const wrongTexts = await verifyTexts(page, first.expectedTexts, '自己検査');
    expect(categories(wrongTexts), '代理店名の誤表示が検出されること').toContain('agency-display');

    const otherInfo = await verifyNoOtherAgencyInfo(page, config, first.code, '自己検査');
    expect(categories(otherInfo), '別代理店の情報表示が検出されること').toContain('agency-display');

    // 表示すべきセクションを隠した状態
    await page.evaluate((section: string) => {
      document.querySelector(`[data-testid="${section}"]`)?.setAttribute('hidden', 'hidden');
    }, first.visibleSections[0]);
    const sectionFindings = await verifySections(page, first, '自己検査');
    expect(
      sectionFindings.some((finding) => finding.title.includes('表示すべきセクションが表示されていません')),
      '表示すべきセクションの非表示が検出されること',
    ).toBe(true);

    // 非表示にすべきセクションを表示した状態
    if (first.hiddenSections.length > 0) {
      await page.evaluate((section: string) => {
        document.querySelector(`[data-testid="${section}"]`)?.removeAttribute('hidden');
      }, first.hiddenSections[0]);
      const shownFindings = await verifySections(page, first, '自己検査');
      expect(
        shownFindings.some((finding) => finding.title.includes('非表示にすべきセクションが表示されています')),
        '非表示にすべきセクションの表示が検出されること',
      ).toBe(true);
    }
  });

  test('レポートに一時トークンが出力されない', async () => {
    const token = 'c2VsZi1jaGVjay10b2tlbi0xMjM0NTY3ODkw';
    const collector = new FindingCollector(config, {
      environment: config.environmentName,
      environmentLabel: config.environment.label,
      baseUrl: config.environment.baseUrl,
      browserId: 'chromium',
      deviceId: 'pc',
      deviceLabel: 'PC',
    });
    const finding = collector.add({
      category: 'agency-handoff',
      severity: 'low',
      title: '自己検査',
      actual: `handoff_token=${token}`,
      url: `${config.environment.applicationBaseUrl}/entry/?handoff_token=${token}`,
    });

    expect(finding.actual, '本文からトークンが除去されること').not.toContain(token);
    expect(finding.url, 'URL からトークンが除去されること').not.toContain(token);
    expect(maskUrl(finding.url, config), '再マスクしても壊れないこと').toContain('handoff_token=');
  });
});
