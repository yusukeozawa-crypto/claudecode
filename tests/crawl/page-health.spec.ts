/**
 * PC / SP の基本巡回。
 * 各ページで以下を検査する:
 *   - ページが正常に表示されること (HTTP / タイムアウト / リダイレクトループ)
 *   - 必須要素の存在
 *   - 横スクロールの発生
 *   - 画像の読み込みエラー
 *   - 主要要素のはみ出し・重なり
 *   - 空白画面 / 極端に大きな要素
 *   - JavaScript エラー / 4xx・5xx レスポンス
 * さらにフルページスクリーンショットを保存する。
 */
import { test } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { pagesFromConfig } from '../../utils/page-source';

const config = loadConfig();

test.describe('基本巡回 @crawl @health', () => {
  for (const pageConfig of pagesFromConfig(config)) {
    test(`${pageConfig.name} (${pageConfig.id}) の表示・エラー検査`, async ({ qa }) => {
      const opened = await qa.goto({ page: pageConfig });
      // 開けなかった場合は検知結果 (High 以上) が記録済みなので後続の検査は行わない
      if (!opened) return;

      if (pageConfig.checks.includes('layout')) {
        await qa.checkLayout(pageConfig);
      }

      // フルページスクリーンショット (PC / SP それぞれの project で保存される)
      await qa.captureScreenshot(pageConfig.id);

      if (pageConfig.checks.includes('errors')) {
        qa.collectMonitorFindings();
      }
    });
  }
});
