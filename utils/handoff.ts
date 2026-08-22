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
import type { BrowserContext, Page, Request } from '@playwright/test';
import { expectedApplicationHost, resolveSelector } from './config';
import { maskUrl } from './secrets';
import { matchesAnyGlob } from './patterns';
import type {
  AgencySpec, AgencySpecWithApplication, FallbackExpectation, FindingInput, HandoffMethod, QaConfig, RecognitionCheck,
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

/**
 * POST ボディから代理店コードを取り出す。
 * フォーム形式 (application/x-www-form-urlencoded) と JSON の双方に対応する。
 * 実サイトの引き継ぎが JSON API の場合に「送信されていない」と誤判定しないため。
 */
function extractCodeFromBody(postData: string, paramName: string): string | null {
  const fromForm = new URLSearchParams(postData).get(paramName);
  if (fromForm) return fromForm;

  try {
    const parsed = JSON.parse(postData) as unknown;
    const found = findValueByKey(parsed, paramName);
    if (found !== null) return found;
  } catch {
    /* JSON ではない */
  }
  return null;
}

/** ネストしたオブジェクトから指定キーの値を探す */
function findValueByKey(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findValueByKey(entry, key);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryKey === key && (typeof entryValue === 'string' || typeof entryValue === 'number')) {
      return String(entryValue);
    }
    const found = findValueByKey(entryValue, key);
    if (found !== null) return found;
  }
  return null;
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
      // tokenParam が代理店コードのパラメータ名と同一の場合 (query 方式) は、
      // コードをトークンとして数えない。数えると誤ったコードでも
      // 「トークンあり」となり Critical が抑止されてしまう。
      const tokenParamIsCode = tokenParam === config.agency.paramName;
      const queryToken = tokenParamIsCode
        ? url.searchParams.get('handoff_token')
        : (url.searchParams.get(tokenParam) ?? url.searchParams.get('handoff_token'));
      const bodyCode = postData ? extractCodeFromBody(postData, config.agency.paramName) : null;

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
 * 申込完了・データ送信のリクエストかどうか。
 *
 * これは「本番で申込を完了させない」最後の防衛線なので、
 * URL の形が少し違うだけで判定を漏らしてはならない。
 * 次を正規化してから照合する。
 *   - クエリ / フラグメントを除去 (`?next=/thanks` のように値に "/" が入ると
 *     glob の "*" ([^/]*) が一致しなくなる)
 *   - 末尾スラッシュの有無を両方試す
 *   - 大文字小文字を無視する
 */
export function isForbiddenRequest(url: string, config: QaConfig): boolean {
  const patterns = config.agency.application.forbiddenRequestPatterns;
  if (patterns.length === 0) return false;

  const candidates = new Set<string>([url]);

  let withoutQuery = url;
  try {
    const parsed = new URL(url);
    withoutQuery = `${parsed.origin}${parsed.pathname}`;
  } catch {
    withoutQuery = url.split('#')[0].split('?')[0];
  }
  candidates.add(withoutQuery);
  candidates.add(withoutQuery.replace(/\/+$/, ''));
  candidates.add(`${withoutQuery.replace(/\/+$/, '')}/`);

  const lowerPatterns = patterns.map((pattern) => pattern.toLowerCase());
  for (const candidate of candidates) {
    if (matchesAnyGlob(candidate, patterns)) return true;
    if (matchesAnyGlob(candidate.toLowerCase(), lowerPatterns)) return true;
  }
  return false;
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
export function requiresWriteRequest(spec: AgencySpecWithApplication): boolean {
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
  spec: AgencySpecWithApplication,
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

/**
 * 安全装置をページに設置する。
 *
 * route は「後から登録したハンドラが優先」されるため、判定は 1 つのハンドラで行う。
 * フィクスチャのページだけでなく、テストが独自に作った context / page にも
 * 設置する必要がある (route は Page 単位で、新しいタブや別 context には効かない)。
 */
export async function installRequestGuards(
  page: Page,
  config: QaConfig,
  onViolation?: (finding: FindingInput) => void,
): Promise<void> {
  const readOnly = config.environment.readOnly;
  const hasForbidden = config.agency.application.forbiddenRequestPatterns.length > 0;
  if (!readOnly && !hasForbidden) return;

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method().toUpperCase();

    if (hasForbidden && isForbiddenRequest(url, config)) {
      onViolation?.({
        category: 'agency-handoff',
        severity: 'critical',
        title: '申込完了・データ送信のリクエストが発生しました',
        expected: '申込完了処理を実行しないこと',
        actual: `${method} ${url} を遮断しました`,
        url: page.url(),
      });
      await route.abort('blockedbyclient');
      return;
    }

    if (readOnly && !READ_ONLY_METHODS.has(method)) {
      // URL に一時トークンや個人情報が含まれ得るためマスクして出力する
      console.warn(`[qa] 読み取り専用環境のため ${method} リクエストを遮断しました: ${maskUrl(url, config)}`);
      await route.abort('blockedbyclient');
      return;
    }

    await route.continue();
  });
}

