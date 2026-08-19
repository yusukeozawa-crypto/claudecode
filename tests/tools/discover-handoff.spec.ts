/**
 * 実サイトの仕様調査ツール (@discover)。
 *
 * 「引き継ぎ方法を推測せず、実際の通信から特定する」ためのツール。
 * 通常のテスト実行では起動せず、`npm run discover` のときだけ実行される。
 *
 * 実行内容 (読み取りと画面遷移のみ):
 *   1. 代理店コードごとに流入 LP を開く
 *   2. リダイレクト経路と遷移方式を記録する
 *   3. CTA を検出してクリックし、申込ドメインへの通信を記録する
 *   4. 申込ページの hidden 項目・localStorage・Cookie 名・API 応答を記録する
 *   5. 観測結果と、config/agencies.yml へ反映するための推奨値を出力する
 *
 * 出力: reports/discovery/<code>.json / reports/discovery/suggested-agencies.yml
 *
 * 秘密情報 (トークン値) は出力時にマスキングされる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { test } from '../qa-fixtures';
import { PROJECT_ROOT, resolveSelector } from '../../utils/config';
import { agencySpecs } from '../../utils/agency';
import { buildEntryUrl, waitForFinalLanding } from '../../utils/agency-entry';
import { RedirectTracker, describeMechanism, probeHttpChain } from '../../utils/redirect';
import { maskText, maskUrl } from '../../utils/secrets';
import type { HandoffMethod, QaConfig } from '../../utils/types';

const OUTPUT_DIR = path.join(PROJECT_ROOT, 'reports', 'discovery');

interface ObservedRequest {
  url: string;
  method: string;
  resourceType: string;
  /** POST ボディのキー名のみ (値は出力しない) */
  postDataKeys: string[];
  queryKeys: string[];
}

interface DiscoveryResult {
  code: string;
  entryUrl: string;
  finalUrl: string;
  redirect: {
    mechanism: string;
    httpRedirectCount: number;
    documentRequestCount: number;
    historyChangeCount: number;
    metaRefreshTargets: string[];
    hops: Array<{ url: string; status: number | null; kind: string }>;
    httpChain: Array<{ url: string; status: number; location: string | null; metaRefresh: string | null }>;
  };
  ctaCandidates: Array<{ testId: string; text: string; href: string; kind: string }>;
  crossDomainRequests: ObservedRequest[];
  detectedHandoffMethods: HandoffMethod[];
  applicationPage: {
    url: string;
    hiddenFields: Array<{ name: string; testId: string; hasValue: boolean }>;
    localStorageKeys: string[];
    cookieNames: string[];
    testIds: string[];
    apiResponses: Array<{ url: string; status: number; bodyKeys: string[] }>;
  } | null;
  notes: string[];
}

function keysOf(search: string): string[] {
  try {
    return Array.from(new URLSearchParams(search).keys());
  } catch {
    return [];
  }
}

