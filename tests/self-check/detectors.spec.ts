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
import { RedirectTracker, detectMechanism, verifyRedirectTrace, verifyUrlHygiene } from '../../utils/redirect';
import { captureFullPage } from '../../utils/screenshots';
import { capturePageSignatureStable, compareVisibleBlocks, diffSignatures, evaluateDisplayDifference, toSelectorHint } from '../../utils/page-signature';
import { agencyPairs, verifyNoOtherAgencyInfo, verifySections, verifyTexts } from '../../utils/agency';
import { maskText, maskUrl } from '../../utils/secrets';
import { buildProjects, deviceUse } from '../../utils/projects';
import { pagesFromSitemap, resolvePages, sitemapPageId } from '../../utils/page-source';
import { detectCrossPageInconsistency } from '../../utils/text-rules';
import { collectLinks } from '../../utils/links';
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

  test('URL に付加された個人情報がレポートに出力されない', async () => {
    const base = `${config.environment.baseUrl}/lp/?${config.agency.paramName}=X001`;

    // キー名による判定 (forbiddenQueryParamKeywords)
    const withMailKey = maskUrl(`${base}&mail=someone@example.com`, config);
    expect(withMailKey, 'メールアドレスの値が残らないこと').not.toContain('someone@example.com');
    expect(withMailKey, '代理店コードは残ること').toContain(`${config.agency.paramName}=X001`);

    // 値のパターンによる判定 (piiValuePatterns) — キー名が無害でも値で検出する
    const withMailValue = maskUrl(`${base}&ref=someone@example.com`, config);
    expect(withMailValue, '値がメールアドレスならマスクすること').not.toContain('someone@example.com');

    // 本文中の key=value も対象
    const inText = maskText(`遷移先: ${base}&tel=090-1234-5678`, config);
    expect(inText, '本文中の電話番号がマスクされること').not.toContain('090-1234-5678');

    // 期待値として表示したい代理店の電話番号は本文中で維持される
    const agencyPhone = Object.values(config.agencies.agencies[0].expectedTexts).find((value) =>
      /\d{2,4}-\d{3,4}-\d{3,4}/.test(value),
    );
    if (agencyPhone) {
      expect(
        maskText(`期待: ${agencyPhone}`, config),
        '代理店の電話番号は期待値として残ること (過剰なマスキングをしない)',
      ).toContain(agencyPhone);
    }
  });

  test('レポートに添付する証跡から一時トークンが除去される', async () => {
    // QaSession.attachJson と同じ経路 (JSON.stringify -> maskText) を検証する
    const token = 'ZXZpZGVuY2UtdG9rZW4tMTIzNDU2Nzg5MGFiY2RlZg';
    const trace = {
      entryUrl: `${config.environment.baseUrl}/lp/?${config.agency.paramName}=X001`,
      finalUrl: `${config.environment.applicationBaseUrl}/entry/?handoff_token=${token}`,
      hops: [
        { url: `${config.environment.applicationBaseUrl}/entry/?handoff_token=${token}`, status: 200 },
      ],
    };

    const serialized = JSON.stringify(trace, null, 2);
    const masked = maskText(serialized, config) ?? '';

    expect(masked, '証跡からトークンが除去されること').not.toContain(token);
    expect(masked, '経路の構造は保持されること').toContain('finalUrl');
    expect(masked, '代理店コードは残ること').toContain(`${config.agency.paramName}=X001`);
    expect(() => JSON.parse(masked), 'マスク後も JSON として解析できること').not.toThrow();
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

  // ------------------------------------------------------------------
  // 空白画面 / 極端に大きな要素 / URL の不要パラメータ / リンク上限
  // ------------------------------------------------------------------

  test('空白画面を検出できる', async ({ page }) => {
    await page.goto('/broken/blank.html');
    const findings = await runLayoutChecks(page, config, {});

    const blank = findings.find((finding) => finding.title.includes('ほぼ空白'));
    expect(blank, `空白画面が検出されること (検知: ${JSON.stringify(findings)})`).toBeTruthy();
    expect(blank?.severity, '空白画面は High として報告される').toBe('high');
    expect(blank?.expected, '閾値が期待結果に含まれること').toContain(
      String(config.layout.emptyScreen.minVisibleTextLength),
    );
  });

  test('極端に大きな要素を検出できる', async ({ page }) => {
    await page.goto('/broken/huge.html');
    const findings = await runLayoutChecks(page, config, {});

    const huge = findings.find((finding) => finding.title.includes('極端に大きな要素'));
    expect(huge, `巨大要素が検出されること (検知: ${JSON.stringify(findings)})`).toBeTruthy();
    expect(huge?.category, '表示崩れとして分類される').toBe('layout');
  });

  test('URL の不要なパラメータを検出できる', async () => {
    const spec = config.agencies.agencies[0];
    const withExtra = `${config.environment.baseUrl}${spec.entryPath}?${config.agency.paramName}=${spec.code}&debug=1&tracking_id=abc`;

    const findings = verifyUrlHygiene(withExtra, config, '自己検査');
    const extras = findings.filter((finding) => finding.title.includes('不要なパラメータ'));
    expect(extras.length, '許可されていないパラメータが検出されること').toBeGreaterThan(0);
    expect(
      extras.some((finding) => finding.title.includes('debug')),
      'パラメータ名が示されること',
    ).toBe(true);
    expect(extras[0].severity, '不要なパラメータは Medium として報告される').toBe('medium');
  });

  test('リンク検査の件数上限が効く', async ({ page }) => {
    await page.goto('/lp/');

    const limited = {
      ...config,
      errors: {
        ...config.errors,
        links: { ...config.errors.links, maxLinksPerPage: 2 },
      },
    };
    const links = await collectLinks(page, limited);
    expect(links.length, '上限 (2 件) を超えないこと').toBeLessThanOrEqual(2);

    const unlimited = await collectLinks(page, config);
    expect(unlimited.length, '上限を上げれば多く収集されること').toBeGreaterThan(links.length);
  });

  test('URL の書き換えだけの変更は遷移として数えない (誤検知の確認)', async ({ page }) => {
    // 実サイトでは計測タグ・同意バナー・ABテストのスクリプトが
    // history.replaceState でクエリを書き換えたり # を付けたりする。
    // これを遷移として数えると、リダイレクトしていないページが
    // 「リダイレクト回数が仕様と異なる」と誤検知される。
    for (const kind of ['query', 'hash'] as const) {
      const entryUrl = `${config.environment.baseUrl}/url-rewrite?kind=${kind}`;
      const tracker = new RedirectTracker(page);
      try {
        await page.goto(entryUrl);
        await page.waitForTimeout(300);
        const trace = tracker.build(entryUrl, config.agencies.redirect.maxRedirects);
        expect(trace.historyChangeCount, `${kind} の書き換えは SPA 遷移として数えない`).toBe(0);
        expect(
          verifyRedirectTrace(
            trace,
            {
              code: null,
              entryPath: '/url-rewrite',
              expectedFinalPath: '/url-rewrite',
              redirected: false,
              redirectMechanism: 'none',
              expectedRedirectCount: 0,
              expectedRedirectPaths: [],
            },
            config,
          ).filter((finding) => finding.severity === 'critical' || finding.severity === 'high'),
          `${kind}: リダイレクトなしの仕様に対して Critical / High を出さない`,
        ).toEqual([]);
      } finally {
        tracker.detach();
      }
    }
  });

  test('パスが変わる URL 変更は SPA 遷移として数える (見逃しの確認)', async ({ page }) => {
    const entryUrl = `${config.environment.baseUrl}/url-rewrite?kind=path`;
    const tracker = new RedirectTracker(page);
    try {
      await page.goto(entryUrl);
      await page.waitForTimeout(300);
      const trace = tracker.build(entryUrl, config.agencies.redirect.maxRedirects);
      expect(trace.historyChangeCount, 'パスの変更は SPA 遷移として数える').toBe(1);
      expect(trace.mechanism, '遷移方式は SPA と判定される').toBe('spa');
    } finally {
      tracker.detach();
    }
  });

  test('代理店コードによる表示差分を洗い出せる (セクション名を知らなくても特定できる)', async ({ page }) => {
    // 実サイトでは、どの要素が代理店によって出る / 出ないのかが
    // 事前に分からない。差分から特定できることを確認する。
    const withoutCode = `${config.environment.baseUrl}/lp/`;
    await page.goto(withoutCode);
    const baseline = await capturePageSignatureStable(page);
    expect(baseline, '基準ページのシグネチャを取得できること').not.toBeNull();

    const spec = config.agencies.agencies[0];
    await page.goto(`${withoutCode}?${config.agency.paramName}=${spec.code}`);
    const withCode = await capturePageSignatureStable(page);
    expect(withCode, '代理店ページのシグネチャを取得できること').not.toBeNull();

    const diff = diffSignatures(baseline!, withCode!);
    const appeared = diff.visibleOnlyInB.map((block) => block.key);
    const disappeared = diff.visibleOnlyInA.map((block) => block.key);

    expect(appeared, '代理店コードで出るセクションを検出できること').toContain('agency-contact');
    expect(disappeared, '代理店コードで消えるセクションを検出できること').toContain('default-contact');
    // 設定にそのまま書ける形で出ること
    expect(toSelectorHint(diff.visibleOnlyInB[0]!), 'data-testid はそのまま使える').not.toContain('css=');
  });

  test('表示の一貫性: 同じ分類なのに違う表示を検出できる / 一致していれば検出しない', async () => {
    // みらやくの表示差分はセクション・フッター・注釈など複数箇所に及び、
    // どこが変わるかを列挙しきれない。そのため
    // 「同じ分類なら一致」「異なる分類なら相違」で検査する。
    const block = (key: string, visible: boolean) => ({
      key,
      keyKind: 'testid' as const,
      visible,
      textSample: key,
      textLength: key.length,
    });
    const signature = (keys: Array<[string, boolean]>) => ({
      url: 'https://example.test/lp/service/',
      blocks: keys.map(([key, visible]) => block(key, visible)),
      textLines: [],
    });

    const reference = signature([
      ['hero', true],
      ['mirayaku-section', true],
      ['footer-mirayaku-note', true],
      ['footnote-a', true],
    ]);

    // 一致している場合は検出しない (誤検知の確認)
    const same = compareVisibleBlocks(reference, signature([
      ['footnote-a', true],
      ['hero', true],
      ['footer-mirayaku-note', true],
      ['mirayaku-section', true],
    ]));
    expect(same.missing, '順番が違っても一致とみなす').toEqual([]);
    expect(same.extra, '順番が違っても一致とみなす').toEqual([]);

    // フッターの表記だけが違う場合も検出する (セクション名を知らなくても分かる)
    const footerDiffers = compareVisibleBlocks(reference, signature([
      ['hero', true],
      ['mirayaku-section', true],
      ['footer-default-note', true],
      ['footnote-a', true],
    ]));
    expect(footerDiffers.missing, 'フッターの表記差分を検出する').toEqual(['footer-mirayaku-note']);
    expect(footerDiffers.extra, 'フッターの表記差分を検出する').toEqual(['footer-default-note']);

    // display: none で残す実装でも「表示されていない」として検出する
    const hidden = compareVisibleBlocks(reference, signature([
      ['hero', true],
      ['mirayaku-section', false],
      ['footer-mirayaku-note', true],
      ['footnote-a', true],
    ]));
    expect(hidden.missing, 'DOM に残っていても非表示なら検出する').toEqual(['mirayaku-section']);

    // 除外指定した鍵は比較しない (ABテストの差し込み枠など)
    const ignored = compareVisibleBlocks(
      reference,
      signature([
        ['hero', true],
        ['mirayaku-section', true],
        ['footer-mirayaku-note', true],
        ['footnote-a', true],
        ['ab-test-slot', true],
      ]),
      ['ab-test-slot'],
    );
    expect(ignored.extra, '除外した鍵は差分にしない').toEqual([]);
  });

  test('スクリーンショットの撮影失敗で検査を止めない (証跡と判定を分ける)', async ({ page }) => {
    // 縦に長いページを SP 幅で撮ると時間がかかり、タイムアウトすることがある。
    // 撮影は証跡であって判定ではないため、失敗しても例外にしない。
    await page.goto(`${config.environment.baseUrl}/lp/`);
    const impossible = {
      ...config,
      visual: { ...config.visual, capture: { ...config.visual.capture, timeoutMs: 1 } },
    };
    const result = await captureFullPage(page, impossible, {
      pageId: 'selfcheck-timeout',
      browserId: 'chromium',
      deviceId: 'pc',
    });
    expect(result, '撮影に失敗したら null を返し、例外を投げない').toBeNull();

    // 通常の設定なら撮影できる
    const ok = await captureFullPage(page, config, {
      pageId: 'selfcheck-ok',
      browserId: 'chromium',
      deviceId: 'pc',
    });
    expect(ok, '通常の設定では撮影できること').not.toBeNull();
  });

  test('文言だけの違いも「表示が違う」と判定する (切り替えの誤判定防止)', async () => {
    // みらやくの表示差分はセクションの有無だけでなく、
    // フッターの表記や注釈など文言だけの違いとして現れることもある。
    // ブロックの有無しか見ないと「切り替えが効いていない」と誤判定する。
    const blocks = [
      { key: 'footer', keyKind: 'class' as const, visible: true, textSample: '', textLength: 10 },
      { key: 'main-hero', keyKind: 'testid' as const, visible: true, textSample: '', textLength: 10 },
    ];
    const mirayakuOk = { url: 'https://example.test/?code=A', blocks, textLines: ['共通の説明', 'みらやく掲載あり'] };
    const mirayakuNg = { url: 'https://example.test/?code=B', blocks, textLines: ['共通の説明', 'みらやく掲載なし'] };
    const identical = { url: 'https://example.test/?code=C', blocks, textLines: ['共通の説明', 'みらやく掲載あり'] };

    const textOnly = evaluateDisplayDifference(mirayakuOk, mirayakuNg);
    expect(textOnly.blocksDiffer, 'ブロック構成は同一').toBe(false);
    expect(textOnly.textDiffers, '文言は異なる').toBe(true);
    expect(textOnly.differs, '文言だけの違いも「表示が違う」と判定する').toBe(true);
    expect(textOnly.textOnlyInB, '違う文言が分かること').toContain('みらやく掲載なし');

    const same = evaluateDisplayDifference(mirayakuOk, identical);
    expect(same.differs, '完全に同じなら「違いなし」と判定する').toBe(false);

    const blocksChanged = evaluateDisplayDifference(mirayakuOk, {
      ...mirayakuOk,
      blocks: [...blocks, { key: 'extra', keyKind: 'testid' as const, visible: true, textSample: '', textLength: 1 }],
    });
    expect(blocksChanged.blocksDiffer, 'ブロックの違いも検出する').toBe(true);
    expect(blocksChanged.onlyInB, '増えたブロックが分かること').toContain('extra');
  });

  test('数字だけが違うテキストは差分として報告しない (時刻・カウンタの誤検知防止)', async () => {
    const base = {
      url: 'https://example.test/',
      blocks: [],
      textLines: ['現在時刻 2026/8/20 6:17:00', '残り 3 名', '共通の文言'],
    };
    const other = {
      url: 'https://example.test/?code=X',
      blocks: [],
      textLines: ['現在時刻 2026/8/20 6:17:59', '残り 7 名', '共通の文言', '代理店だけの文言'],
    };
    const diff = diffSignatures(base, other);
    expect(diff.textOnlyInB, '数字違いは差分にしない / 本当の追加だけを出す').toEqual([
      '代理店だけの文言',
    ]);
    expect(diff.textOnlyInA, '数字違いは差分にしない').toEqual([]);
  });

  test('リダイレクト回数が未設定なら照合せず実測値を記録する', async () => {
    // 推測した回数で判定すると、正常なサイトを不具合として報告してしまう。
    // 未設定 (null) の間は Critical / High を出さず、実測値を Low で記録する。
    const trace = {
      entryUrl: 'https://example.test/lp/service/',
      finalUrl: 'https://example.test/lp/service-premium/',
      hops: [
        { url: 'https://example.test/lp/service/', status: 302, location: 'https://example.test/lp/service-premium/', kind: 'http' as const },
        { url: 'https://example.test/lp/service-premium/', status: 200, location: null, kind: 'document' as const },
      ],
      httpRedirectCount: 1,
      documentRequestCount: 2,
      historyChangeCount: 0,
      metaRefreshTargets: [],
      loopDetected: false,
      mechanism: 'http' as const,
    };
    const expectation = {
      code: 'littlefamily03',
      entryPath: '/lp/service/',
      expectedFinalPath: '/lp/service-premium/',
      redirected: true,
      redirectMechanism: 'unknown' as const,
      expectedRedirectPaths: ['/lp/service-premium/'],
    };

    const unmeasured = verifyRedirectTrace(
      trace,
      { ...expectation, expectedRedirectCount: null },
      config,
    );
    expect(
      unmeasured.filter((finding) => finding.severity === 'critical' || finding.severity === 'high'),
      '未設定なら Critical / High を出さない',
    ).toEqual([]);
    const recorded = unmeasured.find((finding) => finding.title.includes('リダイレクト回数が未設定'));
    expect(recorded, '実測値が記録されること').toBeDefined();
    expect(recorded?.actual, '実測値と内訳が分かること').toContain('1 回');
    expect(recorded?.actual, '内訳が分かること').toContain('HTTP 3xx: 1');

    // 実測値を設定すれば、以降は差異を検知できる
    const wrong = verifyRedirectTrace(
      trace,
      { ...expectation, expectedRedirectCount: 2 },
      config,
    );
    expect(
      wrong.some((finding) => finding.severity === 'high' && finding.title.includes('リダイレクト回数')),
      '設定後は回数の差異を検知すること',
    ).toBe(true);
  });

  test('同じ URL を再取得してもリダイレクトループと誤判定しない', async ({ page }) => {
    // 3xx を伴わない同一 URL の再取得はループではない
    const entryUrl = `${config.environment.baseUrl}/lp/`;
    const tracker = new RedirectTracker(page);
    try {
      await page.goto(entryUrl);
      await page.goto(entryUrl);
      const trace = tracker.build(entryUrl, config.agencies.redirect.maxRedirects);
      expect(trace.loopDetected, '同一 URL の再取得はループではない').toBe(false);
    } finally {
      tracker.detach();
    }
  });

  test('代理店の組み合わせ検証に上限が効く (代理店数が多いサイトで破綻しない)', async () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      ...config.agencies.agencies[0],
      code: `CODE${String(index).padStart(3, '0')}`,
    }));

    const limited = agencyPairs(many, {
      ...config,
      runtime: { ...config.runtime, maxAgencyPairs: 30 },
    });
    expect(limited.length, '上限を超えないこと').toBe(30);
    expect(
      limited.every((pair) => pair.first.code !== pair.second.code),
      '同じ代理店同士の組み合わせを作らないこと',
    ).toBe(true);
    expect(
      new Set(limited.map((pair) => `${pair.first.code}->${pair.second.code}`)).size,
      '同じ組み合わせを重複させないこと',
    ).toBe(limited.length);

    // 上限内でも、どの代理店も少なくとも 1 回は現れること
    // (先頭の代理店だけを繰り返し使う実装だと検査の偏りが出る)
    const appeared = new Set(limited.flatMap((pair) => [pair.first.code, pair.second.code]));
    expect(appeared.size, '上限 30 でも 50 代理店すべてが登場すること').toBe(50);

    expect(
      agencyPairs(many, { ...config, runtime: { ...config.runtime, maxAgencyPairs: 0 } }).length,
      '0 を指定すると組み合わせ検証を行わないこと',
    ).toBe(0);
    expect(
      agencyPairs([config.agencies.agencies[0]], config).length,
      '代理店が 1 件なら組み合わせは作れないこと',
    ).toBe(0);
  });

  test('実行環境の一時的な通信断は Low として記録する (サイトの不具合と混同しない)', async ({ page }) => {
    const patterns = config.errors.transientNetworkPatterns ?? [];
    expect(patterns.length, 'config/errors.yml に transientNetworkPatterns が定義されていること').toBeGreaterThan(0);

    const monitor = new PageMonitor(page, config);
    monitor.detach();
    const documentUrl = `${config.environment.baseUrl}/lp/`;

    // Wi-Fi 切り替えなどで出るエラー (検査対象サイトの不具合ではない)
    monitor.consoleEntries.push({
      level: 'error',
      text: `Failed to load resource: net::${patterns[0]}`,
      url: documentUrl,
      location: 'https://example.com/tag.js:0:0',
    });
    monitor.requestFailures.push({
      url: 'https://example.com/tag.js',
      method: 'GET',
      resourceType: 'script',
      failure: `net::${patterns[0]}`,
      documentUrl,
    });
    // サイト側の本当のエラー (こちらは従来どおり High)
    monitor.consoleEntries.push({
      level: 'error',
      text: 'Uncaught TypeError: undefined is not a function',
      url: documentUrl,
    });

    const findings = monitor.toFindings();
    const transient = findings.filter((finding) => finding.actual?.includes(patterns[0]));
    expect(transient.length, '通信断は console / requestfailed の 2 件が記録されること').toBe(2);
    for (const finding of transient) {
      expect(finding.severity, '実行環境の通信断は Low であること').toBe('low');
      expect(finding.title, 'サイトの不具合ではないと分かる文言であること').toContain('実行環境');
    }

    const real = findings.find((finding) => finding.actual?.includes('Uncaught TypeError'));
    expect(real, 'サイト側のエラーは引き続き記録されること').toBeTruthy();
    expect(real?.severity, 'サイト側のエラーは既定 (High) のままであること').toBeUndefined();
  });

  test('エラーの代理店コードは発生した URL のコードと一致する', async ({ page }) => {
    const param = config.agency.paramName;
    const monitor = new PageMonitor(page, config);
    monitor.detach();

    const errorUrl = `${config.environment.baseUrl}/lp/?${param}=SELFCHECK-URL`;
    monitor.consoleEntries.push({ level: 'error', text: 'console error', url: errorUrl });
    monitor.pageErrors.push({ message: 'page error', url: errorUrl });
    monitor.networkErrors.push({
      url: `${config.environment.baseUrl}/missing.json`,
      status: 404,
      method: 'GET',
      resourceType: 'fetch',
      documentUrl: errorUrl,
    });
    // コードが URL に無いページ (リダイレクトで落ちた場合など) は検査文脈のコードを使う
    monitor.requestFailures.push({
      url: `${config.environment.baseUrl}/x.js`,
      method: 'GET',
      resourceType: 'script',
      failure: 'net::ERR_FAILED',
      documentUrl: `${config.environment.baseUrl}/lp/`,
    });

    const collector = new FindingCollector(config, {
      environment: config.environmentName,
      environmentLabel: config.environment.label,
      baseUrl: config.environment.baseUrl,
      browserId: 'chromium',
      deviceId: 'pc',
      deviceLabel: 'PC',
      agencyCode: 'SELFCHECK-CONTEXT',
    });
    collector.addAll(monitor.toFindings());

    const findings = collector.all;
    const fromUrl = findings.filter((finding) => finding.url.includes('SELFCHECK-URL'));
    expect(fromUrl.length, 'URL にコードがある 3 件が対象になること').toBe(3);
    for (const finding of fromUrl) {
      expect(
        finding.agencyCode,
        `代理店列と再現URLが一致すること: ${finding.title}`,
      ).toBe('SELFCHECK-URL');
    }

    const withoutParam = findings.find((finding) => finding.actual?.includes('ERR_FAILED'));
    expect(
      withoutParam?.agencyCode,
      'URL にコードが無い場合は検査文脈のコードを使うこと',
    ).toBe('SELFCHECK-CONTEXT');
  });

  test('ページ間の表記揺れを検出できる', async () => {
    const rule = config.text.unifyRules.find(
      (entry) => !entry.detectOnly && entry.preferred && entry.variants.length > 0,
    );
    test.skip(!rule, '表記統一ルールが設定されていません');

    // 同じ意味の語がページごとに異なる表記になっている状態
    const inconsistent = [
      { pageId: 'page-a', text: `こちらから${rule!.preferred}ください。` },
      { pageId: 'page-b', text: `こちらから${rule!.variants[0]}ください。` },
    ];
    const findings = detectCrossPageInconsistency(inconsistent, config);
    expect(findings.length, 'ページ間の不統一が検出されること').toBeGreaterThan(0);
    expect(findings[0].actual, 'どのページで使われているかが示されること').toContain('page-a');
    expect(findings[0].actual, 'どのページで使われているかが示されること').toContain('page-b');

    // 全ページで統一されている場合は検出しない
    const consistent = [
      { pageId: 'page-a', text: `こちらから${rule!.preferred}ください。` },
      { pageId: 'page-b', text: `こちらも${rule!.preferred}ください。` },
    ];
    const noFindings = detectCrossPageInconsistency(consistent, config).filter(
      (finding) => finding.title.includes(rule!.id),
    );
    expect(noFindings, '統一されていれば検出しないこと').toEqual([]);
  });
});