/** 読み取り専用環境で許可する HTTP メソッド */
export const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 新しく作った context の全ページ (既存 + 今後開かれるタブ) に安全装置を設置する。
 * CTA が target="_blank" で開く場合も遮断されるようにする。
 */
export async function installContextGuards(
  context: BrowserContext,
  config: QaConfig,
  onViolation?: (finding: FindingInput) => void,
): Promise<void> {
  for (const existing of context.pages()) {
    await installRequestGuards(existing, config, onViolation);
  }
  context.on('page', (opened) => {
    void installRequestGuards(opened, config, onViolation);
  });
}

/**
 * API リクエスト (APIRequestContext) 用のガード。
 *
 * route はブラウザのリクエストにしか効かないため、
 * request.fetch / page.request.* はこのヘルパー経由で行う。
 * 禁止 URL と、読み取り専用環境での書き込みメソッドを拒否する。
 */
export function assertRequestAllowed(
  url: string,
  method: string,
  config: QaConfig,
): { allowed: true } | { allowed: false; reason: string } {
  if (isForbiddenRequest(url, config)) {
    return { allowed: false, reason: '申込完了・データ送信の URL のため実行しません' };
  }
  if (config.environment.readOnly && !READ_ONLY_METHODS.has(method.toUpperCase())) {
    return {
      allowed: false,
      reason: `読み取り専用環境では ${method.toUpperCase()} リクエストを実行しません`,
    };
  }
  return { allowed: true };
}

