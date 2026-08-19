/**
 * 別ドメインの申込ページへの代理店情報引き継ぎ検証。
 *
 * LP ドメインと申込ドメインは別ドメインであり、通常の Cookie は共有されない。
 * 引き継ぎ方法を推測せず、実際のネットワーク通信から観測して検証する。
 *
 * 検査項目:
 *   1. 遷移先ドメインが正しい
 *   2. 遷移先パスが正しい
 *   3. 代理店コードまたは引き継ぎ用トークンが送信されている
 *   4. 申込ページ側で正しい代理店として認識されている
 *   5. 申込ページを数画面進めても代理店情報が保持される
 *   6. 戻る・再読み込み後も保持される
 *   7. コードが欠落した場合に別代理店へ誤帰属しない
 *   8. 無効コードの場合に通常経路へフォールバックする
 *   9. 別の代理店コードに置き換わっていない
 *  10. 申込完了処理は実行しない
 *
 * URL にコードが載っていることだけでは合格にしない。
 * 一時トークン方式の場合、トークン文字列そのものは比較せず、
 * 「トークンが存在すること」と「申込側で復元された代理店」を検証する。
 */
import type { Page, Request } from '@playwright/test';
import { expectedApplicationHost, resolveSelector } from './config';
import { matchesAnyGlob } from './patterns';
import type {
  AgencySpec, FallbackExpectation, FindingInput, HandoffMethod, QaConfig, RecognitionCheck,
} from './types';

// ---------------------------------------------------------------------------
// 引き継ぎ通信の観測
// ---------------------------------------------------------------------------

export interface HandoffObservation {
  /** 申込ドメインへ送られたリクエスト */
  requests: Array<{
    url: string;
    method: string;
    resourceType: string;
    postData: string | null;
    hasCode: boolean;
    hasToken: boolean;
  }>;
  /** 観測された引き継ぎ方式 */
  detectedMethods: HandoffMethod[];
  /** 代理店コードが平文で観測された場所 */
  codeSeenIn: string[];
  /** トークンが観測された場所 */
  tokenSeenIn: string[];
  /** トークンの値 (レポートには出力せず、存在確認のみに使用する) */
  tokenValues: string[];
}

/** 申込ドメイン宛の通信を記録する */
export class HandoffRecorder {
  readonly observation: HandoffObservation = {
    requests: [],
    detectedMethods: [],
    codeSeenIn: [],
    tokenSeenIn: [],
    tokenValues: [],
  };

  private detached = false;
  private readonly onRequest: (request: Request) => void;

  constructor(
    private readonly page: Page,
    private readonly config: QaConfig,
    private readonly expectedCode: string,
    private readonly tokenParam: string,
  ) {
    const applicationHost = new URL(config.environment.applicationBaseUrl).host;

    this.onRequest = (request) => {
      let host: string;
      try {
        host = new URL(request.url()).host;
      } catch {
        return;
      }
      if (host !== applicationHost) return;

      const url = new URL(request.url());
      const postData = request.postData() ?? null;
      const queryCode = url.searchParams.get(config.agency.paramName);
      const queryToken = url.searchParams.get(tokenParam) ?? url.searchParams.get('handoff_token');
      const bodyCode = postData ? new URLSearchParams(postData).get(config.agency.paramName) : null;

      const hasCode = queryCode === expectedCode || bodyCode === expectedCode;
      const hasToken = Boolean(queryToken);

      this.observation.requests.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        postData,
        hasCode,
        hasToken,
      });

