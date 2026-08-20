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
import { installContextGuards } from '../utils/handoff';
import type { FindingInput, PageConfig, QaConfig } from '../utils/types';

export interface QaFixtures {
  qaConfig: QaConfig;
  qaPages: PageConfig[];
  qa: QaSession;
}

/** 申込完了リクエストの遮断で記録された違反 (テスト間で共有しない) */
const completionViolations = new WeakMap<Page, FindingInput[]>();

export const test = base.extend<QaFixtures>({
  // ---- 設定 (テストごとに同じインスタンスをキャッシュ利用) ----
  qaConfig: async ({}, use) => {
    await use(loadConfig());
  },

  // ---- テスト対象ページ ----
  qaPages: async ({ qaConfig, request }, use) => {
    await use(await resolvePages(qaConfig, request));
  },

  // ---- 安全装置 ----
  //   route は Page 単位でしか効かないため、context 全体 (既存ページ +
  //   今後開かれるタブ) に設置する。CTA が target="_blank" で開く場合も遮断する。
  page: async ({ page, qaConfig }, use) => {
    completionViolations.set(page, []);
    await installContextGuards(page.context(), qaConfig, (finding) => {
      completionViolations.get(page)?.push(finding);
    });
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

    // 申込完了リクエストの遮断が発生していれば Critical として記録する
    for (const violation of completionViolations.get(page) ?? []) {
      session.add(violation);
    }

    // テスト本体の後に必ず実行される: 結果の添付 + 重大度ゲート
    session.monitor.detach();
    await session.findings.flush(testInfo);
  },
});

export { expect };
export type { APIRequestContext, Page };
