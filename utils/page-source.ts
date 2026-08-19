/**
 * テスト対象ページの取得。
 * 現在は config/pages.yml から取得する。
 * source: sitemap に変更すると sitemap.xml から自動取得する (取得処理はここに分離してある)。
 */
import type { APIRequestContext } from '@playwright/test';
import { matchesAnyGlob } from './patterns';
import type { PageConfig, QaConfig } from './types';

/** 設定ファイルに定義されたページ */
export function pagesFromConfig(config: QaConfig): PageConfig[] {
  return config.pages.pages;
}

/** sitemap.xml からページ一覧を取得する */
export async function pagesFromSitemap(
  config: QaConfig,
  request: APIRequestContext,
): Promise<PageConfig[]> {
  const sitemapConfig = config.pages.sitemap;
  const sitemapUrl = new URL(sitemapConfig.path, `${config.environment.baseUrl}/`).toString();
  const response = await request.get(sitemapUrl, { timeout: config.runtime.timeouts.navigation });

  if (!response.ok()) {
    throw new Error(`sitemap.xml を取得できません (HTTP ${response.status()}): ${sitemapUrl}`);
  }

  const xml = await response.text();
  const locations = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((match) => match[1]);

  const pages: PageConfig[] = [];
  for (const location of locations) {
    if (sitemapConfig.includePatterns.length > 0 && !matchesAnyGlob(location, sitemapConfig.includePatterns)) continue;
    if (matchesAnyGlob(location, sitemapConfig.excludePatterns)) continue;

    let pathname: string;
    try {
      pathname = new URL(location).pathname;
    } catch {
      continue;
    }

    pages.push({
      id: sitemapPageId(pathname),
      name: pathname,
      path: pathname,
      agencyAware: sitemapConfig.defaults.agencyAware,
      checks: sitemapConfig.defaults.checks,
    });

    if (pages.length >= sitemapConfig.maxPages) break;
  }

  return pages;
}

/** URL パスから安定した id を作る (ファイル名として使用できる文字のみ) */
export function sitemapPageId(pathname: string): string {
  const normalized = pathname.replace(/^\/+|\/+$/g, '').replace(/\.[a-z0-9]+$/i, '');
  return normalized === '' ? 'top' : normalized.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/**
 * 設定に応じてページ一覧を取得する。
 * sitemap 取得に失敗した場合は config/pages.yml の定義にフォールバックする。
 */
export async function resolvePages(config: QaConfig, request?: APIRequestContext): Promise<PageConfig[]> {
  if (config.pages.source === 'sitemap') {
    if (!request) {
      throw new Error('source: sitemap を使用するには APIRequestContext が必要です');
    }
    try {
      const pages = await pagesFromSitemap(config, request);
      if (pages.length > 0) return pages;
      console.warn('[qa] sitemap.xml からページを取得できなかったため config/pages.yml を使用します');
    } catch (error) {
      console.warn(`[qa] sitemap.xml の取得に失敗したため config/pages.yml を使用します: ${String(error)}`);
    }
  }
  return pagesFromConfig(config);
}

/** 代理店コードによる表示差分があるページ */
export function agencyAwarePages(pages: PageConfig[]): PageConfig[] {
  return pages.filter((page) => page.agencyAware);
}

/** id からページ定義を取得する */
export function pageById(pages: PageConfig[], id: string): PageConfig {
  const found = pages.find((page) => page.id === id);
  if (!found) {
    throw new Error(`ページ定義が見つかりません: ${id} (config/pages.yml を確認してください)`);
  }
  return found;
}

/** 指定のチェックが有効なページ */
export function pagesWithCheck(pages: PageConfig[], check: PageConfig['checks'][number]): PageConfig[] {
  return pages.filter((page) => page.checks.includes(check));
}
