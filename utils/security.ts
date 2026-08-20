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
      // JavaScript / meta refresh による遷移は load 後に発生することがある。
      // 直後に URL を読むだけでは、遅延して起きる open redirect を見逃す。
      await page
        .waitForURL((url) => !permitted.includes(url.origin), { timeout: 2000 })
        .catch(() => undefined);
      finalOrigin = new URL(page.url()).origin;
    } catch (error) {
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
      // 検査できなかったことを記録する (黙って合格にしない)
      findings.push({
        category: 'security',
        severity: 'medium',
        title: `open redirect の検査を完了できませんでした: ${paramName}`,
        expected: 'ページが表示され、検査が実行できること',
        actual: message.split('\n')[0],
        url: target,
        detail: '検査未実施のため、この項目は「問題なし」とは言えません',
      });
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
/** 反射検出用のマーカー (DOM に要素が生成されたことを判定する) */
const PROBE_MARKER = 'qa-injection-probe';

/**
 * URL パラメータの値が HTML へそのまま出力されないこと、
 * および JavaScript が実行されないことを確認する。
 *
 * 検出方法についての注意:
 *   innerHTML とペイロード文字列の一致で判定してはならない。
 *   ブラウザは HTML を再シリアライズするため、実際に生の HTML が
 *   注入されていても文字列一致しない (偽陰性になる)。
 *   ここでは「ペイロードから要素が生成されたか」を DOM 検索で判定する。
 */
export async function checkParamInjection(
  page: Page,
  config: QaConfig,
  entryPath: string,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const security = config.agencies.security;

  // 代理店コードのパラメータに加え、リダイレクト用パラメータも試す
  const paramNames = Array.from(
    new Set([config.agency.paramName, ...security.redirectParamNames]),
  );

  for (const paramName of paramNames) {
    for (const payload of security.xssPayloads) {
      // マーカー付きの要素生成ペイロードを併用する。
      // 要素が生成されたかどうかは DOM 検索で確実に判定できる。
      const markedPayload = payload.includes('<')
        ? payload.replace(/<(\w+)/, `<$1 data-${PROBE_MARKER}="1"`)
        : payload;
      const target = pageUrl(config, entryPath, { [paramName]: markedPayload });

      let dialogOpened = false;
      const dialogHandler = async (dialog: { dismiss: () => Promise<void> }) => {
        dialogOpened = true;
        await dialog.dismiss().catch(() => undefined);
      };
      page.on('dialog', dialogHandler);

      try {
        await page.goto(target, { waitUntil: 'load', timeout: 20000 });
      } catch (error) {
        page.off('dialog', dialogHandler);
        // 検査できなかったことを記録する (黙って合格にしない)
        findings.push({
          category: 'security',
          severity: 'medium',
          title: `パラメータ注入の検査を完了できませんでした: ${paramName}`,
          expected: 'ページが表示され、検査が実行できること',
          actual: String(error).split('\n')[0],
          url: target,
          detail: '検査未実施のため、この項目は「問題なし」とは言えません',
        });
        continue;
      }

      // (1) JavaScript が実行されていないこと
      const executed = await page
        .evaluate(() => Boolean((window as unknown as { __qa_xss?: unknown }).__qa_xss))
        .catch(() => false);
      page.off('dialog', dialogHandler);

      if (executed || dialogOpened) {
        findings.push({
          category: 'security',
          severity: 'critical',
          title: `URL パラメータの値から JavaScript が実行されました: ${paramName}`,
          expected: 'パラメータ値がスクリプトとして実行されないこと',
          actual: dialogOpened ? 'ダイアログが表示されました' : 'ペイロードが実行されました',
          url: target,
          detail: `使用したペイロード: ${payload}`,
        });
      }

      // (2) ペイロードから要素が生成されていないこと (= 生の HTML が出力されている)
      const injected = await page
        .evaluate((marker: string) => {
          const byMarker = document.querySelector(`[data-${marker}]`) !== null;
          // マーカーを付けられないペイロード用: script / img[onerror] の増加を見る
          const suspicious = Array.from(document.querySelectorAll('script, img[onerror], svg[onload]'))
            .some((element) => (element.getAttribute('onerror') ?? element.getAttribute('onload') ?? '').includes('__qa_xss'));
          return byMarker || suspicious;
        }, PROBE_MARKER)
        .catch(() => false);

      if (injected) {
        findings.push({
          category: 'security',
          severity: 'critical',
          title: `URL パラメータの値が HTML としてそのまま出力されています: ${paramName}`,
          expected: 'パラメータ値をエスケープして出力すること (&lt; などに変換)',
          actual: 'ペイロードから要素が生成されました (DOM に出現)',
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
