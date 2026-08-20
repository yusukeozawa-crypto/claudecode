/**
 * Basic 認証の自己検査 (@selfcheck)。
 *
 * ステージング環境は Basic 認証で保護されていることが多い。
 * .env / GitHub Secrets に認証情報を書けば実際に認証を通過して
 * 検査できることを、モックサイトの /protected/ で確認する。
 *
 * 併せて「認証情報が未設定のときに空の認証情報を送らない」ことも確認する
 * (空文字を渡すと Playwright が空の Authorization を送ってしまい、
 *  認証なしとは異なる挙動になるため)。
 */
import { request as apiRequest } from '@playwright/test';
import { test, expect } from '../qa-fixtures';
import { loadConfig, normalizeHttpCredentials } from '../../utils/config';
import BASIC_AUTH from '../../fixtures/mock-site/basic-auth.json';

const config = loadConfig();

test.describe('Basic 認証の自己検査 @selfcheck', () => {
  test('認証情報の正規化: 未設定・空文字は認証なしとして扱う', async () => {
    expect(normalizeHttpCredentials(null), 'null は認証なし').toBeNull();
    expect(normalizeHttpCredentials(undefined), 'undefined は認証なし').toBeNull();
    // config/environments.yml の ${STAGING_BASIC_USER} は未設定だと空文字に展開される
    expect(
      normalizeHttpCredentials({ username: '', password: '' }),
      '環境変数が未設定 (空文字に展開) の場合は認証なし',
    ).toBeNull();
    expect(
      normalizeHttpCredentials({ username: 'user', password: '' }),
      'パスワードだけ欠けている場合も認証なし',
    ).toBeNull();
    expect(
      normalizeHttpCredentials({ username: '', password: 'pass' }),
      'ユーザー名だけ欠けている場合も認証なし',
    ).toBeNull();
    expect(
      normalizeHttpCredentials({ username: '  user  ', password: '  pass  ' }),
      '前後の空白は取り除いて渡す (.env の書き方でずれないようにする)',
    ).toEqual({ username: 'user', password: 'pass' });
  });

  test('認証情報なしでは保護ページを検査できず、素通りしない', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      let status: number | null = null;
      let message = '';
      try {
        const response = await page.goto(`${config.environment.baseUrl}/protected/`);
        status = response?.status() ?? null;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // ヘッドレスのブラウザは認証ダイアログを表示できないため、
      // Chromium では ERR_INVALID_AUTH_CREDENTIALS で遷移そのものが失敗する。
      // ブラウザによっては 401 が返る。
      // どちらであっても「認証情報の設定漏れに気づかないまま合格する」ことがない、
      // という点が満たされるべき要件。
      expect(
        status === 401 || /ERR_INVALID_AUTH_CREDENTIALS|401/i.test(message),
        `認証情報がなければ検査できないこと (status=${status} message=${message})`,
      ).toBe(true);
      await expect(
        page.getByTestId('protected-page'),
        '保護されたページの内容が見えないこと',
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('認証情報を設定すると保護ページを検査できる (200)', async ({ browser }) => {
    // 実運用では .env / GitHub Secrets の値が config 経由でここに入る
    const context = await browser.newContext({
      httpCredentials: normalizeHttpCredentials(BASIC_AUTH) ?? undefined,
    });
    try {
      const page = await context.newPage();
      const response = await page.goto(`${config.environment.baseUrl}/protected/`);
      expect(response?.status(), '認証情報があれば 200 になること').toBe(200);
      await expect(
        page.getByTestId('protected-page'),
        '保護されたページの内容を検査できること',
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('リンク検査 (APIRequestContext) にも認証情報が適用される', async () => {
    // リンク切れ検査はページ遷移せず APIRequestContext で確認するため、
    // ここに認証情報が渡らないと全リンクが 401 = リンク切れとして大量に報告される。
    const credentials = normalizeHttpCredentials(BASIC_AUTH) ?? undefined;
    const withAuth = await apiRequest.newContext({ httpCredentials: credentials });
    const withoutAuth = await apiRequest.newContext();
    try {
      const ok = await withAuth.fetch(`${config.environment.baseUrl}/protected/`);
      expect(ok.status(), '認証情報があればリンク検査も 200 を得られること').toBe(200);

      const ng = await withoutAuth.fetch(`${config.environment.baseUrl}/protected/`);
      expect(ng.status(), '認証情報がなければ 401 になること').toBe(401);
    } finally {
      await withAuth.dispose();
      await withoutAuth.dispose();
    }
  });

  test('誤った認証情報では通過しない (401)', async ({ browser }) => {
    const context = await browser.newContext({
      httpCredentials: { username: BASIC_AUTH.username, password: 'wrong-password' },
    });
    try {
      const page = await context.newPage();
      const response = await page.goto(`${config.environment.baseUrl}/protected/`);
      expect(response?.status(), '誤った認証情報では 401 のままであること').toBe(401);
    } finally {
      await context.close();
    }
  });
});
