/**
 * 代理店コードのシナリオテスト。
 *
 * シナリオ:
 *   1. 代理店コードなし
 *   2. 有効な代理店コードあり
 *   3. 無効な代理店コードあり
 *   4. 有効コードで流入後、別ページへ遷移
 *   5. 有効コードで流入後、申込画面へ遷移
 *   6. 別の代理店コードで再流入
 *   7. Cookie または localStorage を削除して再訪問
 *
 * 各シナリオで確認する内容:
 *   - Cookie / localStorage の値
 *   - 指定セクションの表示・非表示
 *   - 代理店名・電話番号などの表示内容
 *   - ページ遷移後のコード保持
 *   - 申込 URL / hidden 項目 / API への引き継ぎ
 *   - 無効コード時のフォールバック表示
 */
import { test } from '../qa-fixtures';
import { loadConfig, resolveAgencySelector } from '../../utils/config';
import { agencyAwarePages, pageById, pagesFromConfig } from '../../utils/page-source';
import {
  agencyState, clearStoredCode, findCode, invalidCodes, readStoredCode,
  storageLabel, urlWithCode, validCodes, verifyDisplay, verifyStoredCode,
} from '../../utils/agency';

const config = loadConfig();
const allPages = pagesFromConfig(config);
const targetPages = agencyAwarePages(allPages);
const validAgencyCodes = validCodes(config);
const invalidAgencyCodes = invalidCodes(config);
const primaryValidCode = validAgencyCodes[0];
const secondaryValidCode = validAgencyCodes[1];
const applicationPage = pageById(allPages, config.agency.application.targetPageId);

