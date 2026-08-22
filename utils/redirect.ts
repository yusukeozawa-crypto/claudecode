/**
 * リダイレクト経路の記録と検証。
 *
 * page.url() による最終 URL の確認だけではなく、request / response /
 * framenavigated イベントを記録して、
 *   - HTTP ステータス
 *   - リダイレクト回数
 *   - 経路上の URL
 *   - 遷移方式 (HTTP 3xx / JavaScript / meta refresh / SPA ルーティング)
 * を特定する。仕様と異なる遷移方式であれば警告として報告する。
 */
import type { APIRequestContext, Frame, Page, Request, Response } from '@playwright/test';
import { matchesAnyGlob } from './patterns';
import type { FindingInput, QaConfig, RedirectMechanism, RedirectTrace } from './types';

export interface NavigationHop {
  url: string;
  status: number | null;
  location: string | null;
  /** http (3xx) | document (新規ドキュメント要求) | history (SPA) */
  kind: 'http' | 'document' | 'history';
}

export type { RedirectTrace };

/**
 * ページに監視を仕掛けてリダイレクト経路を記録する。
 * ページ遷移の前に生成すること。
 */
export class RedirectTracker {
  private readonly hops: NavigationHop[] = [];
  private readonly metaRefreshTargets: string[] = [];
  private documentRequests = 0;
  private historyChanges = 0;
  private lastFrameUrl: string | null = null;
  private detached = false;

  private readonly onRequest: (request: Request) => void;
  private readonly onResponse: (response: Response) => void;
  private readonly onFrameNavigated: (frame: Frame) => void;

  constructor(private readonly page: Page) {
    this.onRequest = (request) => {
      if (request.frame() !== page.mainFrame()) return;
      if (request.resourceType() !== 'document') return;
      this.documentRequests += 1;
    };

    this.onResponse = (response) => {
      const request = response.request();
      if (request.frame() !== page.mainFrame()) return;
      if (request.resourceType() !== 'document') return;
      const status = response.status();
      const location = response.headers()['location'] ?? null;
      this.hops.push({
        url: response.url(),
        status,
        location: location ? new URL(location, response.url()).toString() : null,
        kind: status >= 300 && status < 400 ? 'http' : 'document',
      });
    };

    this.onFrameNavigated = (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (this.lastFrameUrl !== null && url !== this.lastFrameUrl) {
        // ドキュメント要求を伴わない URL 変更は SPA ルーティングとみなす。
        //
        // ただし「パスが変わっていない URL 変更」は遷移として数えない。
        // 実サイトでは計測タグや同意バナー、ABテストのスクリプトが
        // history.replaceState でクエリを書き換えたり、# を付けたりする。
        // これを遷移として数えると、リダイレクトしていないページが
        // 「リダイレクト回数が仕様と異なる」と誤検知される。
        const hadDocumentRequest = this.hops.some((hop) => hop.url === url);
        if (!hadDocumentRequest && changedPath(this.lastFrameUrl, url)) {
          this.historyChanges += 1;
          this.hops.push({ url, status: null, location: null, kind: 'history' });
        }
      }
      this.lastFrameUrl = url;
    };

    page.on('request', this.onRequest);
    page.on('response', this.onResponse);
    page.on('framenavigated', this.onFrameNavigated);
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.page.off('request', this.onRequest);
    this.page.off('response', this.onResponse);
    this.page.off('framenavigated', this.onFrameNavigated);
  }

  reset(): void {
    this.hops.length = 0;
    this.metaRefreshTargets.length = 0;
    this.documentRequests = 0;
    this.historyChanges = 0;
    this.lastFrameUrl = null;
  }

  /** ページ本文から meta refresh の遷移先を取得する (遷移方式の判定に使用) */
  async captureMetaRefresh(): Promise<string | null> {
    // url= を持たない refresh タグ (単純な再読み込み) は遷移ではないため対象外にする。
    // 記録してしまうと、リダイレクトしていないページの遷移方式が
    // meta-refresh と誤判定される。
    const target = await this.page
      .evaluate(() => {
        const meta = document.querySelector('meta[http-equiv="refresh" i]');
        if (!meta) return null;
        const content = meta.getAttribute('content') ?? '';
        const match = /url\s*=\s*(.+)$/i.exec(content);
        return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
      })
      .catch(() => null);

    if (!target) return null;

    const absolute = new URL(target, this.page.url()).toString();
    if (!this.metaRefreshTargets.includes(absolute)) this.metaRefreshTargets.push(absolute);
    return absolute;
  }

