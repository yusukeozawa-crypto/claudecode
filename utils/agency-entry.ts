/**
 * 代理店コードでの流入処理。
 *
 * 代理店ごとにリダイレクトの有無・方式が異なるため、
 * 「流入 → (リダイレクト) → 最終 LP の描画完了」までを待ってから検査する。
 * meta refresh / JavaScript による遷移は非同期に発生するため、
 * この待機を省くと遷移前の状態を検査してしまう。
 */
import type { Page } from '@playwright/test';
import type { QaSession } from './qa-session';
import type { AgencySpec, FallbackExpectation, QaConfig } from './types';

/** 描画完了を示す属性 (モックサイトが設定する)。実サイトでは主要要素の表示待ちに置き換える */
const RENDER_FLAG_TIMEOUT = 10000;

function comparablePath(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

/** 代理店コード付きの流入 URL */
export function buildEntryUrl(config: QaConfig, entryPath: string, code: string | null): string {
  const url = new URL(entryPath, `${config.environment.baseUrl}/`);
  if (code) url.searchParams.set(config.agency.paramName, code);
  return url.toString();
}

/** 最終 LP への遷移と描画完了を待つ */
export async function waitForFinalLanding(
  page: Page,
  expectedFinalPath: string | null,
): Promise<void> {
  if (expectedFinalPath) {
    await page
      .waitForURL((url) => comparablePath(url.pathname) === comparablePath(expectedFinalPath), {
        timeout: RENDER_FLAG_TIMEOUT,
      })
      .catch(() => undefined);
  }
  await page.waitForLoadState('load').catch(() => undefined);
  // 代理店コンテキストの描画完了を待つ
  await page
    .waitForFunction(() => document.documentElement.getAttribute('data-agency-rendered') === '1', null, {
      timeout: RENDER_FLAG_TIMEOUT,
    })
    .catch(() => undefined);
}

/**
 * 代理店コードで流入し、その代理店の最終 LP が描画されるまで待つ。
 * 戻り値が false の場合、ページを開けなかった (検知結果は記録済み)。
 */
export async function enterAsAgency(qa: QaSession, spec: AgencySpec): Promise<boolean> {
  const target = buildEntryUrl(qa.config, spec.entryPath, spec.code);
  const opened = await qa.goto({ url: target, agencyCode: spec.code });
  if (!opened) return false;

  await waitForFinalLanding(qa.page, spec.redirected ? spec.expectedFinalPath : null);
  qa.findings.setContext({ url: qa.page.url() });
  return true;
}

/** 無効コード / コードなしで流入する */
export async function enterWithFallback(
  qa: QaSession,
  expectation: FallbackExpectation,
  code: string | null,
): Promise<boolean> {
  const target = buildEntryUrl(qa.config, expectation.entryPath, code);
  const opened = await qa.goto({ url: target, agencyCode: code });
  if (!opened) return false;

  await waitForFinalLanding(qa.page, null);
  qa.findings.setContext({ url: qa.page.url() });
  return true;
}

/** 任意のパスへ流入する (専用 LP への直接アクセスなど) */
export async function enterPath(
  qa: QaSession,
  path: string,
  code: string | null = null,
): Promise<boolean> {
  const opened = await qa.goto({ url: buildEntryUrl(qa.config, path, code), agencyCode: code });
  if (!opened) return false;
  await waitForFinalLanding(qa.page, null);
  qa.findings.setContext({ url: qa.page.url() });
  return true;
}
