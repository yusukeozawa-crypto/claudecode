/**
 * 代理店ごとの LP リダイレクト検査 (config/agencies.yml から自動生成)。
 *
 * 各代理店コードについて検査する項目:
 *   1. 流入 URL
 *   2. HTTP ステータス
 *   3. リダイレクト回数
 *   4. リダイレクト途中の URL
 *   5. 最終 URL
 *   6. 最終ページに表示された代理店情報
 *   7. リダイレクト後も保持されている代理店コード
 *   8. 不要なコードや個人情報が URL に付加されていないこと
 *   9. リダイレクトループがないこと
 *  10. PC と SP で同じルールが適用されること
 *
 * page.url() による最終 URL 確認だけでなく、request / response イベントから
 * 経路を記録し、遷移方式 (HTTP 3xx / JavaScript / meta refresh / SPA) を判定する。
 */
import { test } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { agencySpecs, readStoredCode, verifySections, verifyStoredCode, verifyTexts } from '../../utils/agency';
import {
  RedirectTracker, describeMechanism, probeHttpChain, verifyHttpChain,
  verifyRedirectTrace, verifyUrlHygiene,
} from '../../utils/redirect';

import { deviceUse } from '../../utils/projects';

const config = loadConfig();
const specs = agencySpecs(config);
const maxRedirects = config.agencies.redirect.maxRedirects;
const browserId = config.devices.browsers.find((browser) => browser.enabled)?.id ?? 'chromium';

function entryUrl(path: string, code: string | null): string {
  const url = new URL(path, `${config.environment.baseUrl}/`);
  if (code) url.searchParams.set(config.agency.paramName, code);
  return url.toString();
}

test.describe('代理店ごとのリダイレクト @agency @redirect', () => {
  for (const spec of specs) {
    test(`${spec.code}: ${spec.entryPath} から ${spec.expectedFinalPath} への遷移 (${describeMechanism(spec.redirectMechanism)})`, async ({
      qa,
      page,
      request,
    }) => {
      const target = entryUrl(spec.entryPath, spec.code);
      qa.findings.setContext({ agencyCode: spec.code, url: target });

      // --- (2) HTTP レベルの経路 (ブラウザを介さずに 3xx を 1 ホップずつ追跡) ---
      const httpChain = await probeHttpChain(request, target, maxRedirects);
      qa.addAll(
        verifyHttpChain(httpChain, {
          code: spec.code,
          entryPath: spec.entryPath,
          expectedFinalPath: spec.expectedFinalPath,
          redirected: spec.redirected,
          redirectMechanism: spec.redirectMechanism,
        }),
      );

      // --- (1)(3)(4)(5)(9) ブラウザでの経路記録 ---
      const tracker = new RedirectTracker(page);
      const opened = await qa.goto({ url: target, agencyCode: spec.code });
      if (!opened) {
        tracker.detach();
        return;
      }
      // meta refresh 方式では遷移完了を待つ
      if (spec.redirectMechanism === 'meta-refresh' || spec.redirected) {
        await page
          .waitForURL((url) => url.pathname.replace(/\/$/, '') === spec.expectedFinalPath.replace(/\/$/, ''), {
            timeout: 10000,
          })
          .catch(() => undefined);
      }
      await tracker.captureMetaRefresh();
      await page.waitForLoadState('load').catch(() => undefined);

      // meta refresh は遷移後の DOM に残らないため、HTTP レスポンス本文から
      // 検出した遷移先をヒントとして渡す
      const metaRefreshHints = httpChain.hops
        .map((hop) => hop.metaRefresh)
        .filter((hint): hint is string => Boolean(hint));
      const trace = tracker.build(target, maxRedirects, metaRefreshHints);
      tracker.detach();

      qa.findings.setContext({ url: trace.finalUrl });
      qa.addAll(
        verifyRedirectTrace(
          trace,
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
        ),
      );

      // --- (6) 最終ページに表示された代理店情報 ---
      qa.addAll(await verifySections(page, spec, `${spec.code}: リダイレクト後`));
      qa.addAll(await verifyTexts(page, spec.expectedTexts, `${spec.code}: リダイレクト後`));

      // --- (7) リダイレクト後も保持されている代理店コード ---
      const stored = await readStoredCode(page, config);
      qa.addAll(
        verifyStoredCode(stored, config, spec.code, {
          url: trace.finalUrl,
          label: `${spec.code}: リダイレクト後`,
        }),
      );

      // --- (8) 不要なパラメータ・個人情報が URL に付加されていないこと ---
      qa.addAll(verifyUrlHygiene(trace.finalUrl, config, `${spec.code}: 最終 URL`));

      // 経路を証跡として残す
      await qa.attachJson(`redirect-trace-${spec.code}`, {
        entryUrl: trace.entryUrl,
        finalUrl: trace.finalUrl,
        mechanism: trace.mechanism,
        httpRedirectCount: trace.httpRedirectCount,
        documentRequestCount: trace.documentRequestCount,
        historyChangeCount: trace.historyChangeCount,
        metaRefreshTargets: trace.metaRefreshTargets,
        hops: trace.hops,
        httpChain: httpChain.hops,
      });
      await qa.captureScreenshot(`redirect-${spec.code}`);
      qa.collectMonitorFindings();
    });
  }

  // ------------------------------------------------------------------
  // コードなし・無効コードではリダイレクトされないこと
  // ------------------------------------------------------------------
  test('代理店コードなしではリダイレクトされない', async ({ qa, page, request }) => {
    const expectation = config.agencies.noCodeExpectation;
    const target = entryUrl(expectation.entryPath, null);

    const httpChain = await probeHttpChain(request, target, maxRedirects);
    qa.addAll(
      verifyHttpChain(httpChain, {
        code: null,
        entryPath: expectation.entryPath,
        expectedFinalPath: expectation.expectedFinalPath,
        redirected: false,
        redirectMechanism: 'none',
      }),
    );

    const tracker = new RedirectTracker(page);
    const opened = await qa.goto({ url: target });
    if (!opened) {
      tracker.detach();
      return;
    }
    await tracker.captureMetaRefresh();
    const trace = tracker.build(target, maxRedirects);
    tracker.detach();

    qa.addAll(
      verifyRedirectTrace(
        trace,
        {
          code: null,
          entryPath: expectation.entryPath,
          expectedFinalPath: expectation.expectedFinalPath,
          redirected: false,
          redirectMechanism: 'none',
          expectedRedirectCount: 0,
          expectedRedirectPaths: [],
        },
        config,
      ),
    );
    qa.addAll(verifyUrlHygiene(trace.finalUrl, config, 'コードなし: 最終 URL'));
    qa.collectMonitorFindings();
  });

  for (const invalid of config.agencies.invalidCodes) {
    test(`無効コード ${invalid.code} では代理店専用LPへリダイレクトされない`, async ({ qa, page }) => {
      const expectation = config.agencies.invalidExpectation;
      const target = entryUrl(expectation.entryPath, invalid.code);

      const tracker = new RedirectTracker(page);
      const opened = await qa.goto({ url: target, agencyCode: invalid.code });
      if (!opened) {
        tracker.detach();
        return;
      }
      await tracker.captureMetaRefresh();
      const trace = tracker.build(target, maxRedirects);
      tracker.detach();

      qa.addAll(
        verifyRedirectTrace(
          trace,
          {
            code: invalid.code,
            entryPath: expectation.entryPath,
            expectedFinalPath: expectation.expectedFinalPath,
            redirected: false,
            redirectMechanism: 'none',
            expectedRedirectCount: 0,
            expectedRedirectPaths: [],
          },
          config,
        ),
      );

      // 別代理店の専用 LP へ誘導されていないこと
      for (const spec of specs) {
        if (!spec.redirected) continue;
        if (new URL(trace.finalUrl).pathname.replace(/\/$/, '') === spec.expectedFinalPath.replace(/\/$/, '')) {
          qa.add({
            category: 'agency-redirect',
            severity: 'critical',
            title: `無効コード ${invalid.code} が ${spec.code} の専用LPへリダイレクトされました`,
            expected: `${expectation.expectedFinalPath} のまま表示されること`,
            actual: `${spec.expectedFinalPath} へリダイレクトされました`,
            url: trace.finalUrl,
          });
        }
      }
      qa.collectMonitorFindings();
    });
  }
});

