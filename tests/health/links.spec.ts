/**
 * リンク切れ / リダイレクトループの検査。
 * ページ遷移ではなく APIRequestContext で確認するため、本番環境でも安全に実行できる。
 * 検査件数の上限とリクエスト間隔は config/runtime.yml / config/errors.yml で調整する。
 */
import { test } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { pagesFromConfig, pagesWithCheck } from '../../utils/page-source';

const config = loadConfig();

test.describe('リンク検査 @health @links', () => {
  for (const pageConfig of pagesWithCheck(pagesFromConfig(config), 'links')) {
    test(`${pageConfig.name} (${pageConfig.id}) のリンク切れ検査`, async ({ qa }) => {
      const opened = await qa.goto({ page: pageConfig });
      if (!opened) return;

      const checked = await qa.checkLinks();
      // 検査対象が 0 件の場合は設定ミスの可能性があるため記録する
      if (checked === 0) {
        qa.add({
          category: 'config',
          severity: 'low',
          title: '検査対象のリンクが 0 件でした',
          expected: 'ページ内に検査対象のリンクが存在すること',
          actual: '0 件 (config/errors.yml の links.ignoreUrlPatterns / scope を確認してください)',
        });
      }
      qa.collectMonitorFindings();
    });
  }
});
