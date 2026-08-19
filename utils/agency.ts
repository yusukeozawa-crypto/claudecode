/**
 * 代理店コードに関する共通処理。
 * URL パラメータ名・保存先・保存キー・期待表示はすべて config/agency.yml から取得する。
 */
import type { BrowserContext, Page } from '@playwright/test';
import { pageUrl, resolveAgencySelector } from './config';
import type {
  AgencyCodeSpec, AgencyExpectation, FindingInput, PageConfig, QaConfig,
} from './types';

/** 代理店コードの状態 (期待値の選択に使用) */
export type AgencyState = 'none' | 'valid' | 'invalid';

export function agencyState(config: QaConfig, code: string | null): AgencyState {
  if (!code) return 'none';
  const spec = findCode(config, code);
  return spec?.valid ? 'valid' : 'invalid';
}

export function findCode(config: QaConfig, code: string): AgencyCodeSpec | undefined {
  return config.agency.codes.find((entry) => entry.code === code);
}

export function validCodes(config: QaConfig): AgencyCodeSpec[] {
  return config.agency.codes.filter((entry) => entry.valid);
}

export function invalidCodes(config: QaConfig): AgencyCodeSpec[] {
  return config.agency.codes.filter((entry) => !entry.valid);
}

export function expectationFor(config: QaConfig, state: AgencyState): AgencyExpectation {
  return config.agency.expectations[state];
}

/** 代理店コード付きのページ URL を組み立てる */
export function urlWithCode(config: QaConfig, page: PageConfig, code: string | null): string {
  return code
    ? pageUrl(config, page.path, { [config.agency.paramName]: code })
    : pageUrl(config, page.path);
}

export interface StoredAgencyCode {
  cookie: string | null;
  localStorage: string | null;
}