      if (queryCode) {
        this.record('query', `URL クエリ (${config.agency.paramName})`);
        if (queryCode === expectedCode) this.observation.codeSeenIn.push('URL クエリ');
      }
      if (queryToken) {
        this.record('token', `URL クエリ (${tokenParam})`);
        this.observation.tokenSeenIn.push('URL クエリ');
        this.observation.tokenValues.push(queryToken);
      }
      if (bodyCode) {
        this.record('post', 'POST ボディ');
        if (bodyCode === expectedCode) this.observation.codeSeenIn.push('POST ボディ');
      }
      if (request.method() === 'POST' && !bodyCode && postData) {
        this.record('post', 'POST ボディ (コードなし)');
      }
      if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch') {
        this.record('api', 'API リクエスト');
      }
    };

    page.on('request', this.onRequest);
  }

  private record(method: HandoffMethod, where: string): void {
    if (!this.observation.detectedMethods.includes(method)) {
      this.observation.detectedMethods.push(method);
    }
    void where;
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.page.off('request', this.onRequest);
  }
}

// ---------------------------------------------------------------------------
// 申込完了の防止
// ---------------------------------------------------------------------------

/**
 * 申込完了・データ送信のリクエストを遮断する安全装置。
 * 全環境で有効。発生した場合は Critical として報告する。
 */
