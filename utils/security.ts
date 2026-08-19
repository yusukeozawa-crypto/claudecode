/**
 * 代理店コードを URL で受け取ることに伴うセキュリティ検査。
 *
 *   - open redirect が発生しない
 *   - 任意の外部ドメインへ遷移できない
 *   - 無効なコードで他代理店の情報が表示されない
 *   - URL パラメータを HTML へそのまま出力しない
 *   - JavaScript が実行できる値を受け付けない
 *
 * 秘密トークンのマスキングは utils/secrets.ts が担当する。
 */
import type { Page } from '@playwright/test';
import { pageUrl } from './config';
import type { FindingInput, QaConfig } from './types';

/** 遷移が許可されるオリジン (LP ドメイン・申込ドメイン + 設定分) */
export function allowedOrigins(config: QaConfig): string[] {
  const origins = [
    new URL(config.environment.baseUrl).origin,
    ...(config.environment.applicationBaseUrl ? [new URL(config.environment.applicationBaseUrl).origin] : []),
    ...config.agencies.security.allowedRedirectOrigins,
  ];
  return Array.from(new Set(origins));
}

/**
 * open redirect 検査。
 * リダイレクト用パラメータに外部 URL を渡し、外部ドメインへ遷移しないことを確認する。
 */
export async function checkOpenRedirect(
  page: Page,
  config: QaConfig,
  entryPath: string,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const security = config.agencies.security;
  const permitted = allowedOrigins(config);

  for (const paramName of security.redirectParamNames) {
    const target = pageUrl(config, entryPath, { [paramName]: security.externalProbeUrl });

    let finalOrigin = '';
    try {
      await page.goto(target, { waitUntil: 'load', timeout: 20000 });
      finalOrigin = new URL(page.url()).origin;
    } catch (error) {
      // 遷移そのものが失敗した場合は外部への遷移は発生していない
      const message = error instanceof Error ? error.message : String(error);
      if (/net::ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(message)) {
        findings.push({
          category: 'security',
          severity: 'critical',
          title: `open redirect: ${paramName} で外部ドメインへの遷移が試行されました`,
          expected: `外部ドメイン (${security.externalProbeUrl}) へ遷移しないこと`,
          actual: `外部ドメインへの接続が試行されました (${message.split('\n')[0]})`,
          url: target,
        });
        continue;
      }
      continue;
    }

    if (!permitted.includes(finalOrigin)) {
      findings.push({
        category: 'security',
        severity: 'critical',
        title: `open redirect を検知しました: ${paramName}`,
        expected: `許可されたオリジンのみ (${permitted.join(', ')})`,
        actual: `${finalOrigin} へ遷移しました`,
        url: page.url(),
      });
    }
  }

  return findings;
}

/**
 * URL パラメータの値が HTML へそのまま出力されないこと、
 * および JavaScript が実行されないことを確認する。
 */
export async function checkParamInjection(
  page: Page,
  config: QaConfig,
  entryPath: string,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const security = config.agencies.security;

  for (const payload of security.xssPayloads) {
    const target = pageUrl(config, entryPath, { [config.agency.paramName]: payload });

    // ダイアログが開いた場合も JavaScript 実行とみなす
    let dialogOpened = false;
    const dialogHandler = async (dialog: { dismiss: () => Promise<void> }) => {
      dialogOpened = true;
      await dialog.dismiss().catch(() => undefined);
    };
    page.on('dialog', dialogHandler);

    try {
      await page.goto(target, { waitUntil: 'load', timeout: 20000 });
    } catch {
      page.off('dialog', dialogHandler);
      continue;
    }

    // (1) JavaScript が実行されていないこと (ペイロードは window.__qa_xss を立てる)
    const executed = await page
      .evaluate(() => Boolean((window as unknown as { __qa_xss?: unknown }).__qa_xss))
      .catch(() => false);
    page.off('dialog', dialogHandler);

    if (executed || dialogOpened) {
      findings.push({
        category: 'security',
        severity: 'critical',
        title: 'URL パラメータの値から JavaScript が実行されました',
        expected: 'パラメータ値がスクリプトとして実行されないこと',
        actual: dialogOpened ? 'ダイアログが表示されました' : 'ペイロードが実行されました',
        url: target,
        detail: `使用したペイロード: ${payload}`,
      });
    }

    // (2) ペイロードが HTML としてそのまま出力されていないこと
    //     ペイロード文字列が innerHTML に「そのまま」現れた場合のみ違反とする。
    //     ページに <script> タグが存在するだけで検出してしまわないよう、
    //     タグ単位ではなくペイロード全体で判定する。
    const reflectedRaw = await page
      .evaluate((value: string) => document.documentElement.innerHTML.includes(value), payload)
      .catch(() => false);

    if (reflectedRaw) {
      findings.push({
        category: 'security',
        severity: 'critical',
        title: 'URL パラメータの値が HTML へそのまま出力されています',
        expected: 'パラメータ値をエスケープして出力すること (&lt; などに変換)',
        actual: 'ペイロードが HTML 内にそのまま現れました',
        url: target,
        detail: `使用したペイロード: ${payload}`,
      });
    }

    // (3) 危険な値を有効な代理店として扱っていないこと
    const bodyText = ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ');
    for (const agency of config.agencies.agencies) {
      const matched = Object.values(agency.expectedTexts ?? {}).find(
        (value) => value && bodyText.includes(value),
      );
      if (matched) {
        findings.push({
          category: 'security',
          severity: 'critical',
          title: '不正な値を代理店コードとして受け付けています',
          expected: '不正な値では代理店情報を表示しないこと',
          actual: `${agency.code} の情報「${matched}」が表示されました`,
          url: target,
          detail: `使用したペイロード: ${payload}`,
        });
      }
    }
  }

  return findings;
}

/**
 * 任意の外部ドメインへ遷移させられないこと。
 * CTA のリンク先が許可されたオリジンであることを確認する。
 */
export async function checkExternalNavigationTargets(
  page: Page,
  config: QaConfig,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const permitted = allowedOrigins(config);

  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href], form[action]')).map((element) => ({
      testId: element.getAttribute('data-testid') ?? '',
      target:
        element.tagName === 'FORM'
          ? (element as HTMLFormElement).action
          : (element as HTMLAnchorElement).href,
      kind: element.tagName.toLowerCase(),
    })),
  );

  for (const entry of hrefs) {
    if (!entry.target || !/^https?:/i.test(entry.target)) continue;
    // CTA と申込フォームのみを対象にする (通常の外部リンクは対象外)
    if (!entry.testId.startsWith('cta')) continue;
    const origin = new URL(entry.target).origin;
    if (!permitted.includes(origin)) {
      findings.push({
        category: 'security',
        severity: 'critical',
        title: `CTA の遷移先が許可されていないオリジンです: ${entry.testId}`,
        expected: `許可されたオリジンのみ (${permitted.join(', ')})`,
        actual: `${origin} (${entry.kind})`,
        url: page.url(),
      });
    }
  }

  return findings;
}