/** Cookie / localStorage に保存された代理店コードを読み取る (値はログに出さない) */
export async function readStoredCode(page: Page, config: QaConfig): Promise<StoredAgencyCode> {
  const key = config.agency.storage.key;
  const cookies = await page.context().cookies();
  const cookie = cookies.find((entry) => entry.name === key)?.value ?? null;
  const fromLocalStorage = await page.evaluate((storageKey: string) => {
    try {
      return window.localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  }, key);
  return { cookie: cookie ? decodeURIComponent(cookie) : null, localStorage: fromLocalStorage };
}

/**
 * 保存先設定に応じた「保持されているコード」を返す。
 *   cookie / localStorage / both のいずれかで期待値を判定する
 */
export function effectiveStoredCode(stored: StoredAgencyCode, config: QaConfig): string | null {
  switch (config.agency.storage.type) {
    case 'cookie':
      return stored.cookie;
    case 'localStorage':
      return stored.localStorage;
    default:
      return stored.cookie ?? stored.localStorage;
  }
}

/** 保存先の説明 (レポート表示用) */
export function storageLabel(config: QaConfig): string {
  const { type, key } = config.agency.storage;
  const typeLabel = type === 'both' ? 'Cookie / localStorage' : type === 'cookie' ? 'Cookie' : 'localStorage';
  return `${typeLabel} (キー: ${key})`;
}

/** Cookie と localStorage の代理店コードを削除する */
export async function clearStoredCode(context: BrowserContext, page: Page, config: QaConfig): Promise<void> {
  await context.clearCookies();
  await page.evaluate((storageKey: string) => {
    try {
      window.localStorage.removeItem(storageKey);
      window.sessionStorage.removeItem(storageKey);
    } catch {
      /* storage が使えない環境では何もしない */
    }
  }, config.agency.storage.key);
}

/** 保存された代理店コードの検証 */
export function verifyStoredCode(
  stored: StoredAgencyCode,
  config: QaConfig,
  expectedCode: string | null,
  context: { url: string; label: string },
): FindingInput[] {
  const findings: FindingInput[] = [];
  const actual = effectiveStoredCode(stored, config);

  if (expectedCode === null) {
    if (actual !== null) {
      findings.push({
        category: 'agency-persistence',
        title: `${context.label}: 代理店コードが保存されないはずですが保存されています`,
        expected: `${storageLabel(config)} に代理店コードが保存されていないこと`,
        actual: `保存値あり (コード: ${actual})`,
        url: context.url,
      });
    }
    return findings;
  }

  if (actual !== expectedCode) {
    findings.push({
      category: 'agency-persistence',
      title: `${context.label}: 保存された代理店コードが期待と一致しません`,
      expected: `${storageLabel(config)} = ${expectedCode}`,
      actual: actual === null ? '保存値なし (コード欠落)' : `保存値 = ${actual}`,
      url: context.url,
    });
  }

  // both 指定の場合は Cookie と localStorage の不整合も検出する
  if (config.agency.storage.type === 'both' && stored.cookie !== null && stored.localStorage !== null) {
    if (stored.cookie !== stored.localStorage) {
      findings.push({
        category: 'agency-persistence',
        severity: 'high',
        title: `${context.label}: Cookie と localStorage の代理店コードが一致しません`,
        expected: 'Cookie と localStorage が同一の代理店コードであること',
        actual: `Cookie=${stored.cookie} / localStorage=${stored.localStorage}`,
        url: context.url,
      });
    }
  }

  return findings;
}

/** 条件ごとの表示・非表示と表示文言の検証 */
export async function verifyDisplay(
  page: Page,
  config: QaConfig,
  state: AgencyState,
  codeSpec: AgencyCodeSpec | undefined,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const expectation = expectationFor(config, state);
  const url = page.url();

  for (const key of expectation.visible) {
    const selector = resolveAgencySelector(config, key);
    const locator = page.locator(selector).first();
    const visible = (await locator.count()) > 0 && (await locator.isVisible());
    if (!visible) {
      findings.push({
        category: 'agency-display',
        title: `表示されるべき要素が表示されていません: ${key}`,
        expected: `${selector} が表示されること (状態: ${state})`,
        actual: (await page.locator(selector).count()) === 0 ? '要素が存在しません' : '要素が非表示です',
        url,
      });
    }
  }

  for (const key of expectation.hidden) {
    const selector = resolveAgencySelector(config, key);
    const locator = page.locator(selector).first();
    const visible = (await locator.count()) > 0 && (await locator.isVisible());
    if (visible) {
      findings.push({
        category: 'agency-display',
        title: `非表示であるべき要素が表示されています: ${key}`,
        expected: `${selector} が非表示であること (状態: ${state})`,
        actual: '要素が表示されています',
        url,
      });
    }
  }

  for (const [key, expectedText] of Object.entries(expectation.texts ?? {})) {
    const selector = resolveAgencySelector(config, key);
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      findings.push({
        category: 'agency-display',
        title: `期待文言の対象要素が存在しません: ${key}`,
        expected: `${selector} に「${expectedText}」が表示されること`,
        actual: '要素が存在しません',
        url,
      });
      continue;
    }
    const actualText = ((await locator.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    if (!actualText.includes(expectedText)) {
      findings.push({
        category: 'agency-display',
        title: `期待文言が表示されていません: ${key}`,
        expected: `「${expectedText}」を含むこと`,
        actual: actualText || '(空)',
        url,
      });
    }
  }

  // 有効コードの場合は代理店名・連絡先の内容を検証する
  if (state === 'valid' && codeSpec) {
    const checks: Array<{ key: string; expected?: string; label: string }> = [
      { key: 'agencyName', expected: codeSpec.expectedName, label: '代理店名' },
      { key: 'agencyContact', expected: codeSpec.expectedContact, label: '電話番号' },
    ];
    for (const check of checks) {
      if (!check.expected) continue;
      const selector = resolveAgencySelector(config, check.key);
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) {
        findings.push({
          category: 'agency-display',
          title: `${check.label}の表示要素が存在しません`,
          expected: `${selector} に「${check.expected}」が表示されること`,
          actual: '要素が存在しません',
          url,
        });
        continue;
      }
      const actualText = ((await locator.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      if (!actualText.includes(check.expected)) {
        findings.push({
          category: 'agency-display',
          title: `${check.label}が誤っています (代理店の誤表示)`,
          expected: check.expected,
          actual: actualText || '(空)',
          url,
          detail: `代理店コード ${codeSpec.code} に対する表示`,
        });
      }
    }
  }

  return findings;
}
