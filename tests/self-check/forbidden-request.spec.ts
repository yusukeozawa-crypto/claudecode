/**
 * 禁止リクエスト判定の自己検査 (@selfcheck)。
 *
 * 「本番で申込を完了させない」最後の防衛線であり、
 * URL の形が違うだけで判定が漏れると意味がなくなる。
 */
import { test, expect } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { isForbiddenRequest } from '../../utils/handoff';
import { checkOpenRedirect, checkParamInjection } from '../../utils/security';

const config = loadConfig();
const app = config.environment.applicationBaseUrl;

test.describe('禁止リクエスト判定の自己検査 @selfcheck', () => {
  test('URL の形が違っても申込完了を判定できる', async () => {
    const forbidden = [
      `${app}/entry/complete`,
      `${app}/entry/complete/`,
      `${app}/entry/complete?next=/thanks`,          // クエリ値に "/" が入る
      `${app}/entry/complete?utm_content=a/b&x=1`,
      `${app}/ENTRY/COMPLETE`,                        // 大文字
      `${app}/entry/complete#done`,                   // フラグメント
      `${app}/api/application/submit?redirect=/done&t=1`,
    ];
    for (const url of forbidden) {
      expect(isForbiddenRequest(url, config), `禁止と判定されること: ${url}`).toBe(true);
    }
  });

  test('通常のリクエストは禁止と判定しない (過剰遮断の防止)', async () => {
    const allowed = [
      `${app}/entry/`,
      `${app}/entry/step2/`,
      `${app}/entry/confirm/`,
      `${app}/api/session`,
      `${config.environment.baseUrl}/lp/?${config.agency.paramName}=X001`,
      `${config.environment.baseUrl}/product.html`,
      // 紛らわしいが完了ではない URL
      `${app}/entry/completed-guide.html`,
      `${app}/entry/complete-faq/`,
    ];
    for (const url of allowed) {
      expect(isForbiddenRequest(url, config), `許可されること: ${url}`).toBe(false);
    }
  });
});

test.describe('セキュリティ検査の自己検査 @selfcheck', () => {
  test.skip(config.environmentName !== 'local', 'モックサイトを使用するため local 環境でのみ実行します');

  test('反射型 XSS を検出できる (エスケープせず出力するページ)', async ({ page }) => {
    // 以前は innerHTML とペイロード文字列の一致で判定していたため、
    // ブラウザの再シリアライズにより実際の注入を見逃していた。
    const findings = await checkParamInjection(page, config, '/broken/reflect');

    const reflected = findings.filter((finding) =>
      finding.title.includes('HTML としてそのまま出力'),
    );
    expect(
      reflected.length,
      `反射が検出されること (検知: ${JSON.stringify(findings.map((f) => f.title))})`,
    ).toBeGreaterThan(0);
    expect(reflected[0].severity, 'Critical として報告される').toBe('critical');
  });

  test('正常なページでは反射を検出しない (誤検知の確認)', async ({ page }) => {
    const findings = await checkParamInjection(page, config, '/lp/');
    expect(
      findings.filter((finding) => finding.severity === 'critical'),
      `エスケープしているページでは検知しないこと (検知: ${JSON.stringify(findings)})`,
    ).toEqual([]);
  });

  test('open redirect を検出できる / 正常なページでは検出しない', async ({ page }) => {
    const safe = await checkOpenRedirect(page, config, '/lp/');
    expect(
      safe.filter((finding) => finding.severity === 'critical'),
      `対策済みのページでは検知しないこと (検知: ${JSON.stringify(safe)})`,
    ).toEqual([]);
  });
});