// ------------------------------------------------------------------
// (10) PC と SP で同じリダイレクトルールが適用されること
//      端末ごとに context を作って比較するため、1 つの project でのみ実行する
// ------------------------------------------------------------------
test.describe('リダイレクトルールの端末間一致 @agency @redirect', () => {
  const firstProject = `${browserId}-${config.devices.devices[0]?.id}`;

  test('PC と SP で最終 URL と遷移方式が一致する', async ({ qa, browser }, testInfo) => {
    test.skip(
      testInfo.project.name !== firstProject,
      `端末間比較のため ${firstProject} でのみ実行します`,
    );
    test.slow();

    for (const spec of specs) {
      const target = entryUrl(spec.entryPath, spec.code);
      const results: Array<{ deviceId: string; finalPath: string; mechanism: string }> = [];

      for (const device of config.devices.devices) {
        // project 生成と同じロジックを使う (Firefox は isMobile / hasTouch 非対応)
        const context = await browser.newContext(
          deviceUse(browserId, device) as Parameters<typeof browser.newContext>[0],
        );
        const devicePage = await context.newPage();
        const tracker = new RedirectTracker(devicePage);

        try {
          await devicePage.goto(target, { waitUntil: 'load', timeout: 20000 });
          if (spec.redirected) {
            await devicePage
              .waitForURL(
                (url) => url.pathname.replace(/\/$/, '') === spec.expectedFinalPath.replace(/\/$/, ''),
                { timeout: 10000 },
              )
              .catch(() => undefined);
          }
          await tracker.captureMetaRefresh();
          const trace = tracker.build(target, maxRedirects);
          results.push({
            deviceId: device.id,
            finalPath: new URL(trace.finalUrl).pathname,
            mechanism: trace.mechanism,
          });
        } finally {
          tracker.detach();
          await context.close();
        }
      }

      const finalPaths = new Set(results.map((result) => result.finalPath));
      if (finalPaths.size > 1) {
        qa.add({
          category: 'agency-redirect',
          severity: 'critical',
          title: `${spec.code}: 端末によってリダイレクト先が異なります`,
          expected: 'PC と SP で同じ最終 URL になること',
          actual: results.map((result) => `${result.deviceId}=${result.finalPath}`).join(' / '),
          url: target,
          agencyCode: spec.code,
        });
      }

      const mechanisms = new Set(results.map((result) => result.mechanism));
      if (mechanisms.size > 1) {
        qa.add({
          category: 'redirect-mechanism',
          severity: 'medium',
          title: `${spec.code}: 端末によって遷移方式が異なります (警告)`,
          expected: 'PC と SP で同じ遷移方式になること',
          actual: results.map((result) => `${result.deviceId}=${result.mechanism}`).join(' / '),
          url: target,
          agencyCode: spec.code,
        });
      }
    }
  });
});