function suggestedYaml(results: DiscoveryResult[], config: QaConfig): string {
  const lines: string[] = [
    '# ============================================================',
    '# 実サイトの観測結果から生成した推奨値 (npm run discover)',
    '#   そのまま使わず、内容を確認してから config/agencies.yml へ反映すること。',
    `#   観測日時: ${new Date().toISOString()}`,
    `#   対象環境: ${config.environmentName} (${config.environment.baseUrl})`,
    '# ============================================================',
    'agencies:',
  ];

  for (const result of results) {
    const finalPath = safePath(result.finalUrl);
    const entryPath = safePath(result.entryUrl);
    const redirected = finalPath !== entryPath;
    const mechanism =
      result.redirect.mechanism === 'unknown' ? 'none' : result.redirect.mechanism;
    const method = result.detectedHandoffMethods[0] ?? 'none';

    lines.push(`  - code: ${result.code}`);
    lines.push(`    entryPath: ${entryPath}`);
    lines.push(`    expectedFinalPath: ${finalPath}`);
    lines.push(`    redirected: ${redirected}`);
    lines.push(`    redirectMechanism: ${mechanism}`);
    lines.push(`    expectedRedirectCount: ${redirected ? Math.max(1, result.redirect.httpRedirectCount) : 0}`);
    lines.push(`    expectedRedirectPaths: ${redirected ? `[${finalPath}]` : '[]'}`);
    if (result.ctaCandidates.length > 0) {
      lines.push('    cta:');
      lines.push(`      testId: ${result.ctaCandidates[0].testId || '(data-testid が未設定 — サイト側に付与を依頼)'}`);
      lines.push(`      expectedText: ${result.ctaCandidates[0].text || 'null'}`);
    }
    lines.push('    application:');
    if (result.applicationPage) {
      const applicationHost = safeHost(result.applicationPage.url);
      lines.push(`      expectedDomain: ${applicationHost}`);
      lines.push(`      expectedPath: ${safePath(result.applicationPage.url)}`);
    }
    lines.push(`      handoffMethod: ${method}`);
    lines.push(`      expectedCode: ${result.code}`);
    if (result.applicationPage?.hiddenFields.length) {
      lines.push('      # 申込ページで見つかった hidden 項目 (recognition の候補)');
      for (const field of result.applicationPage.hiddenFields) {
        lines.push(`      #   name=${field.name} data-testid=${field.testId || '(なし)'} 値あり=${field.hasValue}`);
      }
    }
    if (result.notes.length > 0) {
      for (const note of result.notes) lines.push(`      # 注意: ${note}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

test.describe('仕様調査 @discover', () => {
  test.skip(
    !process.env.QA_DISCOVER,
    'npm run discover で実行してください (通常のテスト実行では起動しません)',
  );

  test('代理店ごとのリダイレクトと申込引き継ぎの実仕様を記録する', async ({ qa, page, request }, testInfo) => {
    test.slow();
    const config = qa.config;
    const lpHost = new URL(config.environment.baseUrl).host;
    const results: DiscoveryResult[] = [];

    for (const spec of agencySpecs(config)) {
      const notes: string[] = [];
      const crossDomainRequests: ObservedRequest[] = [];
      const detectedHandoffMethods: HandoffMethod[] = [];
      const apiResponses: DiscoveryResult['applicationPage'] extends null ? never[] : Array<{ url: string; status: number; bodyKeys: string[] }> = [];

      const entryUrl = buildEntryUrl(config, spec.entryPath, spec.code);

      // --- 通信の記録 (別ドメイン宛のみ) ---
      const onRequest = (req: import('@playwright/test').Request) => {
        const host = safeHost(req.url());
        if (!host || host === lpHost) return;
        const postData = req.postData();
        const observed: ObservedRequest = {
          url: maskUrl(req.url(), config),
          method: req.method(),
          resourceType: req.resourceType(),
          postDataKeys: postData ? keysOf(postData) : [],
          queryKeys: keysOf(new URL(req.url()).search),
        };
        crossDomainRequests.push(observed);

        const record = (method: HandoffMethod) => {
          if (!detectedHandoffMethods.includes(method)) detectedHandoffMethods.push(method);
        };
        if (observed.queryKeys.includes(config.agency.paramName)) record('query');
        if (observed.queryKeys.some((key) => /token|sid|session/i.test(key))) record('token');
        if (observed.postDataKeys.includes(config.agency.paramName)) record('post');
        if (observed.resourceType === 'xhr' || observed.resourceType === 'fetch') record('api');
      };
      page.on('request', onRequest);

      // --- リダイレクト経路 ---
      const httpChain = await probeHttpChain(request, entryUrl, config.agencies.redirect.maxRedirects);
      const tracker = new RedirectTracker(page);
      await page.goto(entryUrl, { waitUntil: 'load', timeout: 30000 }).catch((error) => {
        notes.push(`流入 URL を開けませんでした: ${String(error).split('\n')[0]}`);
      });
      await waitForFinalLanding(page, null);
      await tracker.captureMetaRefresh();
      const metaRefreshHints = httpChain.hops
        .map((hop) => hop.metaRefresh)
        .filter((hint): hint is string => Boolean(hint));
      const trace = tracker.build(entryUrl, config.agencies.redirect.maxRedirects, metaRefreshHints);
      tracker.detach();

      // --- CTA 候補の検出 (別ドメインを指すリンク / フォーム) ---
      const ctaCandidates = await page.evaluate((applicationHostHint: string) => {
        const candidates: Array<{ testId: string; text: string; href: string; kind: string }> = [];
        for (const element of Array.from(document.querySelectorAll('a[href], form[action], button'))) {
          const testId = element.getAttribute('data-testid') ?? '';
          const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
          const href =
            element.tagName === 'FORM'
              ? (element as HTMLFormElement).action
              : element.tagName === 'A'
                ? (element as HTMLAnchorElement).href
                : '';
          if (!href) {
            if (/申込|申し込み|見積|エントリー|entry/i.test(text)) {
              candidates.push({ testId, text, href: '', kind: element.tagName.toLowerCase() });
            }
            continue;
          }
          try {
            const host = new URL(href).host;
            if (host !== window.location.host || host === applicationHostHint) {
              candidates.push({ testId, text, href, kind: element.tagName.toLowerCase() });
            }
          } catch {
            /* 無効な URL は無視 */
          }
        }
        return candidates;
      }, new URL(config.environment.applicationBaseUrl).host);

      // --- CTA をクリックして申込ドメインへ (申込完了はしない) ---
      let applicationPage: DiscoveryResult['applicationPage'] = null;
      const ctaSelector = resolveSelector(spec.cta.testId);
      const ctaLocator = page.locator(ctaSelector).first();
      const ctaExists = (await ctaLocator.count()) > 0;

      if (!ctaExists) {
        notes.push(`設定された CTA (${ctaSelector}) が見つかりません。上記 ctaCandidates を確認してください`);
      } else {
        const beforeUrl = page.url();
        await ctaLocator.click({ timeout: 10000 }).catch((error) => {
          notes.push(`CTA をクリックできませんでした: ${String(error).split('\n')[0]}`);
        });
        await page.waitForLoadState('load', { timeout: 20000 }).catch(() => undefined);

        if (page.url() === beforeUrl) {
          notes.push('CTA をクリックしても URL が変化しませんでした (別タブ・JS 遷移の可能性)');
        } else {
          // 申込側 API の応答を記録する (読み取りのみ)
          const sessionApi = new URL(
            config.agency.application.sessionApiPattern.replace(/^\*\*/, '').replace(/\*$/, ''),
            config.environment.applicationBaseUrl,
          ).toString();
          const response = await page.request.get(sessionApi, { failOnStatusCode: false }).catch(() => null);
          if (response) {
            const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
            apiResponses.push({
              url: sessionApi,
              status: response.status(),
              bodyKeys: body ? Object.keys(body) : [],
            });
          }

          const observed = await page.evaluate(() => {
            const hiddenFields = Array.from(document.querySelectorAll('input[type="hidden"]')).map((element) => ({
              name: element.getAttribute('name') ?? '',
              testId: element.getAttribute('data-testid') ?? '',
              hasValue: Boolean((element as HTMLInputElement).value),
            }));
            let localStorageKeys: string[] = [];
            try {
              localStorageKeys = Object.keys(window.localStorage);
            } catch {
              localStorageKeys = [];
            }
            const cookieNames = document.cookie
              .split('; ')
              .map((part) => part.split('=')[0])
              .filter(Boolean);
            const testIds = Array.from(document.querySelectorAll('[data-testid]'))
              .map((element) => element.getAttribute('data-testid') ?? '')
              .filter(Boolean)
              .slice(0, 40);
            return { hiddenFields, localStorageKeys, cookieNames, testIds };
          });

          applicationPage = {
            url: maskUrl(page.url(), config),
            hiddenFields: observed.hiddenFields,
            localStorageKeys: observed.localStorageKeys,
            cookieNames: observed.cookieNames,
            testIds: observed.testIds,
            apiResponses,
          };
        }
      }

      page.off('request', onRequest);

      if (detectedHandoffMethods.length === 0) {
        notes.push('別ドメインへの引き継ぎ通信を観測できませんでした (同一ドメイン構成か、CTA が別方式の可能性)');
      }
      if (detectedHandoffMethods.length > 1) {
        notes.push(`複数の引き継ぎ方式を観測しました: ${detectedHandoffMethods.join(', ')} — 実装を確認してください`);
      }

      results.push({
        code: spec.code,
        entryUrl,
        finalUrl: trace.finalUrl,
        redirect: {
          mechanism: trace.mechanism,
          httpRedirectCount: trace.httpRedirectCount,
          documentRequestCount: trace.documentRequestCount,
          historyChangeCount: trace.historyChangeCount,
          metaRefreshTargets: trace.metaRefreshTargets,
          hops: trace.hops.map((hop) => ({ url: hop.url, status: hop.status, kind: hop.kind })),
          httpChain: httpChain.hops,
        },
        ctaCandidates,
        crossDomainRequests,
        detectedHandoffMethods,
        applicationPage,
        notes,
      });
    }

    // --- 出力 ---
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    for (const result of results) {
      const filePath = path.join(OUTPUT_DIR, `${result.code}.json`);
      fs.writeFileSync(filePath, maskText(JSON.stringify(result, null, 2), config) ?? '', 'utf8');
    }
    const yamlPath = path.join(OUTPUT_DIR, 'suggested-agencies.yml');
    fs.writeFileSync(yamlPath, maskText(suggestedYaml(results, config), config) ?? '', 'utf8');

    await qa.attachJson('discovery', results);

    // --- 結果の要約を出力 ---
    console.log('\n==================== 仕様調査結果 ====================');
    for (const result of results) {
      console.log(`\n[${result.code}]`);
      console.log(`  流入 URL   : ${result.entryUrl}`);
      console.log(`  最終 URL   : ${result.finalUrl}`);
      console.log(`  遷移方式   : ${describeMechanism(result.redirect.mechanism as never)} (HTTP 3xx: ${result.redirect.httpRedirectCount}, meta refresh: ${result.redirect.metaRefreshTargets.length}, SPA: ${result.redirect.historyChangeCount})`);
      console.log(`  引き継ぎ   : ${result.detectedHandoffMethods.join(', ') || '観測なし'}`);
      if (result.applicationPage) {
        console.log(`  申込ページ : ${result.applicationPage.url}`);
        console.log(`    hidden項目: ${result.applicationPage.hiddenFields.map((field) => field.name).join(', ') || 'なし'}`);
        console.log(`    localStorage: ${result.applicationPage.localStorageKeys.join(', ') || 'なし'}`);
        console.log(`    Cookie    : ${result.applicationPage.cookieNames.join(', ') || 'なし'}`);
      }
      for (const note of result.notes) console.log(`  注意       : ${note}`);
    }
    console.log(`\n観測結果: ${path.relative(PROJECT_ROOT, OUTPUT_DIR)}/`);
    console.log(`推奨設定: ${path.relative(PROJECT_ROOT, yamlPath)}`);
    console.log('======================================================\n');

    // 調査ツールなので不具合としては報告しない (検知結果は空)
    void testInfo;
  });
});