/** CTA をクリックして申込ドメインへ遷移する */
export async function clickCtaToApplication(
  page: Page,
  spec: AgencySpecWithApplication,
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
  spec: AgencySpecWithApplication,
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
  spec: AgencySpecWithApplication,
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
  spec: AgencySpecWithApplication,
  label: string,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const url = page.url();

  for (const check of spec.application.recognition) {
    findings.push(...(await runRecognitionCheck(page, config, check, spec, label, url)));
  }

  // (9) 別の代理店コードに置き換わっていないこと
  const bodyText = ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ');
  const ownValues = Object.values(spec.expectedTexts ?? {});
  for (const other of config.agencies.agencies) {
    if (other.code === spec.code) continue;
    for (const value of Object.values(other.expectedTexts ?? {})) {
      // 自代理店の表示値に含まれる文字列は対象外 (部分一致による誤検知の防止)
      if (!value || ownValues.some((own) => own === value || own.includes(value))) continue;
      if (bodyText.includes(value)) {
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
  spec: AgencySpecWithApplication,
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
  spec: AgencySpecWithApplication,
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

/** 申込サイトへ向かうリンク / フォームの観測結果 */
export interface ApplicationLinkInfo {
  kind: 'link' | 'form';
  /** 表示テキスト (どのボタンかを人が判別するため) */
  text: string;
  /** 申込サイト側のパス */
  path: string;
  /** 遷移先の絶対 URL (押す・直接開くために使う) */
  url: string;
  /** 代理店コードが URL に乗っているか */
  hasCode: boolean;
  /** 画面に表示されているか */
  visible: boolean;
}

/**
 * 申込サイトへの導線を DOM から観測する。
 *
 * 引き継ぎ方式 (どこにコードが乗るか) が未確定でも実行できる検査。
 * クリックも送信も行わないため、本番の読み取り専用環境でも安全に実行できる。
 *
 * 「リンクが見つからない」= 不具合とは断定しない。
 * JavaScript で遷移するボタンは DOM からは分からないため、
 * 断定せず記録し、実測 (npm run discover) で確定させる。
 */
export async function observeApplicationLinks(
  page: Page,
  config: QaConfig,
  agencyCode: string | null,
): Promise<ApplicationLinkInfo[]> {
  const expectedHost = expectedApplicationHost(config, null);
  const paramName = config.agency.paramName;

  const raw = await page
    .evaluate(() => {
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
      };
      const text = (element: Element): string =>
        (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

      const links = Array.from(document.querySelectorAll('a[href]')).map((element) => ({
        kind: 'link' as const,
        href: (element as HTMLAnchorElement).href,
        text: text(element),
        visible: isVisible(element),
      }));
      const forms = Array.from(document.querySelectorAll('form[action]')).map((element) => ({
        kind: 'form' as const,
        href: (element as HTMLFormElement).action,
        text: text(element) || '(フォーム)',
        visible: isVisible(element),
      }));
      return [...links, ...forms];
    })
    .catch(() => [] as Array<{ kind: 'link' | 'form'; href: string; text: string; visible: boolean }>);

  const found: ApplicationLinkInfo[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let parsed: URL;
    try {
      parsed = new URL(entry.href);
    } catch {
      continue;
    }
    if (parsed.host !== expectedHost) continue;
    const key = `${entry.kind}|${parsed.pathname}|${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      kind: entry.kind,
      text: entry.text,
      path: parsed.pathname,
      url: parsed.toString(),
      hasCode: agencyCode !== null && parsed.searchParams.get(paramName) === agencyCode,
      visible: entry.visible,
    });
  }
  return found;
}

/**
 * 申込導線が生きているかを記録する。
 *
 * 引き継ぎ方式が未確定な段階でも「申込サイトへ行けるか」「コードが URL に乗るか」
 * を実測して残す。断定できない部分は Medium 以下で記録し、
 * 推測で Critical を出さない (正常なサイトを不具合として報告しないため)。
 */
export function describeApplicationLinks(
  links: ApplicationLinkInfo[],
  config: QaConfig,
  agencyCode: string | null,
  url: string,
): FindingInput[] {
  const expectedHost = expectedApplicationHost(config, null);
  const visible = links.filter((link) => link.visible);

  if (links.length === 0) {
    return [
      {
        category: 'agency-handoff',
        severity: 'medium',
        title: '申込サイトへのリンクを DOM から見つけられませんでした',
        expected: `${expectedHost} を指すリンクまたはフォームがあること`,
        actual: 'リンク・フォームのいずれも見つかりません',
        url,
        agencyCode: agencyCode ?? 'none',
        detail:
          'JavaScript でボタン遷移している場合は DOM からは分かりません。' +
          'npm run discover で CTA をクリックして実際の遷移先と引き継ぎ方式を確定してください。',
      },
    ];
  }

  const sample = (visible.length > 0 ? visible : links)
    .slice(0, 5)
    .map((link) => `${link.kind === 'form' ? '[フォーム] ' : ''}「${link.text || '(テキストなし)'}」→ ${link.path}${link.hasCode ? ` (${config.agency.paramName} あり)` : ''}`)
    .join(' / ');

  const findings: FindingInput[] = [
    {
      category: 'agency-handoff',
      severity: 'low',
      title: '[確認OK] 申込サイトへの導線を確認しました',
      expected: `${expectedHost} への導線があること`,
      actual: `${links.length} 件 (表示中 ${visible.length} 件): ${sample}`,
      url,
      agencyCode: agencyCode ?? 'none',
      detail: '「文言」がボタンの表示名です。config/agency.yml の selectors.ctaPrimary はこの文言に合わせてください。',
    },
  ];

  // コードありで入ったのに、どのリンクにもコードが乗っていない場合は
  // クエリ以外の方式 (Cookie / サーバーセッション / JS) の可能性がある。
  // 方式を確定していない段階では不具合と断定せず、実測すべき事実として残す。
  if (agencyCode !== null && !links.some((link) => link.hasCode)) {
    findings.push({
      category: 'agency-handoff',
      severity: 'low',
      title: '申込サイトへのリンクに代理店コードが乗っていません',
      expected: `${config.agency.paramName}=${agencyCode} がリンクに含まれる (クエリ方式の場合)`,
      actual: 'リンクの URL にコードが含まれていません',
      url,
      agencyCode,
      detail:
        'クエリ以外の方式 (Cookie / サーバーセッション / クリック時に JavaScript が付与) の可能性があります。' +
        'npm run discover で実際の通信を確認してください。',
    });
  }

  return findings;
}

/** 申込フォーム側でコードが「どこに」残っていたか */
export interface CodeCarryObservation {
  /** コードの値が実際に見つかった場所 (人が読める説明) */
  foundIn: string[];
  /**
   * 参考情報。値ではなく「入れ物」があっただけのもの
   *   (例: agency_code という項目はあるが空)。
   * これを根拠に合格にしてはいけない。
   */
  hints: string[];
  /** 別の代理店コードが見つかった場合 (誤帰属) */
  otherCodes: string[];
  url: string;
}

/**
 * 申込フォームに遷移しても代理店コードが維持されているかを観測する。
 *
 * 引き継ぎ方式 (クエリ / hidden / Cookie / セッション / API) が
 * 確定していなくても検査できるように、**あり得る置き場所すべて**を見る。
 * どこか 1 つでも残っていれば「維持されている」とみなす。
 * 方式を推測して 1 か所だけ見ると、正常なサイトを不具合として報告してしまう。
 */
export async function observeCodeInApplication(
  page: Page,
  config: QaConfig,
  code: string,
  otherCandidates: string[] = [],
): Promise<CodeCarryObservation> {
  const paramName = config.agency.paramName;
  const url = page.url();
  const foundIn: string[] = [];

  // 1. URL (クエリ・パス)
  if (url.includes(code)) foundIn.push('URL');

  const inPage = await page
    .evaluate(
      ({ target, param }: { target: string; param: string }) => {
        const places: string[] = [];
        const collect = (label: string, values: Array<string | null | undefined>) => {
          if (values.some((value) => typeof value === 'string' && value.includes(target))) places.push(label);
        };

        // 2. hidden を含む入力値
        const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
        collect('入力値 (hidden 含む)', inputs.map((element) => (element as HTMLInputElement).value));

        // 3. 画面に表示されているテキスト
        collect('表示テキスト', [document.body?.innerText ?? '']);

        // 4. data 属性 (data-agency-code など)
        const dataValues: string[] = [];
        for (const element of Array.from(document.querySelectorAll('[data-agency-code], [data-agency], [data-code]'))) {
          for (const attribute of Array.from(element.attributes)) dataValues.push(attribute.value);
        }
        collect('data 属性', dataValues);

        // 5. localStorage / sessionStorage
        const readStorage = (storage: Storage | null): string[] => {
          if (!storage) return [];
          const values: string[] = [];
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key) values.push(`${key}=${storage.getItem(key) ?? ''}`);
          }
          return values;
        };
        collect('localStorage', readStorage(window.localStorage));
        collect('sessionStorage', readStorage(window.sessionStorage));

        // 6. JavaScript の変数として埋め込まれている場合 (dataLayer など)
        const globals = (window as unknown as { dataLayer?: unknown }).dataLayer;
        if (globals) {
          try {
            collect('dataLayer', [JSON.stringify(globals)]);
          } catch {
            // 循環参照などで文字列化できない場合は無視する
          }
        }

        // 7. 参考情報: 代理店コードの項目が「ある」だけ (値は空かもしれない)。
        //    これは合格の根拠にしない
        const hints: string[] = [];
        if (document.querySelector(`[name="${param}"]`)) hints.push(`${param} という項目がある (値は別途確認)`);
        return { places, hints };
      },
      { target: code, param: paramName },
    )
    .catch(() => ({ places: [] as string[], hints: [] as string[] }));
  foundIn.push(...inPage.places);

  // 8. Cookie (申込ドメインのもの)
  const cookies = await page.context().cookies(url).catch(() => []);
  if (cookies.some((cookie) => cookie.value.includes(code))) foundIn.push('Cookie');

  // 別の代理店コードが入っていないか (誤帰属の検知)
  const otherCodes: string[] = [];
  if (otherCandidates.length > 0) {
    const haystack = [url, ...cookies.map((cookie) => cookie.value)].join(' ');
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    for (const candidate of otherCandidates) {
      if (candidate === code) continue;
      if (haystack.includes(candidate) || bodyText.includes(candidate)) otherCodes.push(candidate);
    }
  }

  return { foundIn: [...new Set(foundIn)], hints: inPage.hints, otherCodes, url };
}

/**
 * LP 側で代理店コードが付与されているかを検証する。
 *
 * 専用 LP へのリダイレクト後はコードが URL から消えるため、
 * 「URL にコードが載っている」ことでは判定できない。
 * URL / 入力値 / 保存領域 / Cookie / dataLayer のいずれかに
 * 残っていれば付与されているとみなす (方式を問わない)。
 */
export function verifyCodeApplied(
  observation: CodeCarryObservation,
  code: string,
  label: string,
): FindingInput[] {
  if (observation.foundIn.length === 0) {
    return [
      {
        checkId: 'code-applied',
        category: 'agency-persistence',
        severity: 'critical',
        title: `${label}: 代理店コードが付与されていません`,
        expected: `ページ側に ${code} が保持されていること`,
        actual: 'URL・入力値・表示テキスト・保存領域・Cookie のいずれにも見つかりません',
        url: observation.url,
        agencyCode: code,
        detail: [
          'この状態では以降の遷移でこの代理店として扱われません。',
          observation.hints.length > 0 ? `参考: ${observation.hints.join(', ')}` : '',
        ]
          .filter((part) => part !== '')
          .join(' '),
      },
    ];
  }

  return [
    {
      checkId: 'code-applied',
      category: 'agency-persistence',
      severity: 'low',
      title: `[確認OK] ${label}: 代理店コードが付与されています`,
      expected: `ページ側に ${code} が保持されていること`,
      actual: `見つかった場所: ${observation.foundIn.join(', ')}`,
      url: observation.url,
      agencyCode: code,
    },
  ];
}

/**
 * 申込フォームに遷移しても代理店コードが維持されているかを検証する。
 *
 * 維持されていない = その申込が代理店に帰属しない (売上に直結) ため Critical。
 * 別の代理店コードに置き換わっている場合も Critical (誤帰属)。
 */
export function verifyCodeCarried(
  observation: CodeCarryObservation,
  code: string,
  label: string,
): FindingInput[] {
  const findings: FindingInput[] = [];

  if (observation.foundIn.length === 0) {
    findings.push({
      checkId: 'code-carry',
      observedValue: 'なし',
      expectedValue: 'あり',
      category: 'agency-handoff',
      severity: 'critical',
      title: `${label}: 申込フォームに代理店コードが引き継がれていません`,
      expected: `申込フォーム側に ${code} が保持されていること`,
      actual: 'URL・入力値・表示テキスト・保存領域・Cookie のいずれにも見つかりません',
      url: observation.url,
      agencyCode: code,
      detail: [
        'この状態では申込がこの代理店に帰属しません。',
        // 「項目はあるが空」は不具合の手がかりになるので示す
        observation.hints.length > 0 ? `参考: ${observation.hints.join(', ')}` : '',
      ]
        .filter((part) => part !== '')
        .join(' '),
    });
  } else {
    findings.push({
      checkId: 'code-carry',
      observedValue: 'あり',
      expectedValue: 'あり',
      category: 'agency-handoff',
      severity: 'low',
      title: `[確認OK] ${label}: 申込フォームに代理店コードが引き継がれています`,
      expected: `申込フォーム側に ${code} が保持されていること`,
      actual: `見つかった場所: ${observation.foundIn.join(', ')}`,
      url: observation.url,
      agencyCode: code,
    });
  }

  for (const other of observation.otherCodes) {
    findings.push({
      checkId: 'code-carry',
      category: 'agency-handoff',
      severity: 'critical',
      title: `${label}: 別の代理店コードが申込フォームに現れています`,
      expected: `${code} 以外の代理店コードが現れないこと`,
      actual: `${other} が見つかりました`,
      url: observation.url,
      agencyCode: code,
    });
  }

  return findings;
}
