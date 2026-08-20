/**
 * 申込導線の観測 (引き継ぎ方式が未確定でも実行できる検査)。
 *
 * 申込サイトへの引き継ぎ方式 (クエリ / Cookie / サーバーセッション / JavaScript) が
 * 確定していない段階では、方式を推測して合否を出すことはできない。
 * そこで、この検査では DOM から読み取れる事実だけを記録する:
 *   - 申込サイト (applicationBaseUrl) へ向かうリンク / フォームがあるか
 *   - そのボタンの表示文言 (config の selectors.ctaPrimary を実物に合わせるため)
 *   - リンクの URL に代理店コードが乗っているか
 *
 * クリックも送信も行わないため、本番 (読み取り専用) でも安全に実行できる。
 * 方式が確定したら agencies.yml の application を設定し、
 * tests/agency/agency-handoff.spec.ts の検査へ移す。
 */
import { test } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { agencySpecs } from '../../utils/agency';
import { describeApplicationLinks, observeApplicationLinks } from '../../utils/handoff';
import { enterAsAgency } from '../../utils/agency-entry';

const config = loadConfig();
const specs = agencySpecs(config);

/** application が設定済みの代理店は本来の引き継ぎ検査 (handoff) で検証する */
const observeSpecs = specs.filter((spec) => spec.application === null);

test.describe('申込導線の観測 @agency @cta', () => {
  test.skip(
    !config.environment.applicationBaseUrl,
    '申込サイトの URL (applicationBaseUrl) が未設定のため実行しません',
  );

  for (const spec of observeSpecs) {
    test(`${spec.code}: 申込サイトへの導線を記録する`, async ({ qa, page }) => {
      if (!(await enterAsAgency(qa, spec))) return;

      const links = await observeApplicationLinks(page, config, spec.code);
      qa.addAll(describeApplicationLinks(links, config, spec.code, page.url()));
      qa.collectMonitorFindings();
    });
  }
});
