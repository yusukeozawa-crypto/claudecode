/**
 * sitemap.xml からページを自動取得して巡回する。
 * config/pages.yml の source を sitemap に切り替えたときのみ実行される
 * (source: config の場合はスキップされる)。
 */
import { test } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';

const config = loadConfig();

test.describe('sitemap 巡回 @crawl @sitemap', () => {
  test.skip(
    config.pages.source !== 'sitemap',
    'config/pages.yml の source が sitemap ではないためスキップします',
  );

  test('sitemap.xml から取得した全ページの表示・エラー検査', async ({ qa, qaPages }) => {
    test.slow();
    for (const pageConfig of qaPages) {
      const opened = await qa.goto({ page: pageConfig });
      if (!opened) continue;

      if (pageConfig.checks.includes('layout')) await qa.checkLayout(pageConfig);
      await qa.captureScreenshot(pageConfig.id);
      if (pageConfig.checks.includes('errors')) qa.collectMonitorFindings();
    }
  });
});
