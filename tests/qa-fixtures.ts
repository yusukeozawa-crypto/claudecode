/**
 * 共通フィクスチャ。
 * すべてのテストはこのファイルの test / expect を使用する。
 *
 * 提供する内容:
 *   - qaConfig : config/*.yml を読み込んだ設定 (worker スコープ)
 *   - qa       : 検査セッション (検知結果の集約・重大度ゲートを自動実行)
 *   - pages    : テスト対象ページ一覧 (config or sitemap)
 *   - 本番環境での書き込み系リクエストの遮断 (安全装置)
 */
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { loadConfig } from '../utils/config';
import { QaSession } from '../utils/qa-session';
import { resolvePages } from '../utils/page-source';
import type { PageConfig, QaConfig } from '../utils/types';

/** 読み取り専用環境で許可する HTTP メソッド */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface QaFixtures {
  qaConfig: QaConfig;
  qaPages: PageConfig[];
  qa: QaSession;
}

export const test = base.extend<QaFixtures>({
  // ---- 設定 (テストごとに同じインスタンスをキャッシュ利用) ----
  qaConfig: async ({}, use) => {
    await use(loadConfig());
  },

  // ---- テスト対象ページ ----
  qaPages: async ({ qaConfig, request }, use) => {
    await use(await resolvePages(qaConfig, request));
  },

  // ---- 本番環境の安全装置: 書き込み系リクエストを遮断する ----
  page: async ({ page, qaConfig }, use) => {
    if (qaConfig.environment.readOnly) {
      await page.route('**/*', async (route) => {
        const method = route.request().method().toUpperCase();
        if (READ_ONLY_METHODS.has(method)) {
          await route.continue();
          return;
        }
        // 本番では申込完了やデータ送信を一切行わない
        console.warn(`[qa] 読み取り専用環境のため ${method} リクエストを遮断しました: ${route.request().url()}`);
        await route.abort('blockedbyclient');
      });
    }
    await use(page);
  },

  // ---- 検査セッション ----
  qa: async ({ page, request, qaConfig }, use, testInfo) => {
    const metadata = testInfo.project.metadata as {
      browserId?: string;
      deviceId?: string;
      deviceLabel?: string;
    };

    const session = new QaSession(qaConfig, page, request, testInfo, {
      environment: qaConfig.environmentName,
      environmentLabel: qaConfig.environment.label,
      baseUrl: qaConfig.environment.baseUrl,
      browserId: metadata.browserId ?? 'unknown',
      deviceId: metadata.deviceId ?? 'unknown',
      deviceLabel: metadata.deviceLabel ?? metadata.deviceId ?? 'unknown',
    });

    await use(session);

    // テスト本体の後に必ず実行される: 結果の添付 + 重大度ゲート
    session.monitor.detach();
    await session.findings.flush(testInfo);
  },
});

export { expect };
export type { APIRequestContext, Page };
