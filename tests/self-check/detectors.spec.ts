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
import { capturePageSignatureStable, compareVisibleBlocks, diffSignatures, evaluateDisplayDifference, matchesIgnoreKey, toSelectorHint, visibleBlockKeys } from '../../utils/page-signature';
import { agencyPairs, agencySpecs, resolvePerProfile, verifyNoOtherAgencyInfo, verifyDisplayRules, verifySections, verifyTexts } from '../../utils/agency';
import {
  describeApplicationLinks, installRequestGuards, observeApplicationLinks,
  observeCodeInApplication, verifyCodeApplied, verifyCodeCarried,
} from '../../utils/handoff';
import { maskText, maskUrl } from '../../utils/secrets';
import { buildProjects, deviceUse } from '../../utils/projects';
import { pagesFromSitemap, resolvePages, sitemapPageId } from '../../utils/page-source';
import { detectCrossPageInconsistency } from '../../utils/text-rules';
import { collectLinks } from '../../utils/links';
import { applyKnownIssue } from '../../utils/known-issues';
import { startClean } from '../../utils/agency-entry';
import { buildAgencyRows } from '../../reporters/qa-html-reporter';
import { CHECK_COLUMNS, buildChecklist } from '../../utils/checklist';
import type { CheckId, FindingCategory, KnownIssuesFile, RedirectTrace, Severity } from '../../utils/types';

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
      width: 1200,
      height: visible ? 200 : 0,
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

  test('目に見えていない要素は「表示」として数えない (見えない差分の誤報告防止)', async ({ page }) => {
    // 高さ 0 のバナー枠・カルーセルの画面外スライドなどは DOM にあっても
    // 利用者には見えていない。これを表示として数えると
    // 「画面上には見えないのに表示差分として報告される」ことになる。
    await page.goto('/broken/invisible-blocks.html');
    const signature = await capturePageSignatureStable(page);
    expect(signature, 'シグネチャを取得できること').not.toBeNull();

    const find = (key: string) => signature!.blocks.find((block) => block.key === key);
    const hidden = [
      'banner-in-collapsed',
      'banner-clipped',
      'slide-hidden',
      'section-faded',
      'aria-hidden-section',
    ];
    for (const key of hidden) {
      const block = find(key);
      expect(block, `${key} が取得できること`).toBeTruthy();
      expect(block?.visible, `${key} は見えていないと判定されること`).toBe(false);
      expect(block?.hiddenReason, `${key} の理由が記録されること (${block?.hiddenReason})`).toBeTruthy();
    }

    for (const key of ['visible-section', 'slide-visible']) {
      const block = find(key);
      expect(block?.visible, `${key} は表示と判定されること`).toBe(true);
      expect(block?.height, `${key} の高さが記録されること`).toBeGreaterThan(0);
    }

    // 見えていない要素は表示差分の比較対象にも入らない
    const keys = visibleBlockKeys(signature!);
    for (const key of hidden) {
      expect(keys, `${key} は表示差分の比較に含めないこと`).not.toContain(key);
    }
  });

  test('申込サイトへの導線を DOM から観測できる (引き継ぎ方式が未確定でも記録する)', async ({ page }) => {
    const param = config.agency.paramName;
    await page.goto(`/lp/?${param}=A001`);
    await page.waitForLoadState('load');

    const links = await observeApplicationLinks(page, config, 'A001');
    expect(links.length, '申込サイトへのリンクを見つけること').toBeGreaterThan(0);
    expect(
      links.some((link) => link.text.length > 0),
      'ボタンの表示文言を記録すること (設定を実物に合わせるため)',
    ).toBe(true);
    expect(
      links.some((link) => link.hasCode),
      'クエリ方式ならリンクに代理店コードが乗っていることを検出する',
    ).toBe(true);

    const findings = describeApplicationLinks(links, config, 'A001', page.url());
    expect(findings.length, '記録が 1 件出ること').toBe(1);
    expect(findings[0].severity, '観測結果は Low で記録すること').toBe('low');
    expect(findings[0].title, '確認できたことが分かる文言であること').toContain('[確認OK]');

    // 導線が無いページでは「断定せず記録する」(JavaScript 遷移の可能性があるため)
    await page.goto('/broken/blank.html');
    const none = describeApplicationLinks(
      await observeApplicationLinks(page, config, 'A001'),
      config,
      'A001',
      page.url(),
    );
    expect(none.length, '見つからない事実を記録すること').toBe(1);
    expect(none[0].severity, '推測で Critical を出さないこと').toBe('medium');
    expect(none[0].detail, '次に何をすればよいか示すこと').toContain('discover');
  });

  test('表示が安定するまで待ち、揺れている要素は差分にしない (実行タイミングによる誤検知防止)', async ({ page }) => {
    // 遅延読み込みのバナーやアニメーションは、取得した瞬間によって
    // 「表示されている / されていない」が変わる。1 回しか取らないと
    // その揺れを「代理店による表示の違い」として報告してしまう。
    await page.goto('/broken/late-render.html');
    const signature = await capturePageSignatureStable(page);
    expect(signature, 'シグネチャを取得できること').not.toBeNull();

    const unstable = signature!.unstableKeys ?? [];
    expect(unstable, '点滅する要素は「安定しない」と記録されること').toContain('blinking');

    // 除外された要素は比較対象に入らない
    const keys = visibleBlockKeys(signature!);
    expect(keys, '安定しない要素は比較しないこと').not.toContain('blinking');
    expect(keys, '安定している要素は比較対象に残ること').toContain('always-visible');

    // 遅れて開くバナーは、待った結果「表示されている」として確定する
    const banner = signature!.blocks.find((block) => block.key === 'late-banner-inner');
    expect(banner?.visible, '遅れて表示される要素も待って捉えること').toBe(true);

    // 揺れている要素は 2 ページの比較にも出てこない
    const other = await capturePageSignatureStable(page);
    const difference = evaluateDisplayDifference(signature!, other!);
    expect(
      [...difference.onlyInA, ...difference.onlyInB],
      '同じページを 2 回取っただけで差分が出ないこと',
    ).not.toContain('blinking');
  });

  test('「コードなしと同じ表示」の検査が差分を見逃さない (見逃しの確認)', async ({ page }) => {
    const param = config.agency.paramName;

    // コードなしの表示 (基準)
    await page.goto('/lp/');
    const baseline = await capturePageSignatureStable(page);

    // 支店コード相当 (受け取るが何もしない) は基準と一致するはず
    await page.goto(`/lp/?${param}=A001BR01`);
    const branch = await capturePageSignatureStable(page);
    expect(
      evaluateDisplayDifference(baseline!, branch!).differs,
      '何もしないコードはコードなしと同じ表示になること',
    ).toBe(false);

    // 無効コード (案内が出る) は差分として検出できるはず
    await page.goto(`/lp/?${param}=NOSUCHCODE`);
    const invalid = await capturePageSignatureStable(page);
    const difference = evaluateDisplayDifference(baseline!, invalid!);
    expect(difference.differs, '表示が変わったら検出すること').toBe(true);
    expect(
      [...difference.onlyInB, ...difference.textOnlyInB].join(' '),
      '何が変わったか分かること',
    ).toContain('fallback-notice');
  });

  test('除外指定はパターンでも書ける (月ごとに id が変わる要素を除外する)', async () => {
    // 公開前のキャンペーンバナーは id に年月が入る (#lf-campaign-banner-202609-1)。
    // 毎月設定を書き換えずに除外できないと、運用が続かない。
    const block = (key: string) => ({
      key,
      keyKind: 'id' as const,
      visible: true,
      width: 1440,
      height: 292,
      textSample: '',
      textLength: 0,
    });
    const signature = {
      url: 'https://example.test/lp/service/',
      blocks: [block('#lf-campaign-banner-202609-1'), block('#lf-campaign-banner-202610-3'), block('#main-hero')],
      textLines: [],
    };

    const patterns = ['css=#lf-campaign-banner-*'];
    expect(matchesIgnoreKey('#lf-campaign-banner-202609-1', patterns), 'パターンで除外できること').toBe(true);
    expect(matchesIgnoreKey('#lf-campaign-banner-202610-3', patterns), '翌月の id も除外できること').toBe(true);
    expect(matchesIgnoreKey('#main-hero', patterns), '関係ない要素は除外しないこと').toBe(false);

    const keys = visibleBlockKeys(signature, patterns);
    expect(keys, '除外した要素は比較対象に入らないこと').toEqual(['#main-hero']);

    // 完全一致の指定も従来どおり使える
    expect(visibleBlockKeys(signature, ['#main-hero']).length, '完全一致の指定も使えること').toBe(2);
  });

  test('既知の不具合は修正日まで Low に落とし、修正日を過ぎたら元の重大度で報告する', async () => {
    // 既知の不具合を毎回 Critical で出すと本当の異常が埋もれる。
    // かといって期待結果を現状に書き換えると、直ったことも
    // 壊れ直したことも分からなくなる。そのため検知結果だけを切り替える。
    const known: KnownIssuesFile = {
      knownIssues: [
        {
          id: 'selfcheck-branch',
          title: '支店コードが親コードとして扱われない',
          fixedOn: '2026-09-03',
          codes: ['selfcheckbr*'],
          categories: ['agency-display'],
        },
      ],
    };
    const withKnown: typeof config = { ...config, knownIssues: known };
    const finding = {
      severity: 'critical' as const,
      category: 'agency-display' as const,
      title: 'みらやく × なのに表示されています',
      url: 'https://example.test/lp/service/',
      agencyCode: 'selfcheckbr01',
    };

    // 修正日より前 → Low に落とし、既知であることと本来の重大度を残す
    const before = applyKnownIssue(finding, withKnown, new Date('2026-08-20T00:00:00'));
    expect(before.severity, '修正日より前は Low に落とすこと').toBe('low');
    expect(before.title, '既知だと分かる表示にすること').toContain('既知');
    expect(before.detail, '本来の重大度を残すこと').toContain('critical');

    // 修正日以降 → 元の重大度で報告する (直っていなければその日から Critical)
    const after = applyKnownIssue(finding, withKnown, new Date('2026-09-03T09:00:00'));
    expect(after.severity, '修正日以降は元の重大度で報告すること').toBe('critical');
    expect(after.title, '既知の表示を付けないこと').not.toContain('既知');

    // 対象外の代理店コードは落とさない (別の代理店の不具合を見逃さない)
    const otherCode = applyKnownIssue(
      { ...finding, agencyCode: 'littlefamily12' },
      withKnown,
      new Date('2026-08-20T00:00:00'),
    );
    expect(otherCode.severity, '対象外のコードは落とさないこと').toBe('critical');

    // 対象外の種別は落とさない (同じ代理店の別の不具合を見逃さない)
    const otherCategory = applyKnownIssue(
      { ...finding, category: 'js-error' as const },
      withKnown,
      new Date('2026-08-20T00:00:00'),
    );
    expect(otherCategory.severity, '対象外の種別は落とさないこと').toBe('critical');

    // 収集経路にも効いていること (レポートに Low として載る)
    const collector = new FindingCollector(withKnown, {
      environment: config.environmentName,
      environmentLabel: config.environment.label,
      baseUrl: config.environment.baseUrl,
      browserId: 'chromium',
      deviceId: 'pc',
      deviceLabel: 'PC',
      agencyCode: 'selfcheckbr01',
    });
    collector.add({ category: 'agency-display', title: 'みらやく × なのに表示されています' });
    expect(collector.blocking, '既知の不具合は CI を失敗させないこと').toEqual([]);
    expect(collector.all[0]?.severity, 'レポートには Low として載ること').toBe('low');

    // 実際の設定ファイルが読めること (書式ミスの検知)
    for (const issue of config.knownIssues?.knownIssues ?? []) {
      expect(issue.id, '既知の不具合に id があること').toBeTruthy();
      expect(issue.categories.length, '対象の種別が指定されていること').toBeGreaterThan(0);
      if (issue.fixedOn) {
        expect(
          Number.isNaN(new Date(`${issue.fixedOn}T00:00:00`).getTime()),
          `fixedOn が日付として読めること: ${issue.id}`,
        ).toBe(false);
      }
    }
  });

  test('代理店コードごとの一覧表を組み立てられる (レポートの見出し部分)', async () => {
    // 「今回どのコードを検査して、それぞれどうだったか」を 1 画面で見るための表。
    // 抽選で毎回対象が変わるため、検知が無いコードも行として残す必要がある。
    const record = (agencyCode: string, findings: Array<{ category: FindingCategory; severity: Severity }>) => ({
      testId: `t-${agencyCode}-${findings.length}`,
      testTitle: 'self check',
      suite: 'self check',
      environment: 'local',
      environmentLabel: 'ローカル',
      baseUrl: 'http://127.0.0.1:4173',
      browserId: 'chromium',
      deviceId: 'pc',
      deviceLabel: 'PC',
      agencyCode,
      status: 'passed' as const,
      durationMs: 1,
      startedAt: new Date().toISOString(),
      findings: findings.map((entry) => ({
        ...entry,
        title: 'self check',
        url: 'http://127.0.0.1:4173/lp/',
        agencyCode,
      })),
    });

    const rows = buildAgencyRows([
      record('A001', []),
      record('A002', [
        { category: 'agency-display', severity: 'medium' },
        { category: 'agency-redirect', severity: 'critical' },
      ]),
      record('A003', [{ category: 'js-error', severity: 'high' }]),
      record('none', [{ category: 'js-error', severity: 'critical' }]),
    ]);

    expect(
      rows.map((row) => row.code),
      '重大度の重い順に並び、コードなしは含めないこと',
    ).toEqual(['A002', 'A003', 'A001']);

    const a002 = rows.find((row) => row.code === 'A002');
    expect(a002?.cells.redirect, 'リダイレクトの列に反映されること').toBe('critical');
    expect(a002?.cells.display, '表示の列に反映されること').toBe('medium');
    expect(a002?.counts.redirect, '件数を数えること').toBe(1);

    const a003 = rows.find((row) => row.code === 'A003');
    expect(a003?.cells.error, 'エラーの列に反映されること').toBe('high');

    const a001 = rows.find((row) => row.code === 'A001');
    expect(a001?.worst, '検知が無ければ問題なしとすること').toBeNull();
    expect(
      Object.values(a001?.cells ?? {}).every((value) => value === null),
      '検知が無いコードも行として残すこと (確認済みを示すため)',
    ).toBe(true);
  });

  test('代理店コードの付与を判定できる (リダイレクト後に URL から消えても)', async ({ page }) => {
    // カカクコムは専用 LP へリダイレクトされ、そのとき URL からコードが消える。
    // 「URL にコードがある」で判定すると、正常な状態を不具合として報告してしまう。
    const param = config.agency.paramName;

    // A002 でいったん流入して保存させ、そのうえで URL にコードを付けずに開く。
    // これが「リダイレクト後にコードが URL から消えた状態」と同じ条件になる。
    await page.goto(`/lp/?${param}=A002`);
    await page.waitForURL(/\/partner\/a002\//, { timeout: 10000 });
    await page.waitForLoadState('load');
    await page.goto('/partner/a002/');
    await page.waitForLoadState('load');
    expect(page.url(), 'URL にコードが載っていない状態にすること').not.toContain('A002');

    const applied = await observeCodeInApplication(page, config, 'A002');
    expect(
      applied.foundIn.length,
      `URL 以外の置き場所から付与を検出できること: ${JSON.stringify(applied)}`,
    ).toBeGreaterThan(0);
    const ok = verifyCodeApplied(applied, 'A002', 'A002');
    expect(ok[0]?.severity, '付与されていれば Low (記録) であること').toBe('low');
    expect(ok[0]?.checkId, 'チェックリストの列に載ること').toBe('code-applied');

    // 付与されていない場合は検出する (見逃しの確認)
    const missing = verifyCodeApplied(
      { foundIn: [], hints: ['insAgentNo という項目がある'], otherCodes: [], url: page.url() },
      'A002',
      'A002',
    );
    expect(missing[0]?.severity, '付与されていなければ Critical').toBe('critical');
    expect(missing[0]?.detail, '入れ物だけの状態は参考情報として示すこと').toContain('insAgentNo');
  });

  test('前回の代理店コードが残っていたら、消したうえで報告する (見逃しの防止)', async ({ qa, page, context }) => {
    // 代理店コードは Cookie / localStorage に保存され、次に開いたページを
    // その代理店として表示する。前の検査の状態が残っていると、
    // コードが付与されていない場合でも「付与されている」と判定してしまう。
    // 残留状態は**不具合を隠す**ため、検知が無いことを合格の根拠にしている
    // チェックリストでは特に危険。

    // 状態を作る (前の検査が残した状況を再現する)
    await page.goto(`/lp/?${config.agency.paramName}=A001`);
    await page.waitForLoadState('load');
    expect((await context.cookies()).length, '状態が作られたこと').toBeGreaterThan(0);
    expect(
      await page.evaluate(() => window.localStorage.getItem('agency_code')),
      '保存領域にもコードがあること',
    ).toBe('A001');

    // まっさらから始める処理が、残留に気づいて報告し、そのうえで消すこと
    const findings = await startClean(qa);
    expect(findings.length, '黙って消さずに報告すること').toBe(1);
    expect(
      findings[0].severity,
      '残留は他の結果を信頼できなくするため Critical であること',
    ).toBe('critical');
    expect(findings[0].actual, '何が残っていたか分かること').toContain('agency_code');
    expect(findings[0].title, 'サイトの不具合と区別できること').toContain('検査環境');

    expect((await context.cookies()).length, 'Cookie が消えていること').toBe(0);
    expect(
      await page.evaluate(() => window.localStorage.getItem('agency_code')),
      '保存領域も消えていること',
    ).toBeNull();

    // 消したあとに通常 LP を開くと代理店として扱われないこと
    // (= 残留による誤った合格が起きない状態になっている)
    await page.goto('/lp/');
    await page.waitForLoadState('load');
    const body = await page.evaluate(() => document.body.innerText);
    expect(body.includes('募集代理店'), 'コードなしの表示に戻ること').toBe(false);

    // 同じテストの 2 回目以降は「続き」として何もしない
    // (別コードでの再流入・再訪リダイレクトは前の状態が必要な検査のため)
    await page.goto(`/lp/?${config.agency.paramName}=A002`);
    await page.waitForLoadState('load');
    expect(await startClean(qa), '2 回目は状態を消さないこと').toEqual([]);
    expect(
      await page.evaluate(() => window.localStorage.getItem('agency_code')),
      '2 回目の呼び出しで状態を壊さないこと',
    ).toBe('A002');
  });

  test('チェックリスト表を組み立てられる (ダッシュボードの本体)', async () => {
    // 表 = PC / SP それぞれ 1 枚、行 = 代理店、セル = あり / なし。
    //
    // ここで最も重要なのは「検知が無いこと」を合格にしないこと。
    // 検査が動いていないだけの状態を「問題なし」と見せると、
    // 不具合を見逃したまま OK と表示してしまう。
    const record = (
      agencyCode: string,
      deviceId: string,
      findings: Array<{ checkId: CheckId; observedValue: string; expectedValue: string | null; severity: Severity }>,
    ) => ({
      testId: `t-${agencyCode}-${deviceId}`,
      testTitle: 'self check',
      suite: 'self check',
      environment: 'local',
      environmentLabel: 'ローカル',
      baseUrl: 'http://127.0.0.1:4173',
      browserId: 'chromium',
      deviceId,
      deviceLabel: deviceId.toUpperCase(),
      agencyCode,
      status: 'passed' as const,
      durationMs: 1,
      startedAt: new Date().toISOString(),
      findings: findings.map((entry) => ({
        ...entry,
        category: 'agency-display' as FindingCategory,
        title: 'self check',
        url: 'http://127.0.0.1:4173/lp/',
        agencyCode,
        deviceId,
      })),
    });

    const meta = {
      A001: { company: '株式会社エーワン保険サービス', mirayaku: '○', pattern: 'みらやく○', agency: true },
      A003: {
        company: 'シースリー少額短期保険株式会社',
        mirayaku: '×',
        pattern: 'みらやく× (br)',
        effectiveFrom: '2026-09-03',
        agency: true,
      },
    };

    const checklist = buildChecklist(
      [
        record('A001', 'pc', [
          { checkId: 'header-name', observedValue: 'あり', expectedValue: 'あり', severity: 'low' },
          { checkId: 'anshin-pack', observedValue: 'あり', expectedValue: 'あり', severity: 'low' },
          { checkId: 'storage', observedValue: 'Cookie+LS', expectedValue: null, severity: 'low' },
        ]),
        // 同じ代理店でも PC と SP で結果が違うことがある
        record('A001', 'sp', [
          { checkId: 'header-name', observedValue: 'なし', expectedValue: 'あり', severity: 'critical' },
        ]),
        record('A003', 'pc', [
          { checkId: 'anshin-pack', observedValue: 'あり', expectedValue: 'なし', severity: 'critical' },
        ]),
      ],
      meta,
      ['みらやく○', 'みらやく× (br)', 'カカクコム'],
    );

    expect(
      checklist.columns.map((column) => column.key),
      '列が検査項目であること',
    ).toEqual(CHECK_COLUMNS.map((column) => column.key));

    expect(
      checklist.tables.map((table) => table.deviceId),
      'PC と SP を別の表にすること (端末で挙動が違ったとき切り分けられるように)',
    ).toEqual(['pc', 'sp']);

    const pc = checklist.tables[0];
    const a001pc = pc.rows.find((row) => row.code === 'A001');
    expect(a001pc?.pattern, 'パターン名を出せること').toBe('みらやく○');
    expect(a001pc?.cells['header-name'].state, '期待どおりなら ok').toBe('ok');
    expect(a001pc?.cells['header-name'].observed, '見えた値をそのまま出すこと').toBe('あり');
    expect(a001pc?.failed, '問題が無ければ failed でないこと').toBe(false);
    // 検査していない項目を合格にしてはならない
    expect(a001pc?.cells.redirect.state, '検査していない項目は none (—)').toBe('none');
    expect(a001pc?.cells['code-carry'].state, '検査していない項目は none (—)').toBe('none');
    // 正解が未確定の項目は赤にしない
    expect(a001pc?.cells.storage.state, '正解が未確定なら info (表示だけ)').toBe('info');
    expect(a001pc?.cells.storage.observed, '保存先を出せること').toBe('Cookie+LS');

    // SP だけ落ちている場合、SP の表だけ赤になる
    const sp = checklist.tables[1];
    const a001sp = sp.rows.find((row) => row.code === 'A001');
    expect(a001sp?.cells['header-name'].state, 'SP で期待と違えば ng').toBe('ng');
    expect(a001sp?.cells['header-name'].observed, '実際の値を出すこと').toBe('なし');
    expect(a001sp?.cells['header-name'].expected, '期待値も出すこと').toBe('あり');
    expect(a001sp?.failed, '1 つでも ng なら failed').toBe(true);
    expect(a001pc?.failed, 'PC 側は影響を受けないこと').toBe(false);

    const a003 = pc.rows.find((row) => row.code === 'A003');
    expect(a003?.cells['anshin-pack'].state, 'みらやく× で表示があれば ng').toBe('ng');
    expect(a003?.effectiveFrom, '支店コードは有効になる日を出すこと').toBe('2026-09-03');
    expect(pc.rows[0]?.code, '問題のある代理店を先に出すこと').toBe('A003');

    expect(
      checklist.missingPatterns.map((entry) => entry.pattern),
      '検査されなかったパターンを示すこと (抽選漏れか代理店が無いかを判断できるように)',
    ).toEqual(['カカクコム']);
  });

  test('安全装置による遮断を不具合として報告しない (自作自演の防止)', async ({ page }) => {
    // 読み取り専用の環境では、このツールが GET 以外のリクエストを止める。
    // ブラウザはそれを「読み込み失敗」としてコンソールに出すが、
    // サイトの不具合ではない。1 件ずつ報告すると数千件になり本当の不具合が埋もれる。
    const readOnlyConfig = {
      ...config,
      environment: { ...config.environment, readOnly: true },
    };
    const monitor = new PageMonitor(page, readOnlyConfig);
    await installRequestGuards(page, readOnlyConfig);
    await page.goto('/broken/noisy-errors.html');
    await page.waitForTimeout(1200);
    monitor.detach();

    const findings = monitor.toFindings();

    // 遮断は「不具合」として出さない
    const blockedAsError = findings.filter(
      (finding) => finding.category === 'js-error' && /ERR_BLOCKED_BY_CLIENT/.test(finding.actual ?? ''),
    );
    expect(blockedAsError, '遮断を JavaScript エラーとして報告しないこと').toEqual([]);

    // まとめて 1 件の Low として記録する
    const summary = findings.filter((finding) => finding.title.includes('安全装置'));
    expect(summary.length, '遮断はまとめて 1 件にすること').toBe(1);
    expect(summary[0].severity, '安全装置による遮断は Low であること').toBe('low');
    expect(summary[0].actual, '遮断した件数が分かること').toMatch(/[0-9]+ 件/);
  });

  test('同じ内容のエラーはまとめる (大量発生でも実行が止まらない)', async ({ page }) => {
    const monitor = new PageMonitor(page, config);
    await page.goto('/broken/noisy-errors.html');
    await page.waitForTimeout(1200);
    monitor.detach();

    const repeated = monitor.consoleEntries.filter((entry) => entry.text.includes('repeated error for dedupe check'));
    expect(repeated.length, '同じ内容は 1 件にまとめること').toBe(1);
    expect(repeated[0].count, '件数を数えること').toBeGreaterThan(50);
    expect(
      monitor.consoleEntries.length,
      `記録する種類に上限を設けること (現在 ${monitor.consoleEntries.length} 種類)`,
    ).toBeLessThanOrEqual(config.errors.maxDistinctMessages ?? 50);

    const finding = monitor.toFindings().find((entry) => /repeated error/.test(entry.actual ?? ''));
    expect(finding?.actual, '件数をレポートに出すこと').toContain('同じ内容が');
  });

  test('他社タグの中のエラーは Critical / High で報告しない', async ({ page }) => {
    // 計測タグ・解析タグの内部エラーは自社コードの不具合ではない。
    // 無視もしない (表示を壊すことがあるため記録する)。
    const monitor = new PageMonitor(page, config);
    monitor.detach();
    const documentUrl = `${config.environment.baseUrl}/lp/`;

    monitor.pageErrors.push({
      message: "Cannot read properties of undefined (reading 'unshift')",
      stack: "TypeError\n    at <anonymous> (https://www.clarity.ms/tag/uet/97031584:0:579)",
      url: documentUrl,
      count: 1,
    });
    monitor.consoleEntries.push({
      level: 'error',
      text: 'Failed to load resource: 403',
      url: documentUrl,
      location: 'https://pagesense-collect.example.jp/pslog.gif:0:0',
      count: 1,
    });
    // 自社ドメインのスクリプトのエラーは従来どおり (既定の重大度)
    monitor.consoleEntries.push({
      level: 'error',
      text: 'Uncaught TypeError: own script broke',
      url: documentUrl,
      location: `${config.environment.baseUrl}/assets/agency.js:10:1`,
      count: 1,
    });

    const findings = monitor.toFindings();
    const thirdParty = findings.filter((finding) => finding.title.includes('他社タグ'));
    expect(thirdParty.length, '他社タグ由来の 2 件が区別されること').toBe(2);
    for (const finding of thirdParty) {
      expect(finding.severity, '他社タグのエラーは Low であること').toBe('low');
    }

    const own = findings.find((finding) => /own script broke/.test(finding.actual ?? ''));
    expect(own, '自社コードのエラーは記録されること').toBeTruthy();
    expect(own?.severity, '自社コードのエラーは既定 (High) のままであること').toBeUndefined();
  });

  test('検査する件数を実行ごとに変えられる (最小から始めて増やす)', async () => {
    // 導入中は最小の件数で「ツールが正しく動くか」を確定させたい。
    // 設定ファイルを書き換えずに切り替えられる必要がある。
    const original = process.env.QA_AGENCY_PER_PROFILE;
    try {
      delete process.env.QA_AGENCY_PER_PROFILE;
      expect(resolvePerProfile(3), '指定が無ければ設定値を使うこと').toBe(3);

      process.env.QA_AGENCY_PER_PROFILE = '1';
      expect(resolvePerProfile(3), '指定があれば設定値より優先すること').toBe(1);

      process.env.QA_AGENCY_PER_PROFILE = '5';
      expect(resolvePerProfile(1), '増やす方向にも効くこと').toBe(5);

      for (const invalid of ['0', '-1', '1.5', 'all', 'abc']) {
        process.env.QA_AGENCY_PER_PROFILE = invalid;
        expect(
          () => resolvePerProfile(3),
          `不正な指定は理由を示して止めること: ${invalid}`,
        ).toThrow(/QA_AGENCY_PER_PROFILE/);
      }
    } finally {
      if (original === undefined) delete process.env.QA_AGENCY_PER_PROFILE;
      else process.env.QA_AGENCY_PER_PROFILE = original;
    }
  });

  test('必ず検査するコードは件数や抽選に関係なく毎回選ばれる', async () => {
    // カカクコム (littlefamily03) のように運用上必ず確認したいコードは、
    // 件数を最小にしても抽選の結果に左右されず対象に入る必要がある。
    // 実サイトの設定に依存しないよう、検査用の設定を組み立てて確認する。
    const template = config.agencies.agencies[0];
    const make = (code: string, profile: string): typeof template => ({ ...template, code, profile });
    const agencies = [
      make('MUST-KAKAKUCOM', 'kakakucom'),
      make('MUST-DIRECT', 'direct'),
      ...Array.from({ length: 20 }, (_, index) => make(`OTHER-${index}`, 'mirayaku-hidden')),
      ...Array.from({ length: 20 }, (_, index) => make(`VISIBLE-${index}`, 'mirayaku-visible')),
    ];
    const target: typeof config = {
      ...config,
      agencies: {
        ...config.agencies,
        agencies,
        scope: { mode: 'sample', perProfile: 1, always: ['MUST-KAKAKUCOM', 'MUST-DIRECT'] },
      },
    };

    const originalSeed = process.env.QA_AGENCY_SEED;
    const originalPer = process.env.QA_AGENCY_PER_PROFILE;
    try {
      for (const seed of ['seed-a', 'seed-b', 'seed-c']) {
        for (const perProfile of ['1', '3']) {
          process.env.QA_AGENCY_SEED = seed;
          process.env.QA_AGENCY_PER_PROFILE = perProfile;
          const codes = agencySpecs(target).map((spec) => spec.code);
          for (const code of ['MUST-KAKAKUCOM', 'MUST-DIRECT']) {
            expect(codes, `${code} は seed=${seed} / 件数=${perProfile} でも対象になること`).toContain(code);
          }
        }
      }
      // 実サイトの設定でもカカクコムが必ず入る指定になっていること
      if (config.environmentName !== 'local') {
        expect(config.agencies.scope?.always ?? [], 'カカクコムを必ず検査する設定であること').toContain(
          'littlefamily03',
        );
      }
    } finally {
      if (originalSeed === undefined) delete process.env.QA_AGENCY_SEED;
      else process.env.QA_AGENCY_SEED = originalSeed;
      if (originalPer === undefined) delete process.env.QA_AGENCY_PER_PROFILE;
      else process.env.QA_AGENCY_PER_PROFILE = originalPer;
    }
  });

  test('代理店コードには会社名と みらやく掲載可否が付いている', async () => {
    // コードだけでは人が判断できないため、レポートと画面に会社名と
    // みらいの約束の掲載可否 (○ / ×) を出せる必要がある。
    const specs = agencySpecs(config);
    for (const spec of specs) {
      expect(spec.company, `${spec.code} に会社名があること`).toBeTruthy();
    }
    for (const spec of specs) {
      expect(
        ['○', '×'],
        `${spec.code} の みらやく掲載可否が ○ か × であること (実際: ${spec.mirayaku})`,
      ).toContain(spec.mirayaku);
    }
  });

  test('代理店名の欠落と「あんしんパック」の出しすぎを検出できる (中心的な仕様)', async ({ page }) => {
    // このサイトの中心的な仕様は 3 点で、いずれも文言で判定できる。
    //   1. カカクコムは専用 LP へリダイレクトする (@redirect で検査)
    //   2. みらやく可否に関わらず、代理店名がヘッダーとフッターに出る
    //   3. みらやく不可の代理店は「あんしんパック」の記載が一切ない
    const param = config.agency.paramName;

    // みらやく可の代理店 (A001): 代理店名と あんしんパック の両方がある
    await page.goto(`/lp/?${param}=A001`);
    await page.waitForLoadState('load');
    const company = '株式会社エーワン保険サービス';
    const ok = await verifyDisplayRules(
      page,
      config,
      { company, agencyName: 'shown', anshinPack: 'present' },
      'A001',
    );
    expect(
      ok.filter((finding) => finding.severity === 'critical'),
      `正しい状態では検知しないこと: ${JSON.stringify(ok)}`,
    ).toEqual([]);
    expect(
      ok.map((finding) => finding.checkId).sort(),
      '3 項目すべての結果が返ること',
    ).toEqual(['anshin-pack', 'footer-name', 'header-name']);

    // 代理店名が出ていない場合は検出する (見逃しの確認)
    const missing = await verifyDisplayRules(
      page,
      config,
      { company: '出るはずのない会社', agencyName: 'shown', anshinPack: 'ignore' },
      'A001',
    );
    const missingCritical = missing.filter((finding) => finding.severity === 'critical');
    expect(missingCritical.length, 'ヘッダーとフッターの両方で検出すること').toBe(2);
    expect(
      missingCritical.map((finding) => finding.checkId).sort(),
      'どの項目が欠けているか分かること',
    ).toEqual(['footer-name', 'header-name']);

    // みらやく不可の扱い: 「あんしんパック」があれば検出する
    const forbidden = await verifyDisplayRules(
      page,
      config,
      { company, agencyName: 'shown', anshinPack: 'absent' },
      'A001 をみらやく不可として扱った場合',
    );
    const anshin = forbidden.find((finding) => finding.checkId === 'anshin-pack');
    expect(anshin?.severity, 'コンプライアンスに直結するため Critical であること').toBe('critical');
    expect(anshin?.actual, 'どの文言が出ているか分かること').toContain('あんしんパック');

    // みらやく不可の代理店 (A003): あんしんパック が無く、代理店名は出る。
    // A003 は meta refresh で専用 LP へ移るため、遷移の完了を待つ
    await page.goto(`/lp/?${param}=A003`);
    await page.waitForURL(/\/partner\/a003\//, { timeout: 10000 });
    await page.waitForLoadState('load');
    const hidden = await verifyDisplayRules(
      page,
      config,
      { company: 'シースリー少額短期保険株式会社', agencyName: 'shown', anshinPack: 'absent' },
      'A003',
    );
    expect(
      hidden.filter((finding) => finding.severity === 'critical'),
      `みらやく不可の代理店で検知しないこと: ${JSON.stringify(hidden)}`,
    ).toEqual([]);

    // コードなしでは代理店名が出ない。
    // 直前の検査でコードが保存されているため、消してから確認する
    // (保存値からの復元は仕様どおりの動作)
    await page.context().clearCookies();
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.goto('/lp/');
    await page.waitForLoadState('load');
    const noCode = await verifyDisplayRules(page, config, { agencyName: 'hidden' }, 'コードなし');
    expect(
      noCode.filter((finding) => finding.severity === 'critical'),
      'コードなしで代理店名が出ないこと',
    ).toEqual([]);
  });

  test('申込フォームでコードが維持されているかを判定できる (方式を問わない)', async ({ page }) => {
    // 引き継ぎ方式 (クエリ / hidden / Cookie / セッション / API) が
    // 未確定でも「維持されているか」は検査できる必要がある。
    const param = config.agency.paramName;
    const application = config.environment.applicationBaseUrl;
    test.skip(!application, '申込ドメインが未設定です');

    // クエリでコードが渡っている場合 = 維持されている
    await page.goto(`${application}/entry/?${param}=A001`);
    await page.waitForLoadState('load');
    const carried = await observeCodeInApplication(page, config, 'A001', ['A002', 'A003']);
    expect(carried.foundIn.length, `どこかに残っていることを検出する: ${JSON.stringify(carried)}`).toBeGreaterThan(0);
    expect(carried.otherCodes, '別の代理店コードは現れないこと').toEqual([]);

    const ok = verifyCodeCarried(carried, 'A001', 'A001');
    expect(ok.length, '記録が 1 件出ること').toBe(1);
    expect(ok[0].severity, '維持されていれば Low (記録) であること').toBe('low');
    expect(ok[0].title, '確認できたと分かること').toContain('[確認OK]');

    // コードが渡っていない場合 = 維持されていない (Critical)
    await page.context().clearCookies();
    await page.goto(`${application}/entry/`);
    await page.waitForLoadState('load');
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.reload();
    await page.waitForLoadState('load');
    const dropped = await observeCodeInApplication(page, config, 'A001');
    expect(dropped.foundIn, `残っていないことを検出する: ${JSON.stringify(dropped)}`).toEqual([]);
    const ng = verifyCodeCarried(dropped, 'A001', 'A001');
    expect(ng[0].severity, '引き継がれていなければ Critical であること').toBe('critical');
    expect(ng[0].title, '内容が分かる文言であること').toContain('引き継がれていません');

    // 別の代理店コードが現れた場合 = 誤帰属 (Critical)
    await page.goto(`${application}/entry/?${param}=A002`);
    await page.waitForLoadState('load');
    const wrong = await observeCodeInApplication(page, config, 'A001', ['A002']);
    const wrongFindings = verifyCodeCarried(wrong, 'A001', 'A001');
    expect(
      wrongFindings.some((finding) => finding.title.includes('別の代理店コード')),
      `別の代理店コードに置き換わっていれば検出すること: ${JSON.stringify(wrong)}`,
    ).toBe(true);
  });

  test('文言だけの違いも「表示が違う」と判定する (切り替えの誤判定防止)', async () => {
    // みらやくの表示差分はセクションの有無だけでなく、
    // フッターの表記や注釈など文言だけの違いとして現れることもある。
    // ブロックの有無しか見ないと「切り替えが効いていない」と誤判定する。
    const blocks = [
      { key: 'footer', keyKind: 'class' as const, visible: true, width: 1200, height: 120, textSample: '', textLength: 10 },
      { key: 'main-hero', keyKind: 'testid' as const, visible: true, width: 1200, height: 480, textSample: '', textLength: 10 },
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
      blocks: [...blocks, { key: 'extra', keyKind: 'testid' as const, visible: true, width: 300, height: 60, textSample: '', textLength: 1 }],
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
      count: 1,
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
      url: documentUrl, count: 1 });

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
    monitor.consoleEntries.push({ level: 'error', text: 'console error', url: errorUrl, count: 1 });
    monitor.pageErrors.push({ message: 'page error', url: errorUrl, count: 1 });
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