test.describe('代理店コード @agency', () => {
  // ------------------------------------------------------------------
  // シナリオ 1: 代理店コードなし
  // ------------------------------------------------------------------
  test.describe('シナリオ1: 代理店コードなし', () => {
    for (const pageConfig of targetPages) {
      test(`${pageConfig.name}: 既定表示になり代理店コードが保存されない`, async ({ qa, page }) => {
        const opened = await qa.goto({ page: pageConfig, agencyCode: null });
        if (!opened) return;

        qa.addAll(await verifyDisplay(page, config, 'none', undefined));
        const stored = await readStoredCode(page, config);
        qa.addAll(
          verifyStoredCode(stored, config, null, {
            url: page.url(),
            label: 'コードなしで流入',
          }),
        );
        qa.collectMonitorFindings();
      });
    }
  });

  // ------------------------------------------------------------------
  // シナリオ 2: 有効な代理店コードあり
  // ------------------------------------------------------------------
  test.describe('シナリオ2: 有効な代理店コードあり', () => {
    for (const pageConfig of targetPages) {
      for (const codeSpec of validAgencyCodes) {
        test(`${pageConfig.name}: ${codeSpec.code} で代理店表示に切り替わる`, async ({ qa, page }) => {
          const opened = await qa.goto({ page: pageConfig, agencyCode: codeSpec.code });
          if (!opened) return;

          qa.addAll(await verifyDisplay(page, config, 'valid', codeSpec));
          const stored = await readStoredCode(page, config);
          qa.addAll(
            verifyStoredCode(stored, config, codeSpec.code, {
              url: page.url(),
              label: `${codeSpec.code} で流入`,
            }),
          );
          await qa.captureScreenshot(pageConfig.id, `agency-${codeSpec.code}`);
          qa.collectMonitorFindings();
        });
      }
    }
  });

  // ------------------------------------------------------------------
  // シナリオ 3: 無効な代理店コードあり (フォールバック表示)
  // ------------------------------------------------------------------
  test.describe('シナリオ3: 無効な代理店コードあり', () => {
    for (const pageConfig of targetPages) {
      for (const codeSpec of invalidAgencyCodes) {
        test(`${pageConfig.name}: ${codeSpec.code} でフォールバック表示になる`, async ({ qa, page }) => {
          const opened = await qa.goto({ page: pageConfig, agencyCode: codeSpec.code });
          if (!opened) return;

          qa.addAll(await verifyDisplay(page, config, 'invalid', codeSpec));
          // 無効コードは保存されないこと
          const stored = await readStoredCode(page, config);
          qa.addAll(
            verifyStoredCode(stored, config, null, {
              url: page.url(),
              label: `無効コード ${codeSpec.code} で流入`,
            }),
          );
          await qa.captureScreenshot(pageConfig.id, `agency-${codeSpec.code}`);
          qa.collectMonitorFindings();
        });
      }
    }
  });

  // ------------------------------------------------------------------
  // シナリオ 4: 有効コードで流入後、別ページへ遷移してもコードを保持する
  // ------------------------------------------------------------------
  test.describe('シナリオ4: 流入後のページ遷移', () => {
    test(`${primaryValidCode.code} で流入後、遷移してもコードと表示を保持する`, async ({ qa, page }) => {
      const flowPages = config.agency.persistenceFlow.map((id) => pageById(allPages, id));
      const entryPage = flowPages[0];

      const opened = await qa.goto({ page: entryPage, agencyCode: primaryValidCode.code });
      if (!opened) return;
      qa.addAll(await verifyDisplay(page, config, 'valid', primaryValidCode));

      for (const nextPage of flowPages.slice(1)) {
        // (a) サイト内リンクをクリックして遷移した場合
        const navLink = page.locator(`a[href*="${nextPage.path.replace(/^\//, '')}"]`).first();
        if ((await navLink.count()) > 0) {
          await navLink.click();
          await page.waitForLoadState('load');
          qa.findings.setContext({ pageId: nextPage.id, pageName: nextPage.name, url: page.url() });

          const storedAfterClick = await readStoredCode(page, config);
          qa.addAll(
            verifyStoredCode(storedAfterClick, config, primaryValidCode.code, {
              url: page.url(),
              label: `${entryPage.name} から ${nextPage.name} へリンク遷移`,
            }),
          );
          qa.addAll(await verifyDisplay(page, config, 'valid', primaryValidCode));
        }

        // (b) URL パラメータなしで直接遷移した場合 (保存値からの復元)
        const openedDirect = await qa.goto({ page: nextPage, agencyCode: null });
        if (!openedDirect) continue;

        const storedDirect = await readStoredCode(page, config);
        qa.addAll(
          verifyStoredCode(storedDirect, config, primaryValidCode.code, {
            url: page.url(),
            label: `${nextPage.name} へパラメータなしで直接遷移`,
          }),
        );
        qa.addAll(await verifyDisplay(page, config, 'valid', primaryValidCode));
      }

      qa.collectMonitorFindings();
    });
  });

  // ------------------------------------------------------------------
  // シナリオ 5: 有効コードで流入後、申込画面へ遷移して引き継がれる
  // ------------------------------------------------------------------
  test.describe('シナリオ5: 申込画面への引き継ぎ', () => {
    test(`${primaryValidCode.code} が申込画面へ引き継がれる`, async ({ qa, page }) => {
      const entryPage = targetPages.find((candidate) => candidate.id !== applicationPage.id) ?? applicationPage;
      const application = config.agency.application;

      const opened = await qa.goto({ page: entryPage, agencyCode: primaryValidCode.code });
      if (!opened) return;

      // 申込ボタンから遷移する (申込完了はしない)
      const applicationButton = page.locator(resolveAgencySelector(config, 'applicationButton')).first();
      if ((await applicationButton.count()) === 0) {
        qa.add({
          category: 'agency-handoff',
          severity: 'high',
          title: '申込導線のボタンが見つかりません',
          expected: `${resolveAgencySelector(config, 'applicationButton')} が存在すること`,
          actual: '要素が存在しません',
          url: page.url(),
        });
        return;
      }

      await applicationButton.click();
      await page.waitForLoadState('load');
      qa.findings.setContext({
        pageId: applicationPage.id,
        pageName: applicationPage.name,
        url: page.url(),
      });

      // (1) 申込 URL への引き継ぎ
      const currentUrl = new URL(page.url());
      const codeInUrl = currentUrl.searchParams.get(config.agency.paramName);
      if (application.expectParamInUrl && codeInUrl !== primaryValidCode.code) {
        qa.add({
          category: 'agency-handoff',
          title: '申込 URL に代理店コードが引き継がれていません',
          expected: `${config.agency.paramName}=${primaryValidCode.code} が申込 URL に含まれること`,
          actual: codeInUrl === null ? 'URL パラメータなし' : `${config.agency.paramName}=${codeInUrl}`,
          url: page.url(),
        });
      }

      // (2) hidden 項目への引き継ぎ
      if (application.hiddenField) {
        const hidden = page.locator(resolveAgencySelector(config, application.hiddenField.testId)).first();
        if ((await hidden.count()) === 0) {
          qa.add({
            category: 'agency-handoff',
            title: '申込フォームの hidden 項目が見つかりません',
            expected: `${resolveAgencySelector(config, application.hiddenField.testId)} が存在すること`,
            actual: '要素が存在しません',
            url: page.url(),
          });
        } else {
          const value = await hidden.inputValue();
          if (value !== primaryValidCode.code) {
            qa.add({
              category: 'agency-handoff',
              title: 'hidden 項目の代理店コードが誤っています',
              expected: primaryValidCode.code,
              actual: value === '' ? '(空)' : value,
              url: page.url(),
            });
          }
          if (application.hiddenField.name) {
            const nameAttribute = await hidden.getAttribute('name');
            if (nameAttribute !== application.hiddenField.name) {
              qa.add({
                category: 'agency-handoff',
                severity: 'high',
                title: 'hidden 項目の name 属性が期待と異なります',
                expected: `name="${application.hiddenField.name}"`,
                actual: nameAttribute === null ? 'name 属性なし' : `name="${nameAttribute}"`,
                url: page.url(),
              });
            }
          }
        }
      }

      // (3) 保存値の保持
      const stored = await readStoredCode(page, config);
      qa.addAll(
        verifyStoredCode(stored, config, primaryValidCode.code, {
          url: page.url(),
          label: '申込画面',
        }),
      );

      // (4) 申込 API への引き継ぎ
      //     本番環境ではデータ送信を行わないためスキップする。
      //     それ以外の環境でもリクエストは実際には送信せず、内容を検査して打ち返す。
      for (const requestSpec of application.requests) {
        if (requestSpec.skipWhenReadOnly && qa.isReadOnly) {
          qa.add({
            category: 'agency-handoff',
            severity: 'low',
            title: '申込 API への引き継ぎ検査をスキップしました',
            expected: '読み取り専用環境では送信を伴う検査を行わない',
            actual: `スキップ (${requestSpec.urlPattern})`,
            url: page.url(),
          });
          continue;
        }

        let capturedValue: string | null = null;
        let captured = false;

        await page.route(requestSpec.urlPattern, async (route) => {
          captured = true;
          const request = route.request();
          const postData = request.postData() ?? '';
          const requestUrl = new URL(request.url());
          capturedValue =
            requestUrl.searchParams.get(requestSpec.field) ??
            extractField(postData, requestSpec.field);
          // 実際には送信せずモックレスポンスを返す (申込完了させない)
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, intercepted: true }),
          });
        });

        const submit = page.locator('[data-testid="application-submit"]').first();
        if ((await submit.count()) > 0) {
          await submit.click();
          await page.waitForTimeout(500);
        }
        await page.unroute(requestSpec.urlPattern);

        if (!captured) {
          qa.add({
            category: 'agency-handoff',
            severity: 'low',
            title: '申込 API へのリクエストを検出できませんでした',
            expected: `${requestSpec.urlPattern} へのリクエストが発生すること`,
            actual: 'リクエストなし (画面遷移方式の可能性があります)',
            url: page.url(),
          });
        } else if (capturedValue !== primaryValidCode.code) {
          qa.add({
            category: 'agency-handoff',
            title: '申込 API に引き継がれた代理店コードが誤っています',
            expected: `${requestSpec.field}=${primaryValidCode.code}`,
            actual: capturedValue === null ? `${requestSpec.field} が含まれていません` : `${requestSpec.field}=${capturedValue}`,
            url: page.url(),
          });
        }
      }

      await qa.captureScreenshot(applicationPage.id, `handoff-${primaryValidCode.code}`);
      qa.collectMonitorFindings();
    });
  });

  // ------------------------------------------------------------------
  // シナリオ 6: 別の代理店コードで再流入
  // ------------------------------------------------------------------
  test.describe('シナリオ6: 別コードで再流入', () => {
    test('後から流入した代理店コードで上書きされる', async ({ qa, page }) => {
      test.skip(
        !secondaryValidCode,
        'config/agency.yml に有効な代理店コードが 1 件しかないため実行しません',
      );

      const entryPage = targetPages[0];

      const first = await qa.goto({ page: entryPage, agencyCode: primaryValidCode.code });
      if (!first) return;
      qa.addAll(await verifyDisplay(page, config, 'valid', primaryValidCode));

      const second = await qa.goto({ page: entryPage, agencyCode: secondaryValidCode.code });
      if (!second) return;

      qa.addAll(await verifyDisplay(page, config, 'valid', secondaryValidCode));
      const stored = await readStoredCode(page, config);
      qa.addAll(
        verifyStoredCode(stored, config, secondaryValidCode.code, {
          url: page.url(),
          label: `${primaryValidCode.code} の後に ${secondaryValidCode.code} で再流入`,
        }),
      );

      // 前の代理店の情報が残っていないこと
      const nameLocator = page.locator(resolveAgencySelector(config, 'agencyName')).first();
      if ((await nameLocator.count()) > 0 && primaryValidCode.expectedName) {
        const text = ((await nameLocator.textContent()) ?? '').trim();
        if (text.includes(primaryValidCode.expectedName)) {
          qa.add({
            category: 'agency-display',
            title: '再流入後も前の代理店名が表示されています (代理店の誤表示)',
            expected: secondaryValidCode.expectedName ?? secondaryValidCode.code,
            actual: text,
            url: page.url(),
          });
        }
      }

      await qa.captureScreenshot(entryPage.id, `reentry-${secondaryValidCode.code}`);
      qa.collectMonitorFindings();
    });
  });

  // ------------------------------------------------------------------
  // シナリオ 7: Cookie / localStorage を削除して再訪問
  // ------------------------------------------------------------------
  test.describe('シナリオ7: 保存値を削除して再訪問', () => {
    test(`${storageLabel(config)} を削除すると既定表示に戻る`, async ({ qa, page, context }) => {
      const entryPage = targetPages[0];

      const opened = await qa.goto({ page: entryPage, agencyCode: primaryValidCode.code });
      if (!opened) return;
      qa.addAll(await verifyDisplay(page, config, 'valid', primaryValidCode));

      // 保存値を削除する
      await clearStoredCode(context, page, config);

      const reopened = await qa.goto({ page: entryPage, agencyCode: null });
      if (!reopened) return;

      const stored = await readStoredCode(page, config);
      qa.addAll(
        verifyStoredCode(stored, config, null, {
          url: page.url(),
          label: '保存値の削除後に再訪問',
        }),
      );
      qa.addAll(await verifyDisplay(page, config, 'none', undefined));
      qa.collectMonitorFindings();
    });
  });

  // ------------------------------------------------------------------
  // 設定の妥当性 (代理店コードの状態判定が設定と整合しているか)
  // ------------------------------------------------------------------
  test('設定された代理店コードの有効・無効判定が一貫している @config', async ({ qa }) => {
    for (const codeSpec of config.agency.codes) {
      const state = agencyState(config, codeSpec.code);
      const expectedState = codeSpec.valid ? 'valid' : 'invalid';
      if (state !== expectedState) {
        qa.add({
          category: 'config',
          title: `代理店コードの状態判定が設定と一致しません: ${codeSpec.code}`,
          expected: expectedState,
          actual: state,
          url: urlWithCode(config, targetPages[0], codeSpec.code),
        });
      }
      if (codeSpec.valid && !findCode(config, codeSpec.code)?.expectedName) {
        qa.add({
          category: 'config',
          severity: 'medium',
          title: `有効コードに expectedName が設定されていません: ${codeSpec.code}`,
          expected: 'config/agency.yml の codes[].expectedName を設定する',
          actual: '未設定 (代理店名の表示内容を検証できません)',
          url: config.environment.baseUrl,
        });
      }
    }
  });
});

/** POST ボディ (JSON / form-urlencoded) から指定フィールドを取り出す */
function extractField(postData: string, field: string): string | null {
  if (!postData) return null;
  try {
    const parsed = JSON.parse(postData) as Record<string, unknown>;
    const value = parsed[field];
    return value === undefined ? null : String(value);
  } catch {
    return new URLSearchParams(postData).get(field);
  }
}
