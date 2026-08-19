/**
 * 誤字脱字・表記揺れの候補抽出。
 *   - 表示テキストをページごとに抽出して JSON / CSV に保存する (reports/text)
 *   - config/text-rules.yml のルールで表記揺れ・誤字候補・使用禁止表現を検出する
 *   - AI による文章チェックは utils/ai-text-checker.ts のインターフェース経由で後から追加できる
 */
import { test } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { pagesFromConfig, pagesWithCheck } from '../../utils/page-source';
import { detectCrossPageInconsistency } from '../../utils/text-rules';

const config = loadConfig();
const textPages = pagesWithCheck(pagesFromConfig(config), 'text');

test.describe('文言チェック @text', () => {
  test.skip(!config.text.extract.enabled, 'config/text-rules.yml で抽出が無効化されています');

  for (const pageConfig of textPages) {
    test(`${pageConfig.name} (${pageConfig.id}) の表記チェック`, async ({ qa }) => {
      const opened = await qa.goto({ page: pageConfig });
      if (!opened) return;
      await qa.auditText(pageConfig);
    });
  }

  // ページ間での表記揺れ (同じ意味の語がページごとに異なる表記になっていないか)
  test('ページ間の表記統一', async ({ qa }) => {
    const perPageText: Array<{ pageId: string; text: string }> = [];

    for (const pageConfig of textPages) {
      const opened = await qa.goto({ page: pageConfig });
      if (!opened) continue;
      perPageText.push({ pageId: pageConfig.id, text: await qa.auditText(pageConfig) });
    }

    qa.addAll(detectCrossPageInconsistency(perPageText, config));
  });
});