export async function guardAgainstCompletion(
  page: Page,
  config: QaConfig,
  onViolation: (finding: FindingInput) => void,
): Promise<void> {
  const patterns = config.agency.application.forbiddenRequestPatterns;
  if (patterns.length === 0) return;

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (matchesAnyGlob(url, patterns)) {
      onViolation({
        category: 'agency-handoff',
        severity: 'critical',
        title: '申込完了・データ送信のリクエストが発生しました',
        expected: '申込完了処理を実行しないこと',
        actual: `${route.request().method()} ${url} を遮断しました`,
        url: page.url(),
      });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

export interface HandoffResult {
  findings: FindingInput[];
  /** 申込ページに到達できたか */
  reached: boolean;
}

/**
 * 引き継ぎに書き込み (非 GET) を伴う方式かどうか。
 * 読み取り専用環境ではフォーム送信が遮断されるため、実際の遷移は行わない。
 */
export function requiresWriteRequest(spec: AgencySpec): boolean {
  return spec.application.handoffMethod === 'post' || spec.application.handoffMethod === 'hidden';
}

/**
 * 読み取り専用環境向けの静的検証。
 *
 * フォーム送信を行わずに、DOM から読み取れる範囲だけを検証する:
 *   - CTA / フォームの遷移先ドメイン・パス
 *   - hidden 項目に設定された代理店コード
 * 実際の送信と申込側での認識は検証できないため、その旨を記録する。
 */
export async function verifyHandoffStatically(
  page: Page,
  config: QaConfig,
  spec: AgencySpec,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const url = page.url();
  const expectedHost = expectedApplicationHost(config, spec.application.expectedDomain);
  const expectedPath = spec.application.expectedPath.endsWith('/')
    ? spec.application.expectedPath
    : `${spec.application.expectedPath}/`;

  // CTA (リンク or フォーム) の遷移先を DOM から読み取る
  const target = await page.evaluate((testId: string) => {
    const element = document.querySelector(`[data-testid="${testId}"]`);
    if (!element) return null;
    const form = element.closest('form');
    if (form && form.getAttribute('action')) return { kind: 'form', href: (form as HTMLFormElement).action };
    if (element instanceof HTMLAnchorElement) return { kind: 'link', href: element.href };
    const nearestForm = document.querySelector('form[action]');
    return nearestForm ? { kind: 'form', href: (nearestForm as HTMLFormElement).action } : null;
  }, spec.cta.testId);

  if (!target?.href) {
    findings.push({
      category: 'agency-handoff',
      severity: 'high',
      title: `${spec.code}: CTA の遷移先を DOM から特定できません`,
      expected: `${expectedHost}${expectedPath} を指すリンクまたはフォームがあること`,
      actual: 'href / action を取得できませんでした',
      url,
    });
    return findings;
  }

  let parsed: URL;
  try {
    parsed = new URL(target.href, url);
  } catch {
    findings.push({
      category: 'agency-handoff',
      severity: 'high',
      title: `${spec.code}: CTA の遷移先 URL が不正です`,
      expected: '有効な URL',
      actual: target.href,
      url,
    });
    return findings;
  }

  if (parsed.host !== expectedHost) {
    findings.push({
      category: 'agency-handoff',
      severity: 'critical',
      title: `${spec.code}: 申込先ドメインが仕様と異なります (${target.kind} の遷移先)`,
      expected: expectedHost,
      actual: parsed.host,
      url,
    });
  }

  const actualPath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  if (actualPath !== expectedPath) {
    findings.push({
      category: 'agency-handoff',
      severity: 'critical',
      title: `${spec.code}: 申込ページのパスが仕様と異なります (${target.kind} の遷移先)`,
      expected: expectedPath,
      actual: actualPath,
      url,
    });
  }

  // hidden 項目に設定された代理店コード (送信せずに確認できる)
  const hiddenValue = await page
    .evaluate((paramName: string) => {
      const input = document.querySelector(`input[type="hidden"][name="${paramName}"]`);
      return input instanceof HTMLInputElement ? input.value : null;
    }, spec.application.handoffParam)
    .catch(() => null);

  if (hiddenValue !== null && hiddenValue !== spec.application.expectedCode) {
    findings.push({
      category: 'agency-handoff',
      severity: 'critical',
      title: `${spec.code}: hidden 項目の代理店コードが誤っています`,
      expected: spec.application.expectedCode,
      actual: hiddenValue === '' ? '(空)' : hiddenValue,
      url,
    });
  }
  if (hiddenValue === null && spec.application.handoffMethod !== 'query') {
    findings.push({
      category: 'agency-handoff',
      severity: 'high',
      title: `${spec.code}: 引き継ぎ用の hidden 項目が見つかりません`,
      expected: `input[type=hidden][name="${spec.application.handoffParam}"] が存在すること`,
      actual: '要素が存在しません',
      url,
    });
  }

  return findings;
}

/** CTA をクリックして申込ドメインへ遷移する */
export async function clickCtaToApplication(
  page: Page,
  spec: AgencySpec,
  config: QaConfig,
): Promise<{ navigated: boolean; error?: string }> {
  const selector = resolveSelector(spec.cta.testId);
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) {
    return { navigated: false, error: `CTA が存在しません: ${selector}` };
  }

  // 「期待するドメイン」ではなく「LP ドメイン以外へ移動したこと」を待つ。
  // 期待ドメインを待つと、誤ったドメインへ遷移した場合にタイムアウトになり、
  // 「遷移できなかった」と誤診断してしまう (実際は遷移先が違う)。
  const lpHost = new URL(config.environment.baseUrl).host;
  try {
    await Promise.all([
      page.waitForURL((url) => url.host !== lpHost, { timeout: 15000 }),
      locator.click(),
    ]);
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => undefined);
    return { navigated: true };
  } catch (error) {
    return { navigated: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** (1)(2) 遷移先のドメイン・パスを検証する */
export function verifyApplicationDestination(
  currentUrl: string,
  spec: AgencySpec,
  config: QaConfig,
): FindingInput[] {
  const findings: FindingInput[] = [];
  const expectedHost = expectedApplicationHost(config, spec.application.expectedDomain);

  let parsed: URL;
  try {
    parsed = new URL(currentUrl);
  } catch {
    return [
      {
        category: 'agency-handoff',
        severity: 'critical',
        title: `${spec.code}: 申込ページへ遷移できませんでした`,
        expected: `${expectedHost}${spec.application.expectedPath} へ遷移すること`,
        actual: `URL を取得できません (${currentUrl})`,
        url: currentUrl,
      },
    ];
  }

  if (parsed.host !== expectedHost) {
    findings.push({
      category: 'agency-handoff',
      severity: 'critical',
      title: `${spec.code}: 申込先ドメインが仕様と異なります`,
      expected: expectedHost,
      actual: parsed.host,
      url: currentUrl,
    });
  }

  const expectedPath = spec.application.expectedPath.endsWith('/')
    ? spec.application.expectedPath
    : `${spec.application.expectedPath}/`;
  const actualPath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  if (actualPath !== expectedPath) {
    findings.push({
      category: 'agency-handoff',
      severity: 'critical',
      title: `${spec.code}: 申込ページのパスが仕様と異なります`,
      expected: expectedPath,
      actual: actualPath,
      url: currentUrl,
    });
  }

  return findings;
}

/** (3) 代理店コードまたはトークンが送信されていることを検証する */
export function verifyHandoffTransport(
  observation: HandoffObservation,
  spec: AgencySpec,
  currentUrl: string,
): FindingInput[] {
  const findings: FindingInput[] = [];
  const method = spec.application.handoffMethod;
  const usesToken = method === 'token' || method === 'server-session';

  const documentRequests = observation.requests.filter((request) => request.resourceType === 'document');
  const codeSent = documentRequests.some((request) => request.hasCode) || observation.codeSeenIn.length > 0;
  const tokenSent = documentRequests.some((request) => request.hasToken) || observation.tokenSeenIn.length > 0;

  if (usesToken) {
    // トークン方式: トークンの存在のみを確認する (値は比較しない)
    if (!tokenSent) {
      findings.push({
        category: 'agency-handoff',
        severity: 'critical',
        title: `${spec.code}: 引き継ぎ用トークンが送信されていません`,
        expected: `申込ドメインへのリクエストに ${spec.application.handoffParam} が含まれること`,
        actual: 'トークンが観測されませんでした',
        url: currentUrl,
        detail: `観測した申込ドメイン宛リクエスト: ${documentRequests.length} 件`,
      });
    }
  } else if (!codeSent && !tokenSent) {
    findings.push({
      category: 'agency-handoff',
      severity: 'critical',
      title: `${spec.code}: 代理店コードが申込ドメインへ送信されていません`,
      expected: `${spec.application.handoffParam} = ${spec.application.expectedCode} が送信されること`,
      actual: '代理店コード・トークンのいずれも観測されませんでした',
      url: currentUrl,
      detail: `観測した申込ドメイン宛リクエスト: ${documentRequests.length} 件`,
    });
  }

  // 観測された方式が仕様と異なる場合は警告する (引き継ぎ方法を推測せず実測で確認する)
  const expectedObserved: Record<HandoffMethod, HandoffMethod[]> = {
    query: ['query'],
    hidden: ['post', 'query'],
    post: ['post'],
    api: ['api'],
    'server-session': ['token', 'api', 'query'],
    token: ['token'],
    none: [],
  };
  const acceptable = expectedObserved[method] ?? [];
  if (acceptable.length > 0 && !acceptable.some((entry) => observation.detectedMethods.includes(entry))) {
    findings.push({
      category: 'agency-handoff',
      severity: 'medium',
      title: `${spec.code}: 引き継ぎ方式が仕様と異なります (警告)`,
      expected: `${method} 方式`,
      actual:
        observation.detectedMethods.length > 0
          ? `観測した方式: ${observation.detectedMethods.join(', ')}`
          : '引き継ぎ通信を観測できませんでした',
      url: currentUrl,
      detail: 'config/agencies.yml の handoffMethod を実際の仕様に合わせてください (npm run discover で確認できます)',
    });
  }

  return findings;
}

/** (4)(9) 申込ページ側で正しい代理店として認識されているかを検証する */
export async function verifyRecognition(
  page: Page,
  config: QaConfig,
  spec: AgencySpec,
  label: string,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const url = page.url();

  for (const check of spec.application.recognition) {
    findings.push(...(await runRecognitionCheck(page, config, check, spec, label, url)));
  }

  // (9) 別の代理店コードに置き換わっていないこと
  const bodyText = ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ');
  for (const other of config.agencies.agencies) {
    if (other.code === spec.code) continue;
    for (const value of Object.values(other.expectedTexts ?? {})) {
      if (value && bodyText.includes(value)) {
        findings.push({
          category: 'agency-handoff',
          severity: 'critical',
          title: `${label}: 申込ページで別の代理店として認識されています (${other.code})`,
          expected: `${spec.code} として認識されること`,
          actual: `別代理店の情報「${value}」が申込ページに表示されています`,
          url,
        });
      }
    }
  }

  return findings;
}

async function runRecognitionCheck(
  page: Page,
  config: QaConfig,
  check: RecognitionCheck,
  spec: AgencySpec,
  label: string,
  url: string,
): Promise<FindingInput[]> {
  switch (check.type) {
    case 'text':
    case 'hidden': {
      const selector = resolveSelector(check.testId);
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) {
        return [
          {
            category: 'agency-handoff',
            severity: 'critical',
            title: `${label}: 申込ページで代理店を確認できません (${check.testId} が存在しない)`,
            expected: `${selector} に ${check.expected} が設定されていること`,
            actual: '要素が存在しません',
            url,
          },
        ];
      }
      const actual =
        check.type === 'hidden'
          ? await locator.inputValue().catch(async () => (await locator.getAttribute('value')) ?? '')
          : ((await locator.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      if (!actual.includes(check.expected)) {
        return [
          {
            category: 'agency-handoff',
            severity: 'critical',
            title: `${label}: 申込ページが認識している代理店が誤っています (${check.testId})`,
            expected: check.expected,
            actual: actual || '(空)',
            url,
          },
        ];
      }
      return [];
    }

    case 'storage': {
      const actual = await page
        .evaluate(
          ({ storageType, key }: { storageType: string; key: string }) => {
            try {
              if (storageType === 'sessionStorage') return window.sessionStorage.getItem(key);
              if (storageType === 'cookie') {
                const found = document.cookie
                  .split('; ')
                  .map((part) => part.split('='))
                  .find((pair) => decodeURIComponent(pair[0]) === key);
                return found ? decodeURIComponent(found.slice(1).join('=')) : null;
              }
              return window.localStorage.getItem(key);
            } catch {
              return null;
            }
          },
          { storageType: check.storageType, key: check.key },
        )
        .catch(() => null);

      if (actual !== check.expected) {
        return [
          {
            category: 'agency-handoff',
            severity: 'critical',
            title: `${label}: 申込ドメインの保存値が期待と異なります (${check.storageType}: ${check.key})`,
            expected: check.expected,
            actual: actual === null ? '保存値なし' : actual,
            url,
          },
        ];
      }
      return [];
    }

    case 'api': {
      // 申込側 API が返す代理店識別情報を確認する (読み取りのみ)
      const apiUrl = new URL(
        check.urlPattern.replace(/^\*\*/, '').replace(/\*$/, ''),
        config.environment.applicationBaseUrl,
      ).toString();
      const response = await page.request
        .get(apiUrl, { failOnStatusCode: false })
        .catch(() => null);
      if (!response || !response.ok()) {
        return [
          {
            category: 'agency-handoff',
            severity: 'high',
            title: `${label}: 申込側 API から代理店情報を取得できません`,
            expected: `${apiUrl} が 200 を返すこと`,
            actual: response ? `HTTP ${response.status()}` : 'リクエスト失敗',
            url,
          },
        ];
      }
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const actual = payload ? payload[check.field] : undefined;
      if (String(actual ?? '') !== check.expected) {
        return [
          {
            category: 'agency-handoff',
            severity: 'critical',
            title: `${label}: 申込側 API が返す代理店コードが誤っています`,
            expected: `${check.field} = ${check.expected}`,
            actual: actual === undefined || actual === null ? `${check.field} が含まれていません` : `${check.field} = ${String(actual)}`,
            url,
          },
        ];
      }
      return [];
    }

    default:
      return [];
  }
}

/** (5)(6) 申込フローを進めても・再読み込み・戻る操作後も代理店情報が保持されるか */
export async function verifyApplicationPersistence(
  page: Page,
  config: QaConfig,
  spec: AgencySpec,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];

  // (5) 数画面進める (申込完了はしない)
  for (const step of spec.application.steps) {
    const selector = resolveSelector(step.testId);
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      findings.push({
        category: 'agency-handoff',
        severity: 'high',
        title: `${spec.code}: 申込フローの次画面へ進む要素がありません: ${step.testId}`,
        expected: `${selector} が存在すること`,
        actual: '要素が存在しません',
        url: page.url(),
      });
      break;
    }
    await locator.click();
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => undefined);

    const actualPath = new URL(page.url()).pathname;
    const expectedPath = step.expectedPath.endsWith('/') ? step.expectedPath : `${step.expectedPath}/`;
    const normalizedActual = actualPath.endsWith('/') ? actualPath : `${actualPath}/`;
    if (normalizedActual !== expectedPath) {
      findings.push({
        category: 'agency-handoff',
        severity: 'high',
        title: `${spec.code}: 申込フローの遷移先が仕様と異なります`,
        expected: expectedPath,
        actual: normalizedActual,
        url: page.url(),
      });
    }

    findings.push(...(await verifyRecognition(page, config, spec, `${spec.code}: 申込 ${normalizedActual}`)));
  }

  // (6) 再読み込み後
  await page.reload({ waitUntil: 'load' }).catch(() => undefined);
  findings.push(...(await verifyRecognition(page, config, spec, `${spec.code}: 申込ページ再読み込み後`)));

  // (6) 戻る操作後
  if (spec.application.steps.length > 0) {
    await page.goBack({ waitUntil: 'load' }).catch(() => undefined);
    findings.push(...(await verifyRecognition(page, config, spec, `${spec.code}: 申込ページで戻る操作後`)));
  }

  return findings;
}

/** (7)(8) コード欠落・無効コード時に誤帰属せず通常経路へフォールバックするか */
export async function verifyFallbackHandoff(
  page: Page,
  config: QaConfig,
  expectation: FallbackExpectation,
  label: string,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const url = page.url();
  const application = expectation.application;

  if (application.expectDefaultRoute) {
    const selector = resolveSelector(application.defaultRouteTestId);
    const locator = page.locator(selector).first();
    const visible = (await locator.count()) > 0 && (await locator.isVisible());
    if (!visible) {
      findings.push({
        category: 'agency-handoff',
        severity: 'critical',
        title: `${label}: 申込ページが通常経路にフォールバックしていません`,
        expected: `${selector} が表示されること`,
        actual: (await locator.count()) === 0 ? '要素が存在しません' : '要素が非表示です',
        url,
      });
    }
  }

  for (const forbidden of application.forbiddenTestIds ?? []) {
    const selector = resolveSelector(forbidden);
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible())) {
      findings.push({
        category: 'agency-handoff',
        severity: 'critical',
        title: `${label}: 代理店として認識されてはならないのに代理店情報が表示されています`,
        expected: `${selector} が表示されないこと`,
        actual: '要素が表示されています',
        url,
      });
    }
  }

  // (7) いずれの代理店にも誤帰属していないこと
  const bodyText = ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ');
  for (const agency of config.agencies.agencies) {
    for (const value of Object.values(agency.expectedTexts ?? {})) {
      if (value && bodyText.includes(value)) {
        findings.push({
          category: 'agency-handoff',
          severity: 'critical',
          title: `${label}: 代理店コードがないのに ${agency.code} へ誤帰属しています`,
          expected: '代理店情報が表示されないこと',
          actual: `「${value}」が申込ページに表示されています`,
          url,
        });
      }
    }
  }

  return findings;
}