  /**
   * 記録内容から経路情報をまとめる。
   *
   * meta refresh は「遷移後の DOM」には残らないため、
   * HTTP レスポンス本文から検出したヒント (probeHttpChain の結果) を渡せるようにしている。
   */
  build(entryUrl: string, maxRedirects: number, metaRefreshHints: string[] = []): RedirectTrace {
    for (const hint of metaRefreshHints) {
      if (hint && !this.metaRefreshTargets.includes(hint)) this.metaRefreshTargets.push(hint);
    }
    const finalUrl = this.page.url();
    const httpRedirectCount = this.hops.filter((hop) => hop.kind === 'http').length;
    // ループ判定。
    //   実際のリダイレクト (HTTP 3xx) の重複で判定する。
    //   通常のドキュメント要求の重複まで対象にすると、
    //   再読み込みや同一 URL の再取得をループと誤検知する。
    const redirectUrls = this.hops.filter((hop) => hop.kind === 'http').map((hop) => hop.url);
    const loopDetected =
      httpRedirectCount > maxRedirects ||
      redirectUrls.some((url, index) => redirectUrls.indexOf(url) !== index);

    return {
      entryUrl,
      finalUrl,
      hops: [...this.hops],
      httpRedirectCount,
      documentRequestCount: this.documentRequests,
      historyChangeCount: this.historyChanges,
      metaRefreshTargets: [...this.metaRefreshTargets],
      mechanism: detectMechanism({
        entryUrl,
        finalUrl,
        httpRedirectCount,
        documentRequestCount: this.documentRequests,
        historyChangeCount: this.historyChanges,
        metaRefreshTargets: this.metaRefreshTargets,
      }),
      loopDetected,
    };
  }
}

/** 遷移方式を判定する */
export function detectMechanism(input: {
  entryUrl: string;
  finalUrl: string;
  httpRedirectCount: number;
  documentRequestCount: number;
  historyChangeCount: number;
  metaRefreshTargets: string[];
}): RedirectMechanism {
  const samePath = normalizePath(input.entryUrl) === normalizePath(input.finalUrl);
  if (input.httpRedirectCount > 0) return 'http';
  if (samePath && input.historyChangeCount === 0) return 'none';
  if (input.metaRefreshTargets.length > 0) return 'meta-refresh';
  if (input.historyChangeCount > 0 && input.documentRequestCount <= 1) return 'spa';
  if (input.documentRequestCount > 1) return 'js';
  return 'unknown';
}

export function normalizePath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  } catch {
    return url;
  }
}

/**
 * 2 つの URL でパス (オリジン + パス) が変わったか。
 *
 * クエリやフラグメントだけの違いは「遷移」とみなさない。
 * 実サイトでは計測タグ・同意バナー・ABテストのスクリプトが
 * history.replaceState でクエリを書き換えることが多く、
 * それを遷移として数えると誤検知になる。
 */
function changedPath(before: string, after: string): boolean {
  try {
    const a = new URL(before);
    const b = new URL(after);
    return a.origin !== b.origin || normalizePath(a.pathname) !== normalizePath(b.pathname);
  } catch {
    return before !== after;
  }
}

function samePath(a: string, b: string): boolean {
  return normalizePath(a) === (b.endsWith('/') ? b : `${b}/`) || normalizePath(a) === normalizePath(b);
}

// ---------------------------------------------------------------------------
// HTTP レベルの経路確認 (ブラウザを使わずに 3xx を 1 ホップずつ追跡する)
// ---------------------------------------------------------------------------

export interface HttpChainHop {
  url: string;
  status: number;
  location: string | null;
  /** レスポンス本文に meta refresh があった場合の遷移先 */
  metaRefresh: string | null;
}

export interface HttpChain {
  hops: HttpChainHop[];
  finalUrl: string;
  finalStatus: number | null;
  loopDetected: boolean;
  error?: string;
}

