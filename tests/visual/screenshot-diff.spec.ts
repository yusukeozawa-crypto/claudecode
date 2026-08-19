/**
 * スクリーンショット比較。
 *   - 初回実行時は基準画像 (screenshots/baseline) を作成する
 *   - 2 回目以降は基準画像との差分を検査する
 *   - 差分許容値は config/visual.yml で変更できる
 *   - 日時・カルーセル・外部チャットなどの動的要素はマスクする
 *   - 差分は Low として報告する (CI は失敗させない)
 *   - 意図した変更の場合は npm run update:screenshots で基準画像を更新する
 */
import { test } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { pagesFromConfig, pagesWithCheck } from '../../utils/page-source';

const config = loadConfig();

test.describe('視覚差分 @visual', () => {
  test.skip(!config.visual.enabled, 'config/visual.yml で無効化されています');

  for (const pageConfig of pagesWithCheck(pagesFromConfig(config), 'visual')) {
    test(`${pageConfig.name} (${pageConfig.id}) の基準画像比較`, async ({ qa }) => {
      const opened = await qa.goto({ page: pageConfig });
      if (!opened) return;

      // 常に現在のフルページスクリーンショットを保存する
      await qa.captureScreenshot(pageConfig.id);
      // 基準画像との比較
      await qa.compareScreenshot(pageConfig);
      qa.collectMonitorFindings();
    });
  }
});
