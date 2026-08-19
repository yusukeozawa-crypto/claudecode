/**
 * 代理店コードを URL で受け取ることに伴うセキュリティ検査。
 *
 *   - open redirect が発生しない
 *   - 任意の外部ドメインへ遷移できない
 *   - 無効なコードで他代理店の情報が表示されない
 *   - URL パラメータを HTML へそのまま出力しない
 *   - JavaScript が実行できる値を受け付けない
 *   - ログ・レポートに秘密のトークンを出さない (マスキング)
 */
import { test, expect } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { agencySpecs } from '../../utils/agency';
import {
  checkExternalNavigationTargets, checkOpenRedirect, checkParamInjection,
} from '../../utils/security';
import { maskText, maskUrl } from '../../utils/secrets';
import { enterAsAgency } from '../../utils/agency-entry';

const config = loadConfig();
const specs = agencySpecs(config);
const entryPaths = Array.from(new Set(specs.map((spec) => spec.entryPath)));

test.describe('代理店コードのセキュリティ @security', () => {
  for (const entryPath of entryPaths) {
    test(`${entryPath}: open redirect が発生しない`, async ({ qa, page }) => {
      qa.addAll(await checkOpenRedirect(page, config, entryPath));
      qa.collectMonitorFindings();
    });

    test(`${entryPath}: URL パラメータから JavaScript が実行されない / HTML へそのまま出力されない`, async ({ qa, page }) => {
      qa.addAll(await checkParamInjection(page, config, entryPath));
      // XSS ペイロードに起因する console 出力は検査対象外 (実行されないことが本質)
      qa.monitor.reset();
    });
  }

  for (const spec of specs) {
    test(`${spec.code}: CTA の遷移先が許可されたオリジンのみ`, async ({ qa, page }) => {
      if (!(await enterAsAgency(qa, spec))) return;

      qa.addAll(await checkExternalNavigationTargets(page, config));
      qa.collectMonitorFindings();
    });
  }

  // ------------------------------------------------------------------
  // 秘密情報のマスキング (レポートにトークンを出力しない)
  // ------------------------------------------------------------------
  test('一時トークンがレポート上でマスキングされる', async () => {
    // 検証に使う値は設定から取得する (サイト固有の値をテストコードに書かない)
    const sampleCode = specs[specs.length - 1].code;
    const token = 'QTAwMi5hYmNkZWYxMjM0NTY3ODkw';
    const url = `${config.environment.applicationBaseUrl}/entry/?handoff_token=${token}&${config.agency.paramName}=${sampleCode}`;

    const maskedUrl = maskUrl(url, config);
    expect(maskedUrl, 'トークンの値が URL に残っていないこと').not.toContain(token);
    expect(maskedUrl, '代理店コードは残ること').toContain(`${config.agency.paramName}=${sampleCode}`);

    const maskedText = maskText(`handoff_token=${token} を送信しました`, config);
    expect(maskedText, 'トークンの値が本文に残っていないこと').not.toContain(token);

    const jwtLike = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef';
    expect(maskText(`token: ${jwtLike}`, config), 'JWT らしい文字列がマスクされること').not.toContain(jwtLike);

    const hexLike = 'a'.repeat(40);
    expect(maskText(`session ${hexLike}`, config), '長い 16 進文字列がマスクされること').not.toContain(hexLike);
  });

  test('検知結果に含まれるトークンがマスキングされる', async ({ qa }) => {
    const token = 'ZmFrZS10b2tlbi0xMjM0NTY3ODkwYWJjZGVm';
    const finding = qa.findings.add({
      category: 'agency-handoff',
      severity: 'low',
      title: 'マスキング確認用',
      expected: '秘密情報を出力しないこと',
      actual: `handoff_token=${token}`,
      url: `${config.environment.applicationBaseUrl}/entry/?handoff_token=${token}`,
    });

    expect(finding.actual, '検知結果の本文がマスクされること').not.toContain(token);
    expect(finding.url, '検知結果の URL がマスクされること').not.toContain(token);
  });
});
