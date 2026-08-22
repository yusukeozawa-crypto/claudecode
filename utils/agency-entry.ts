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
 * 検査を「まっさらな状態」から始める。
 *
 * 代理店コードは Cookie / localStorage に保存され、次に開いたページを
 * その代理店として表示する。前の検査の状態が残っていると、
 *   ・コードが付与されていないのに「付与されている」
 *   ・代理店名が出ないのに「出ている」
 * と判定してしまう。**残留状態は不具合を隠す**ため、
 * 検知が無いことを合格の根拠にしているチェックリストでは特に危険。
 *
 * Playwright はテストごとに新しいコンテキストを作るので、通常は既に空。
 * それでも毎回確認するのは、将来 storageState (認証の使い回しなど) を
 * 入れたときに、黙って汚れた状態で走り始めるのを防ぐため。
 *
 * 見つけたら報告し、そのうえで消す (消すだけでは気づけない)。
 * 同じテストの中の 2 回目以降の流入は「続き」なので何もしない
 * (別コードでの再流入・再訪リダイレクトは前の状態が必要な検査)。
 */
const cleanStarted = new WeakSet<QaSession>();

export async function startClean(qa: QaSession): Promise<FindingInput[]> {
  if (cleanStarted.has(qa)) return [];
  cleanStarted.add(qa);

  const context = qa.page.context();
  const cookies = await context.cookies().catch(() => []);
  const origins = await context
    .storageState()
    .then((state) => state.origins)
    .catch(() => []);

  const leftovers = [
    ...cookies.map((cookie) => `Cookie ${cookie.name}`),
    ...origins.map((origin) => `保存領域 ${origin.origin}`),
  ];

  // 残っていたものを消す。Cookie はコンテキスト単位で消せる。
  // 保存領域はそのオリジンのページを開いていないと触れないため、
  // 開けている場合だけ消す (テスト開始直後は about:blank で対象なし)。
  await context.clearCookies().catch(() => undefined);
  if (leftovers.length > 0) {
    await qa.page
      .evaluate(() => {
        try {
          window.localStorage.clear();
          window.sessionStorage.clear();
        } catch {
          /* storage が使えない場合は何もしない */
        }
      })
      .catch(() => undefined);
  }

  if (leftovers.length === 0) return [];

  return [
    {
      category: 'config',
      severity: 'critical',
      title: '検査を開始する時点で前回の状態が残っていました (検査環境の問題)',
      expected: '代理店コードの Cookie / 保存領域が空の状態で検査を始めること',
      actual: `残っていたもの: ${leftovers.join(', ')}`,
      url: qa.page.url(),
      detail:
        'サイトの不具合ではなく検査の進め方の問題です。' +
        '前回の代理店コードが残っていると、コードが付与されていない場合でも' +
        '「付与されている」と判定してしまい、不具合を見逃します。' +
        'この検査では状態を消して続行しましたが、同じ実行の他の結果は信頼できません。',
    },
  ];
}

/**
 * 代理店コードで流入し、その代理店の最終 LP が描画されるまで待つ。
 * 戻り値が false の場合、ページを開けなかった (検知結果は記録済み)。
 */
export async function enterAsAgency(qa: QaSession, spec: AgencySpec): Promise<boolean> {
  qa.addAll(await startClean(qa));
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
  qa.addAll(await startClean(qa));
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
  qa.addAll(await startClean(qa));
  const opened = await qa.goto({ url: buildEntryUrl(qa.config, path, code), agencyCode: code });
  if (!opened) return false;
  await waitForFinalLanding(qa.page, qa.config, null);
  qa.findings.setContext({ url: qa.page.url() });
  return true;
}
