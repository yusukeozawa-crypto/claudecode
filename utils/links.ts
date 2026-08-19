/**
 * リンク切れ / リダイレクトループの検査。
 * ページ遷移は行わず APIRequestContext で確認するため、本番環境でも安全に実行できる。
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { isSameOrigin, matchesAnyGlob } from './patterns';
import { mapWithConcurrency, sleep } from './throttle';
import type { FindingInput, QaConfig } from './types';

export interface LinkInfo {
  href: string;
  text: string;
  testId?: string;
  isInternal: boolean;
}

/** ページ内のリンクを収集する (除外パターン適用・重複排除・件数上限あり) */
export async function collectLinks(page: Page, config: QaConfig): Promise<LinkInfo[]> {
  const baseUrl = config.environment.baseUrl;
  const raw = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
      href: (anchor as HTMLAnchorElement).href,
      rawHref: anchor.getAttribute('href') ?? '',
      text: (anchor.textContent ?? '').trim().slice(0, 60),
      testId: anchor.getAttribute('data-testid') ?? undefined,
    })),
  );

  const linksConfig = config.errors.links;
  const seen = new Set<string>();
  const links: LinkInfo[] = [];

  for (const item of raw) {
    const href = item.href;
    if (!href) continue;
    if (matchesAnyGlob(item.rawHref, linksConfig.ignoreUrlPatterns) || matchesAnyGlob(href, linksConfig.ignoreUrlPatterns)) continue;
    if (!/^https?:/i.test(href)) continue;

    const withoutHash = href.split('#')[0];
    if (seen.has(withoutHash)) continue;
    seen.add(withoutHash);

    const internal = isSameOrigin(withoutHash, baseUrl);
    if (linksConfig.scope === 'internal' && !internal) continue;

    links.push({ href: withoutHash, text: item.text, testId: item.testId, isInternal: internal });
    if (links.length >= linksConfig.maxLinksPerPage) break;
  }

  return links;
}

export interface LinkResult {
  link: LinkInfo;
  status: number | null;
  error?: string;
  redirectChain: string[];
  redirectLoop: boolean;
}

/**
 * リンク 1 件を検査する。
 * リダイレクトは手動で追跡し、ループと過剰リダイレクトを検出する。
 */
export async function checkLink(
  request: APIRequestContext,
  link: LinkInfo,
  config: QaConfig,
): Promise<LinkResult> {
  const linksConfig = config.errors.links;
  const method = link.isInternal ? 'GET' : linksConfig.externalMethod;
  const redirectChain: string[] = [];
  let currentUrl = link.href;

  for (let hop = 0; hop <= linksConfig.maxRedirects; hop++) {
    try {
      const response = await request.fetch(currentUrl, {
        method,
        maxRedirects: 0,
        timeout: config.runtime.timeouts.navigation,
        failOnStatusCode: false,
      });
      const status = response.status();

      if (status >= 300 && status < 400) {
        const location = response.headers()['location'];
        if (!location) {
          return { link, status, redirectChain, redirectLoop: false };
        }
        const nextUrl = new URL(location, currentUrl).toString();
        redirectChain.push(nextUrl);
        if (redirectChain.filter((entry) => entry === nextUrl).length > 1 || nextUrl === link.href) {
          return { link, status, redirectChain, redirectLoop: true };
        }
        currentUrl = nextUrl;
        continue;
      }

      return { link, status, redirectChain, redirectLoop: false };
    } catch (error) {
      return {
        link,
        status: null,
        error: error instanceof Error ? error.message : String(error),
        redirectChain,
        redirectLoop: false,
      };
    }
  }

  return { link, status: null, error: 'リダイレクト回数の上限を超えました', redirectChain, redirectLoop: true };
}

/** ページ内リンクを一括検査して Finding に変換する */
export async function checkPageLinks(
  page: Page,
  request: APIRequestContext,
  config: QaConfig,
): Promise<{ findings: FindingInput[]; checked: number }> {
  if (!config.errors.links.enabled) return { findings: [], checked: 0 };

  const pageUrl = page.url();
  const links = await collectLinks(page, config);
  const failStatuses = new Set(config.errors.network.failStatuses);
  const delay = config.runtime.throttle.linkCheckDelayMs;

  const results = await mapWithConcurrency(
    links,
    config.runtime.throttle.linkCheckConcurrency,
    async (link, index) => {
      // リクエスト間隔を空けて対象サイトへの負荷を抑える
      if (delay > 0) await sleep(delay * (index % Math.max(1, config.runtime.throttle.linkCheckConcurrency)));
      return checkLink(request, link, config);
    },
  );

  const findings: FindingInput[] = [];

  for (const result of results) {
    const label = result.link.testId
      ? `[data-testid="${result.link.testId}"]`
      : result.link.text || result.link.href;

    if (result.redirectLoop) {
      findings.push({
        category: 'redirect-loop',
        title: `リダイレクトループを検知しました: ${label}`,
        expected: 'リダイレクトが終端に到達すること',
        actual: `リダイレクト連鎖: ${[result.link.href, ...result.redirectChain].join(' -> ')}`,
        url: pageUrl,
        detail: `リンク先: ${result.link.href}`,
      });
      continue;
    }

    if (result.status === null) {
      const isTimeout = /timeout|timed out/i.test(result.error ?? '');
      findings.push({
        category: isTimeout ? 'timeout' : 'broken-link',
        title: isTimeout
          ? `リンク先へのリクエストがタイムアウトしました: ${label}`
          : `リンク先へアクセスできません: ${label}`,
        expected: 'HTTP 2xx を返すこと',
        actual: result.error ?? '不明なエラー',
        url: pageUrl,
        detail: `リンク先: ${result.link.href}`,
      });
      continue;
    }

    if (failStatuses.has(result.status) || result.status >= 400) {
      findings.push({
        category: 'broken-link',
        // 内部リンク切れは申込導線に影響し得るため High、外部リンクは Medium
        severity: result.link.isInternal ? 'high' : 'medium',
        title: `リンク切れを検知しました (HTTP ${result.status}): ${label}`,
        expected: 'HTTP 2xx を返すこと',
        actual: `HTTP ${result.status}`,
        url: pageUrl,
        detail: `リンク先: ${result.link.href}${result.redirectChain.length > 0 ? ` (経由: ${result.redirectChain.join(' -> ')})` : ''}`,
      });
    }
  }

  return { findings, checked: links.length };
}
