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
import { resolveSelector } from './config';
import type { AgencySpec, FallbackExpectation, FindingInput, QaConfig } from './types';

function comparablePath(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

/** 代理店コード付きの流入 URL */
export function buildEntryUrl(config: QaConfig, entryPath: string, code: string | null): string {
  const url = new URL(entryPath, `${config.environment.baseUrl}/`);
  if (code) url.searchParams.set(config.agency.paramName, code);
  return url.toString();
}

/**
 * 最終 LP への遷移と描画完了を待つ。
 *
 * 描画完了の判定条件は config/agency.yml の readyIndicator で設定する。
 * 条件が現れなかった場合は false を返す (設定漏れを検知できるようにするため。
 * 実サイトでモック用の条件を待つと、テストごとに待機時間を無駄にする)。
 */
export async function waitForFinalLanding(
  page: Page,
  config: QaConfig,
  expectedFinalPath: string | null,
): Promise<boolean> {
  const indicator = config.agency.readyIndicator;
  const timeout = indicator?.timeoutMs ?? 5000;

  if (expectedFinalPath) {
    await page
      .waitForURL((url) => comparablePath(url.pathname) === comparablePath(expectedFinalPath), { timeout })
      .catch(() => undefined);
  }
  await page.waitForLoadState('load').catch(() => undefined);

  if (!indicator || indicator.type === 'none') return true;

  if (indicator.type === 'selector' && indicator.selector) {
    return page
      .locator(resolveSelector(indicator.selector))
      .first()
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);
  }

  if (indicator.type === 'attribute' && indicator.attribute) {
    return page
      .waitForFunction(
        ({ name, expected }: { name: string; expected: string | null }) =>
          expected === null
            ? document.documentElement.hasAttribute(name)
            : document.documentElement.getAttribute(name) === expected,
        { name: indicator.attribute, expected: indicator.value ?? null },
        { timeout },
      )
      .then(() => true)
      .catch(() => false);
  }

  return true;
}

/** 描画完了を待てなかったことを記録する (設定漏れに気づけるようにする) */
function readyIndicatorFinding(config: QaConfig, url: string): FindingInput {
  const indicator = config.agency.readyIndicator;
  return {
    category: 'config',
    severity: 'low',
    title: '代理店表示の描画完了を確認できませんでした',
    expected:
      indicator.type === 'selector'
        ? `${indicator.selector} が表示されること`
        : `<html> の ${indicator.attribute} が ${indicator.value ?? '(存在)'} になること`,
    actual: `${indicator.timeoutMs}ms 待っても条件が現れませんでした`,
    url,
    detail:
      'config/agency.yml の readyIndicator を実サイトの実装に合わせてください ' +
      '(設定が合っていないとテストごとに待機時間を無駄にします)',
  };
}

/**
 * 代理店コードで流入し、その代理店の最終 LP が描画されるまで待つ。
 * 戻り値が false の場合、ページを開けなかった (検知結果は記録済み)。
 */
export async function enterAsAgency(qa: QaSession, spec: AgencySpec): Promise<boolean> {
  const target = buildEntryUrl(qa.config, spec.entryPath, spec.code);
  const opened = await qa.goto({ url: target, agencyCode: spec.code });
  if (!opened) return false;

  const ready = await waitForFinalLanding(qa.page, qa.config, spec.redirected ? spec.expectedFinalPath : null);
  if (!ready) qa.add(readyIndicatorFinding(qa.config, qa.page.url()));
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

  const ready = await waitForFinalLanding(qa.page, qa.config, null);
  if (!ready) qa.add(readyIndicatorFinding(qa.config, qa.page.url()));
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
  await waitForFinalLanding(qa.page, qa.config, null);
  qa.findings.setContext({ url: qa.page.url() });
  return true;
}
