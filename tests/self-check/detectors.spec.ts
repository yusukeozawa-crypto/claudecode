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
import { buildProjects, deviceUse } from '../../utils/projects';
import { pagesFromSitemap, resolvePages, sitemapPageId } from '../../utils/page-source';
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
    const spec = config.agencies.agencies[0];
    const codeParam = `${config.agency.paramName}=${spec.code}`;
    const withPii = `${config.environment.baseUrl}${spec.entryPath}?${codeParam}&mail=test@example.com`;
    const findings = verifyUrlHygiene(withPii, config, '自己検査');
    expect(categories(findings), '個人情報らしいパラメータが検出されること').toContain('security');
    expect(
      findings.some((finding) => finding.severity === 'critical'),
      '重大度が Critical であること',
    ).toBe(true);

    const clean = verifyUrlHygiene(`${config.environment.baseUrl}${spec.entryPath}?${codeParam}`, config, '自己検査');
    expect(clean, '許可されたパラメータのみなら検知しない').toEqual([]);
  });

  test('別代理店の情報表示・セクションの表示崩れを検出できる', async ({ page }) => {
    const specs = config.agencies.agencies;
    test.skip(specs.length < 2, '代理店が 2 件以上必要です');
    const [first, second] = specs;

    // first のコードで流入したページに second の情報が出ている状況を作る
    await page.goto(`${config.environment.baseUrl}${first.entryPath}?${config.agency.paramName}=${first.code}`);
    await page.waitForLoadState('load');
    // 代理店名の要素は設定 (agency.yml の selectors) から解決する
    const nameTestId = config.agency.selectors.agencyName;
    await page.evaluate(
      ({ testId, otherName }: { testId: string; otherName: string }) => {
        const element = document.querySelector(`[data-testid="${testId}"]`);
        if (element) element.textContent = otherName;
      },
      { testId: nameTestId, otherName: second.expectedTexts[nameTestId] },
    );

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

  // ------------------------------------------------------------------
  // project 生成 (Firefox / WebKit を設定変更だけで追加できること)
  // ------------------------------------------------------------------

  test('ブラウザを有効化するだけで PC / SP の project が生成される', async () => {
    const devicesFile = {
      browsers: [
        { id: 'chromium' as const, enabled: true },
        { id: 'firefox' as const, enabled: true },
        { id: 'webkit' as const, enabled: true },
      ],
      devices: config.devices.devices,
    };

    const projects = buildProjects(devicesFile);
    const deviceIds = config.devices.devices.map((device) => device.id);

    expect(projects.length, 'ブラウザ数 × 端末数の project が生成されること').toBe(3 * deviceIds.length);
    for (const browserId of ['chromium', 'firefox', 'webkit']) {
      for (const deviceId of deviceIds) {
        expect(
          projects.map((project) => project.name),
          `${browserId}-${deviceId} の project が生成されること`,
        ).toContain(`${browserId}-${deviceId}`);
      }
    }

    // 無効なブラウザの project は生成されない
    const chromiumOnly = buildProjects({
      browsers: [
        { id: 'chromium' as const, enabled: true },
        { id: 'firefox' as const, enabled: false },
        { id: 'webkit' as const, enabled: false },
      ],
      devices: config.devices.devices,
    });
    expect(
      chromiumOnly.every((project) => project.name.startsWith('chromium-')),
      '無効化したブラウザの project は生成されないこと',
    ).toBe(true);

    // 端末情報が metadata で渡ること (レポートの PC/SP 列に使用される)
    for (const project of projects) {
      const device = config.devices.devices.find((entry) => entry.id === project.metadata.deviceId);
      expect(project.metadata.deviceLabel, 'metadata に端末ラベルが入ること').toBe(device?.label);
    }
  });

  test('Firefox では isMobile / hasTouch を適用しない (非対応のため)', async () => {
    const spDevice = config.devices.devices.find((device) => device.isMobile);
    test.skip(!spDevice, 'isMobile: true の端末が設定されていません');

    const firefoxUse = deviceUse('firefox', spDevice!);
    expect(firefoxUse.isMobile, 'Firefox では isMobile を渡さない').toBeUndefined();
    expect(firefoxUse.hasTouch, 'Firefox では hasTouch を渡さない').toBeUndefined();
    expect(firefoxUse.viewport, 'viewport は適用する').toEqual(spDevice!.viewport);
    expect(firefoxUse.userAgent, 'モバイル UA は適用する').toBe(spDevice!.userAgent);

    for (const browserId of ['chromium', 'webkit'] as const) {
      const otherUse = deviceUse(browserId, spDevice!);
      expect(otherUse.isMobile, `${browserId} では isMobile を適用する`).toBe(true);
      expect(otherUse.hasTouch, `${browserId} では hasTouch を適用する`).toBe(true);
    }
  });

  test('Chromium 実体の明示指定は Chromium の project にのみ適用される', async () => {
    const projects = buildProjects(
      {
        browsers: [
          { id: 'chromium' as const, enabled: true },
          { id: 'firefox' as const, enabled: true },
          { id: 'webkit' as const, enabled: true },
        ],
        devices: config.devices.devices,
      },
      { chromiumExecutablePath: '/opt/pw-browsers/chromium' },
    );

    for (const project of projects) {
      const hasLaunchOptions = 'launchOptions' in project.use;
      if (project.metadata.browserId === 'chromium') {
        expect(hasLaunchOptions, 'chromium には executablePath が適用されること').toBe(true);
      } else {
        expect(
          hasLaunchOptions,
          `${project.metadata.browserId} に Chromium の実体を渡すと起動できなくなるため適用しない`,
        ).toBe(false);
      }
    }
  });

  // ------------------------------------------------------------------
  // ページ取得 (config / sitemap.xml の切り替え)
  // ------------------------------------------------------------------

  test('sitemap.xml からページを取得でき、除外パターンが適用される', async ({ request }) => {
    const pages = await pagesFromSitemap(config, request);

    expect(pages.length, 'sitemap からページを取得できること').toBeGreaterThan(0);
    expect(
      pages.length,
      `maxPages (${config.pages.sitemap.maxPages}) を超えないこと`,
    ).toBeLessThanOrEqual(config.pages.sitemap.maxPages);

    const paths = pages.map((page) => page.path);
    expect(paths, '共通 LP が含まれること').toContain('/lp/');
    expect(
      paths.filter((path) => path.includes('/preview/')),
      'excludePatterns の /preview/ が除外されること',
    ).toEqual([]);
    expect(
      paths.filter((path) => path.endsWith('.pdf')),
      'excludePatterns の PDF が除外されること',
    ).toEqual([]);

    // id はファイル名 (レポート・抽出テキストの保存名) として使えること
    for (const page of pages) {
      expect(page.id, `id が安全な文字のみであること: ${page.id}`).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(page.checks.length, 'sitemap の defaults が適用されること').toBeGreaterThan(0);
    }

    expect(sitemapPageId('/'), 'ルートは top になる').toBe('top');
    expect(sitemapPageId('/lp/'), '末尾スラッシュを除去する').toBe('lp');
    expect(sitemapPageId('/a/b.html'), '階層は - でつなぐ').toBe('a-b');
  });

  test('sitemap.xml の取得に失敗した場合は config/pages.yml にフォールバックする', async ({ request }) => {
    const brokenConfig = {
      ...config,
      pages: {
        ...config.pages,
        source: 'sitemap' as const,
        sitemap: { ...config.pages.sitemap, path: '/no-such-sitemap.xml' },
      },
    };

    const pages = await resolvePages(brokenConfig, request);
    expect(
      pages.map((page) => page.id),
      '設定ファイルのページ定義にフォールバックすること',
    ).toEqual(config.pages.pages.map((page) => page.id));
  });
});
