/**
 * タイムアウト検知の自己検査 (@selfcheck)。
 *
 * 要件の「タイムアウト」検知が実際に反応することを確認する。
 * 閾値は設定 (config/runtime.yml / config/errors.yml) から読むため、
 * 検証用に閾値を下げた設定を作って遅延エンドポイントへアクセスする。
 */
import { test, expect } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { QaSession } from '../../utils/qa-session';
import { checkLink } from '../../utils/links';
import type { QaConfig } from '../../utils/types';

const config = loadConfig();

/** 閾値を下げた検証用設定を作る (元の設定は変更しない) */
function withThresholds(overrides: {
  pageLoadWarnMs?: number;
  navigationTimeoutMs?: number;
}): QaConfig {
  return {
    ...config,
    errors: {
      ...config.errors,
      timeout: {
        ...config.errors.timeout,
        pageLoadWarnMs: overrides.pageLoadWarnMs ?? config.errors.timeout.pageLoadWarnMs,
      },
    },
    runtime: {
      ...config.runtime,
      timeouts: {
        ...config.runtime.timeouts,
        navigation: overrides.navigationTimeoutMs ?? config.runtime.timeouts.navigation,
      },
    },
  };
}

test.describe('タイムアウト検知の自己検査 @selfcheck', () => {
  test.skip(
    config.environmentName !== 'local',
    'モックサイトの遅延エンドポイントを使用するため local 環境でのみ実行します',
  );

  test('ページ読み込みが遅い場合に検知する', async ({ page, request }, testInfo) => {
    const slowConfig = withThresholds({ pageLoadWarnMs: 200 });
    const session = new QaSession(slowConfig, page, request, testInfo, {
      environment: slowConfig.environmentName,
      environmentLabel: slowConfig.environment.label,
      baseUrl: slowConfig.environment.baseUrl,
      browserId: 'chromium',
      deviceId: 'pc',
      deviceLabel: 'PC',
    });

    const opened = await session.goto({ url: `${config.environment.baseUrl}/slow?ms=900` });
    session.monitor.detach();

    expect(opened, 'ページ自体は表示できること').toBe(true);
    const timeoutFindings = session.findings.all.filter((finding) => finding.category === 'timeout');
    expect(timeoutFindings.length, '読み込み遅延が検知されること').toBeGreaterThan(0);
    expect(timeoutFindings[0].severity, '遅延は Medium として報告される').toBe('medium');
    expect(timeoutFindings[0].expected, '閾値が期待結果に含まれること').toContain('200ms');
  });

  test('閾値内なら読み込み遅延を検知しない (誤検知の確認)', async ({ page, request }, testInfo) => {
    const session = new QaSession(config, page, request, testInfo, {
      environment: config.environmentName,
      environmentLabel: config.environment.label,
      baseUrl: config.environment.baseUrl,
      browserId: 'chromium',
      deviceId: 'pc',
      deviceLabel: 'PC',
    });

    await session.goto({ url: `${config.environment.baseUrl}/lp/` });
    session.monitor.detach();

    expect(
      session.findings.all.filter((finding) => finding.category === 'timeout'),
      '通常のページでは遅延を検知しないこと',
    ).toEqual([]);
  });

  test('ページ読み込みがタイムアウトした場合に検知する', async ({ page, request }, testInfo) => {
    // ナビゲーションのタイムアウトを応答遅延より短くする
    const strictConfig = withThresholds({ navigationTimeoutMs: 500, pageLoadWarnMs: 100 });
    const session = new QaSession(strictConfig, page, request, testInfo, {
      environment: strictConfig.environmentName,
      environmentLabel: strictConfig.environment.label,
      baseUrl: strictConfig.environment.baseUrl,
      browserId: 'chromium',
      deviceId: 'pc',
      deviceLabel: 'PC',
    });

    const opened = await session.goto({ url: `${config.environment.baseUrl}/slow?ms=3000` });
    session.monitor.detach();

    expect(opened, 'タイムアウトしたページは開けなかったと判定されること').toBe(false);
    const findings = session.findings.all;
    expect(
      findings.map((finding) => finding.category),
      'タイムアウトとして検知されること',
    ).toContain('timeout');
    expect(
      findings.find((finding) => finding.category === 'timeout')?.severity,
      '読み込みタイムアウトは High として報告される',
    ).toBe('high');
  });

  test('リンク先の応答が遅い場合にタイムアウトとして検知する', async ({ request }) => {
    const strictConfig = withThresholds({ navigationTimeoutMs: 400 });
    const result = await checkLink(
      request,
      {
        href: `${config.environment.baseUrl}/slow?ms=2500`,
        text: '遅いリンク',
        testId: 'slow-link',
        isInternal: true,
      },
      strictConfig,
    );

    expect(result.status, 'ステータスを取得できないこと').toBeNull();
    expect(result.error, 'タイムアウトのエラーが記録されること').toBeTruthy();
    expect(
      /timeout|timed out/i.test(result.error ?? ''),
      `タイムアウトと判別できること (実際: ${result.error})`,
    ).toBe(true);
  });
});
