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
import { isForbiddenRequest } from '../utils/handoff';
import { maskUrl } from '../utils/secrets';
import type { FindingInput, PageConfig, QaConfig } from '../utils/types';

/** 読み取り専用環境で許可する HTTP メソッド */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
  //   Playwright の route は「後から登録したハンドラが優先」される。
  //   2 つに分けると先に登録した側が呼ばれなくなるため、1 つのハンドラで
  //   両方の判定を行う (分けていたために、本番環境で申込完了の遮断が
  //   機能していなかった)。
  page: async ({ page, qaConfig }, use) => {
    completionViolations.set(page, []);
    const readOnly = qaConfig.environment.readOnly;
    const hasForbiddenPatterns = qaConfig.agency.application.forbiddenRequestPatterns.length > 0;

    if (readOnly || hasForbiddenPatterns) {
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();
        const method = request.method().toUpperCase();

        // (1) 申込完了・データ送信のリクエストは全環境で遮断する
        if (hasForbiddenPatterns && isForbiddenRequest(url, qaConfig)) {
          completionViolations.get(page)?.push({
            category: 'agency-handoff',
            severity: 'critical',
            title: '申込完了・データ送信のリクエストが発生しました',
            expected: '申込完了処理を実行しないこと',
            actual: `${method} ${url} を遮断しました`,
            url: page.url(),
          });
          await route.abort('blockedbyclient');
          return;
        }

        // (2) 読み取り専用環境では書き込み系リクエストを遮断する
        if (readOnly && !READ_ONLY_METHODS.has(method)) {
          // URL に一時トークンや個人情報が含まれ得るためマスクして出力する
          console.warn(
            `[qa] 読み取り専用環境のため ${method} リクエストを遮断しました: ${maskUrl(url, qaConfig)}`,
          );
          await route.abort('blockedbyclient');
          return;
        }

        await route.continue();
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