/** 流入 URL から HTTP レベルのリダイレクト経路を取得する */
export async function probeHttpChain(
  request: APIRequestContext,
  entryUrl: string,
  maxRedirects: number,
  isForbidden?: (url: string) => boolean,
): Promise<HttpChain> {
  const hops: HttpChainHop[] = [];
  const seen = new Set<string>();
  let currentUrl = entryUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // 申込完了・データ送信の URL は実際に叩かない (本番で完了処理を踏まないため)
    if (isForbidden?.(currentUrl)) {
      return {
        hops,
        finalUrl: currentUrl,
        finalStatus: null,
        loopDetected: false,
        error: '禁止対象の URL のため経路確認を中断しました (申込完了・データ送信)',
      };
    }
    if (seen.has(currentUrl)) {
      return { hops, finalUrl: currentUrl, finalStatus: null, loopDetected: true };
    }
    seen.add(currentUrl);

    try {
      const response = await request.fetch(currentUrl, {
        method: 'GET',
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      const status = response.status();
      const location = response.headers()['location'] ?? null;
      let metaRefresh: string | null = null;

      if (status >= 200 && status < 300) {
        const contentType = response.headers()['content-type'] ?? '';
        if (contentType.includes('text/html')) {
          const body = await response.text();
          const match = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url\s*=\s*([^"']+)["']/i.exec(body);
          if (match) metaRefresh = new URL(match[1].trim(), currentUrl).toString();
        }
      }

      hops.push({
        url: currentUrl,
        status,
        location: location ? new URL(location, currentUrl).toString() : null,
        metaRefresh,
      });

      if (status >= 300 && status < 400 && location) {
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (metaRefresh) {
        currentUrl = metaRefresh;
        continue;
      }
      return { hops, finalUrl: currentUrl, finalStatus: status, loopDetected: false };
    } catch (error) {
      return {
        hops,
        finalUrl: currentUrl,
        finalStatus: null,
        loopDetected: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { hops, finalUrl: currentUrl, finalStatus: null, loopDetected: true };
}

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

export interface RedirectExpectation {
  code: string | null;
  entryPath: string;
  expectedFinalPath: string;
  redirected: boolean;
  redirectMechanism: RedirectMechanism;
  expectedRedirectCount?: number | null;
  expectedRedirectPaths?: string[];
}

/** ブラウザで観測した経路と仕様を突き合わせる */
export function verifyRedirectTrace(
  trace: RedirectTrace,
  expectation: RedirectExpectation,
  config: QaConfig,
): FindingInput[] {
  const findings: FindingInput[] = [];
  const label = expectation.code ? `${expectation.code}` : 'コードなし';
  const url = trace.finalUrl;

  // (9) リダイレクトループ
  if (trace.loopDetected) {
    findings.push({
      category: 'redirect-loop',
      severity: 'critical',
      title: `${label}: リダイレクトループを検知しました`,
      expected: `リダイレクトが ${config.agencies.redirect.maxRedirects} 回以内で終端に到達すること`,
      actual: `経路: ${[trace.entryUrl, ...trace.hops.map((hop) => hop.url)].join(' -> ')}`,
      url,
    });
    return findings;
  }

  // (5) 最終 URL
  if (!samePath(trace.finalUrl, expectation.expectedFinalPath)) {
    findings.push({
      checkId: 'redirect',
      category: 'agency-redirect',
      severity: 'critical',
      title: `${label}: 最終的な表示 URL が仕様と異なります`,
      expected: `最終パス ${expectation.expectedFinalPath}`,
      actual: `最終パス ${new URL(trace.finalUrl).pathname} (${trace.finalUrl})`,
      url,
      detail: `経路: ${[trace.entryUrl, ...trace.hops.map((hop) => `${hop.url}${hop.status ? ` [${hop.status}]` : ''}`)].join(' -> ')}`,
    });
  }

  // (3) リダイレクト有無・回数
  const actuallyRedirected = !samePath(trace.entryUrl, trace.finalUrl);
  if (expectation.redirected !== actuallyRedirected) {
    findings.push({
      checkId: 'redirect',
      category: 'agency-redirect',
      severity: 'critical',
      title: expectation.redirected
        ? `${label}: リダイレクトされるべきですがリダイレクトされていません`
        : `${label}: リダイレクトされないべきですがリダイレクトされました`,
      expected: expectation.redirected ? `${expectation.expectedFinalPath} へリダイレクト` : 'リダイレクトなし',
      actual: actuallyRedirected
        ? `${new URL(trace.entryUrl).pathname} -> ${new URL(trace.finalUrl).pathname}`
        : 'リダイレクトなし',
      url,
    });
  }

  if (expectation.expectedRedirectCount !== undefined) {
    const observed = trace.hops.filter((hop) => hop.kind !== 'document' || false).length;
    const totalTransitions = countTransitions(trace);
    const breakdown =
      `HTTP 3xx: ${trace.httpRedirectCount}, ドキュメント要求: ${trace.documentRequestCount}, ` +
      `SPA: ${trace.historyChangeCount}, meta refresh: ${trace.metaRefreshTargets.length}`;
    if (expectation.expectedRedirectCount === null) {
      // 未実測。推測した回数で判定すると正常なサイトを不具合として報告してしまうため、
      // 照合せず実測値を記録して設定に反映できるようにする。
      findings.push({
        category: 'agency-redirect',
        severity: 'low',
        title: `${label}: リダイレクト回数が未設定です`,
        expected: 'config の expectedRedirectCount に実測値を設定すること',
        actual: `実測値: ${totalTransitions} 回 (${breakdown})`,
        url,
        detail:
          '経路: ' +
          [trace.entryUrl, ...trace.hops.map((hop) => hop.url)].join(' -> ') +
          ' / この回数を config/agency-profiles.yml の expectedRedirectCount に設定すると、以降は回数の変化を検知できます',
      });
    } else if (totalTransitions !== expectation.expectedRedirectCount) {
      findings.push({
        category: 'agency-redirect',
        severity: 'high',
        title: `${label}: リダイレクト回数が仕様と異なります`,
        expected: `${expectation.expectedRedirectCount} 回`,
        actual: `${totalTransitions} 回 (${breakdown}) [observed hops: ${observed}]`,
        url,
        detail: `経路: ${[trace.entryUrl, ...trace.hops.map((hop) => hop.url)].join(' -> ')}`,
      });
    }
  }

  // (4) リダイレクト途中の URL
  for (const expectedPath of expectation.expectedRedirectPaths ?? []) {
    const passed = [trace.finalUrl, ...trace.hops.map((hop) => hop.url), ...trace.hops.flatMap((hop) => (hop.location ? [hop.location] : []))];
    if (!passed.some((candidate) => samePath(candidate, expectedPath))) {
      findings.push({
        category: 'agency-redirect',
        severity: 'high',
        title: `${label}: 期待するリダイレクト経路を通っていません`,
        expected: `経路に ${expectedPath} を含むこと`,
        actual: `観測した経路: ${passed.map((candidate) => safePath(candidate)).join(' -> ')}`,
        url,
      });
    }
  }

  // 遷移方式。
  //   unknown = 「まだ実測していない」の明示。
  //   仕様と照合せず、実測値を記録して設定に反映できるようにする
  //   (未設定を「仕様と異なる」として毎回警告するのは誤解を招く)。
  if (expectation.redirectMechanism === 'unknown') {
    findings.push({
      category: 'redirect-mechanism',
      severity: 'low',
      title: `${label}: リダイレクトの実装方式が未設定です`,
      expected: 'config の redirectMechanism に実測値を設定すること',
      actual: `実測値: ${trace.mechanism} (${describeMechanism(trace.mechanism)})`,
      url,
      detail:
        'この値を config/agency-profiles.yml の redirectMechanism に設定すると、以降は仕様との差異を検知できます',
    });
  } else if (expectation.redirectMechanism !== trace.mechanism) {
    findings.push({
      category: 'redirect-mechanism',
      severity: 'medium',
      title: `${label}: リダイレクトの実装方式が仕様と異なります (警告)`,
      expected: `${describeMechanism(expectation.redirectMechanism)}`,
      actual: `${describeMechanism(trace.mechanism)}`,
      url,
      detail:
        'HTTP 3xx / JavaScript による遷移 / meta refresh / SPA のクライアントルーティングのいずれが使われているかを確認してください',
    });
  }

  // 合否どちらでも記録を残す。
  // ダッシュボードの「代理店 × 検査項目」の表で
  // 「検査したうえで問題なし」と「そもそも検査していない」を区別するために必要。
  if (!findings.some((finding) => finding.checkId === 'redirect')) {
    findings.push({
      checkId: 'redirect',
      category: 'agency-redirect',
      severity: 'low',
      title: `[確認OK] ${label}: ${expectation.redirected ? 'リダイレクト先が仕様どおり' : 'リダイレクトされない (仕様どおり)'}`,
      expected: expectation.redirected
        ? `${expectation.expectedFinalPath} へリダイレクト`
        : 'リダイレクトなし',
      actual: `最終パス ${safePath(trace.finalUrl)}`,
      url,
    });
  }

  return findings;
}

function countTransitions(trace: RedirectTrace): number {
  // HTTP 3xx、meta refresh、SPA 遷移の合計を「リダイレクト回数」とみなす。
  // JavaScript による遷移は追加のドキュメント要求として現れる。
  const jsTransitions = Math.max(0, trace.documentRequestCount - 1 - trace.httpRedirectCount);
  return trace.httpRedirectCount + trace.historyChangeCount + jsTransitions;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function describeMechanism(mechanism: RedirectMechanism): string {
  switch (mechanism) {
    case 'none':
      return 'リダイレクトなし';
    case 'http':
      return 'HTTP リダイレクト (301/302/303/307/308)';
    case 'js':
      return 'JavaScript による遷移';
    case 'meta-refresh':
      return 'meta refresh';
    case 'spa':
      return 'SPA のクライアントルーティング';
    default:
      return '判定不能';
  }
}

/** HTTP レベルの経路を検証する (ステータス・ループ・301/302 の種別) */
export function verifyHttpChain(
  chain: HttpChain,
  expectation: RedirectExpectation,
): FindingInput[] {
  const findings: FindingInput[] = [];
  const label = expectation.code ?? 'コードなし';

  if (chain.error) {
    findings.push({
      category: 'agency-redirect',
      severity: 'high',
      title: `${label}: 流入 URL へのリクエストが失敗しました`,
      expected: 'HTTP 2xx / 3xx を返すこと',
      actual: chain.error,
      url: chain.finalUrl,
    });
    return findings;
  }

  if (chain.loopDetected) {
    findings.push({
      category: 'redirect-loop',
      severity: 'critical',
      title: `${label}: HTTP レベルでリダイレクトループを検知しました`,
      expected: 'リダイレクトが終端に到達すること',
      actual: `経路: ${chain.hops.map((hop) => `${hop.url} [${hop.status}]`).join(' -> ')}`,
      url: chain.finalUrl,
    });
    return findings;
  }

  // (2) HTTP ステータス
  const entryHop = chain.hops[0];
  if (entryHop) {
    const validEntry = entryHop.status === 200 || (entryHop.status >= 300 && entryHop.status < 400);
    if (!validEntry) {
      findings.push({
        category: 'agency-redirect',
        severity: 'critical',
        title: `${label}: 流入 URL の HTTP ステータスが異常です`,
        expected: 'HTTP 200 または 3xx',
        actual: `HTTP ${entryHop.status}`,
        url: entryHop.url,
      });
    }
    if (expectation.redirectMechanism === 'http' && !(entryHop.status >= 300 && entryHop.status < 400)) {
      findings.push({
        category: 'redirect-mechanism',
        severity: 'medium',
        title: `${label}: HTTP リダイレクトの仕様ですが 3xx が返っていません (警告)`,
        expected: 'HTTP 301 / 302 / 303 / 307 / 308',
        actual: `HTTP ${entryHop.status}`,
        url: entryHop.url,
      });
    }
  }

  if (chain.finalStatus !== null && chain.finalStatus >= 400) {
    findings.push({
      category: 'agency-redirect',
      severity: 'critical',
      title: `${label}: リダイレクト後のページが HTTP ${chain.finalStatus} を返しました`,
      expected: 'HTTP 200',
      actual: `HTTP ${chain.finalStatus}`,
      url: chain.finalUrl,
    });
  }

  return findings;
}

/**
 * 最終 URL に不要なパラメータや個人情報が付加されていないことを検証する。
 */
export function verifyUrlHygiene(url: string, config: QaConfig, label: string): FindingInput[] {
  const findings: FindingInput[] = [];
  const redirectConfig = config.agencies.redirect;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return findings;
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    if (!matchesAllowedParam(key, redirectConfig.allowedQueryParams)) {
      findings.push({
        category: 'security',
        severity: 'medium',
        title: `${label}: URL に不要なパラメータが付加されています: ${key}`,
        expected: `許可されたパラメータのみ (${redirectConfig.allowedQueryParams.join(', ')})`,
        actual: `${key} が付加されています`,
        url,
      });
    }

    const lowerKey = key.toLowerCase();
    if (redirectConfig.forbiddenQueryParamKeywords.some((keyword) => lowerKey.includes(keyword))) {
      findings.push({
        category: 'security',
        severity: 'critical',
        title: `${label}: URL に個人情報らしいパラメータが含まれています: ${key}`,
        expected: '個人情報を URL に付加しないこと',
        actual: `${key} が付加されています`,
        url,
      });
    }

    for (const pattern of redirectConfig.piiValuePatterns) {
      try {
        if (new RegExp(pattern).test(value)) {
          findings.push({
            category: 'security',
            severity: 'critical',
            title: `${label}: URL の値に個人情報らしい文字列が含まれています: ${key}`,
            expected: '個人情報を URL に付加しないこと',
            actual: `${key} の値がパターン ${pattern} に一致します`,
            url,
          });
          break;
        }
      } catch {
        /* 不正な正規表現は無視する */
      }
    }
  }

  return findings;
}

function matchesAllowedParam(key: string, allowed: string[]): boolean {
  return allowed.some((entry) => (entry.includes('*') ? matchesAnyGlob(key, [entry]) : entry === key));
}
