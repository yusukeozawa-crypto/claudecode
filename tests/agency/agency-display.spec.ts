/**
 * 代理店ごとの表示検査 (config/agencies.yml から自動生成)。
 *
 * 代理店コードの「有無」では判定せず、代理店ごとに異なる期待結果を検証する。
 *   - 最初に表示する LP / 最終 URL
 *   - 表示するセクション / 非表示にするセクション
 *   - 代理店名・電話番号
 *   - バナー・ロゴ
 *   - CTA の文言
 *   - Cookie / localStorage の保存値
 *   - 他の代理店の情報が表示されていないこと
 *
 * config/agencies.yml に 1 件追加すれば、その代理店のテストが自動的に追加される。
 * PC / SP は project (chromium-pc / chromium-sp) により自動的に両方実行される。
 */
import { test } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { pageById, pagesFromConfig } from '../../utils/page-source';
import {
  agencyPairs, agencySpecs, clearStoredCode, invalidCodes, readStoredCode, storageLabel,
  verifyAssets, verifyCtaText, verifyFallback, verifyNoOtherAgencyInfo,
  verifySections, verifyStoredCode, verifyTexts, verifyDisplayRules, storageChecksEnabled, expectedStoredCode,
  observeStorageLocation,
} from '../../utils/agency';
import { enterAsAgency, enterPath, enterWithFallback } from '../../utils/agency-entry';
import { observeCodeInApplication, verifyCodeApplied } from '../../utils/handoff';
import { describeRuntime, observeRuntime } from '../../utils/runtime-observation';

const config = loadConfig();
const specs = agencySpecs(config);
const allPages = pagesFromConfig(config);

test.describe('代理店ごとの表示 @agency', () => {
  // ------------------------------------------------------------------
  // 代理店ごとの期待結果 (自動生成)
  // ------------------------------------------------------------------
  for (const spec of specs) {
    test(`${spec.code} (${spec.label}): 表示内容が代理店仕様どおり`, async ({ qa, page }) => {
      // 流入 → (リダイレクト) → 最終 LP の描画完了まで待つ
      if (!(await enterAsAgency(qa, spec))) return;

      const label = `${spec.code}`;

      qa.addAll(await verifySections(page, spec, label));
      qa.addAll(await verifyTexts(page, spec.expectedTexts, label));
      // このサイトの中心的な仕様 (代理店名の表示 / あんしんパックの有無)
      qa.addAll(await verifyDisplayRules(page, config, spec, label, qa.deviceId));
      qa.addAll(await verifyAssets(page, spec.expectedAssets, label));
      qa.addAll(await verifyCtaText(page, spec, label));
      qa.addAll(await verifyNoOtherAgencyInfo(page, config, spec.code, label));

      // 検査したときサイトで何が動いていたか (計測タグ・A/B テスト) を記録する。
      //   A/B テストはバリアントごとに表示が変わるため、
      //   どちらを見たのか分からないままでは「異常なし」を信用できない。
      qa.addAll(
        describeRuntime(
          await observeRuntime(page, config, qa.monitor.requestHosts),
          label,
          page.url(),
        ),
      );

      // 代理店コードの付与。
      //   専用 LP へのリダイレクト後はコードが URL から消えるため、
      //   代理店名の表示では判断できない代理店 (カカクコム) で必要になる。
      if (spec.codeApplied) {
        const applied = await observeCodeInApplication(page, config, spec.code);
        qa.addAll(verifyCodeApplied(applied, spec.code, label));
      }

      // 代理店コードの保存先 (Cookie / localStorage) を記録する。
      // 設定に頼らず値で探すため、キー名が未確認でも分かる。
      if (spec.recognized !== false) {
        qa.addAll(await observeStorageLocation(page, spec.code, label, config));
      }

      const stored = await readStoredCode(page, config);
      qa.addAll(
        verifyStoredCode(stored, config, expectedStoredCode(spec), {
          url: page.url(),
          label: `${spec.code} で流入`,
        }),
      );

      await qa.captureScreenshot(`agency-${spec.code}`);
      qa.collectMonitorFindings();
    });
  }

  // ------------------------------------------------------------------
  // 無効な代理店コード (自動生成)
  // ------------------------------------------------------------------
  for (const invalid of invalidCodes(config)) {
    test(`無効コード ${invalid.code} (${invalid.label}): 通常表示にフォールバックする`, async ({ qa, page }) => {
      const expectation = config.agencies.invalidExpectation;
      if (!(await enterWithFallback(qa, expectation, invalid.code))) return;

      const label = `無効コード ${invalid.code}`;
      qa.addAll(await verifyFallback(page, config, expectation, label));

      // 無効コードは保存されないこと (有効な代理店として処理されない)
      const stored = await readStoredCode(page, config);
      qa.addAll(
        verifyStoredCode(stored, config, expectation.expectStored ? invalid.code : null, {
          url: page.url(),
          label,
        }),
      );

      await qa.captureScreenshot(`invalid-${invalid.code.replace(/[^\w-]/g, '_')}`);
      qa.collectMonitorFindings();
    });
  }

  // ------------------------------------------------------------------
  // 代理店コードなし
  // ------------------------------------------------------------------
  test('代理店コードなし: 通常表示になり代理店情報が表示されない', async ({ qa, page }) => {
    const expectation = config.agencies.noCodeExpectation;
    if (!(await enterWithFallback(qa, expectation, null))) return;

    qa.addAll(await verifyFallback(page, config, expectation, 'コードなし'));

    const stored = await readStoredCode(page, config);
    qa.addAll(
      verifyStoredCode(stored, config, null, { url: page.url(), label: 'コードなしで流入' }),
    );

    await qa.captureScreenshot('no-agency-code');
    qa.collectMonitorFindings();
  });

  // ------------------------------------------------------------------
  // ページ遷移後のコード保持 (代理店ごとに自動生成)
  // ------------------------------------------------------------------
  for (const spec of specs) {
    test(`${spec.code}: ページ遷移後も代理店コードと表示を保持する`, async ({ qa, page }) => {
      const flowPages = config.agency.persistenceFlow
        .map((id) => allPages.find((candidate) => candidate.id === id))
        .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

      if (!(await enterAsAgency(qa, spec))) return;

      for (const nextPage of flowPages) {
        // URL パラメータなしで遷移し、保存値からの復元を確認する
        const opened = await qa.goto({ page: nextPage, agencyCode: null });
        if (!opened) continue;

        const stored = await readStoredCode(page, config);
        qa.addAll(
          verifyStoredCode(stored, config, expectedStoredCode(spec), {
            url: page.url(),
            label: `${spec.code}: ${nextPage.name} へパラメータなしで遷移`,
          }),
        );
        // 遷移後も他の代理店の情報が出ていないこと
        qa.addAll(
          await verifyNoOtherAgencyInfo(page, config, spec.code, `${spec.code}: ${nextPage.name}`),
        );
      }

      qa.collectMonitorFindings();
    });
  }

  // ------------------------------------------------------------------
  // 別の代理店コードで再流入 (組み合わせを自動生成)
  // ------------------------------------------------------------------
  // 全組み合わせは代理店数の二乗になるため、
  // config/runtime.yml の maxAgencyPairs で上限を設ける
  for (const { first, second } of agencyPairs(specs, config)) {
    test(`${first.code} の後に ${second.code} で再流入すると ${second.code} に切り替わる`, async ({ qa, page }) => {
      if (!(await enterAsAgency(qa, first))) return;
      if (!(await enterAsAgency(qa, second))) return;

      const label = `${first.code} -> ${second.code} で再流入`;
      qa.addAll(await verifySections(page, second, label));
      qa.addAll(await verifyTexts(page, second.expectedTexts, label));
      qa.addAll(await verifyAssets(page, second.expectedAssets, label));
      // 前の代理店の情報が残っていないこと
      qa.addAll(await verifyNoOtherAgencyInfo(page, config, second.code, label));

      const stored = await readStoredCode(page, config);
      // 後から入ったコードがサイト側で扱われない場合 (支店コードなど)、
      // 保存値は前のコードのまま残るのが正しい挙動。
      // 「保存されていないこと」を期待すると、正常なサイトを不具合として報告してしまう。
      const expectedAfterSecond =
        second.recognized === false ? expectedStoredCode(first) : expectedStoredCode(second);
      qa.addAll(verifyStoredCode(stored, config, expectedAfterSecond, { url: page.url(), label }));
      qa.collectMonitorFindings();
    });
  }

  // ------------------------------------------------------------------
  // 保存値を削除して再訪問
  // ------------------------------------------------------------------
  for (const spec of specs) {
    test(`${spec.code}: ${storageLabel(config)} を削除すると通常表示に戻る`, async ({ qa, page, context }) => {
      // 保存先なし (URL のみで引き回す) の設定では検証対象がない
      test.skip(
        !storageChecksEnabled(config),
        'config/agency.yml の storage.type が none のため保存値の検査は行いません',
      );
      if (!(await enterAsAgency(qa, spec))) return;

      // 遷移が完了した状態で保存値を削除する
      await clearStoredCode(context, page, config);

      const expectation = config.agencies.noCodeExpectation;
      if (!(await enterWithFallback(qa, expectation, null))) return;

      const label = `${spec.code}: 保存値の削除後に再訪問`;
      qa.addAll(await verifyFallback(page, config, expectation, label));

      const stored = await readStoredCode(page, config);
      qa.addAll(verifyStoredCode(stored, config, null, { url: page.url(), label }));
      qa.collectMonitorFindings();
    });
  }

  // ------------------------------------------------------------------
  // 代理店専用 LP に直接アクセスした場合 (コードなし)
  // ------------------------------------------------------------------
  for (const spec of specs.filter((entry) => entry.redirected)) {
    test(`${spec.code}: 専用LP (${spec.expectedFinalPath}) へコードなしで直接アクセスしても代理店情報を表示しない`, async ({ qa, page }) => {
      if (!(await enterPath(qa, spec.expectedFinalPath, null))) return;

      const label = `${spec.code}: 専用LPへコードなしで直接アクセス`;
      // 代理店情報 (名称・電話番号) が表示されていないこと
      qa.addAll(await verifyNoOtherAgencyInfo(page, config, null, label));

      const stored = await readStoredCode(page, config);
      qa.addAll(verifyStoredCode(stored, config, null, { url: page.url(), label }));
      qa.collectMonitorFindings();
    });
  }
});

// 設定の妥当性: pages.yml と agencies.yml の整合
test.describe('設定の整合性 @agency @config', () => {
  test('代理店の最終 LP が pages.yml に登録されている', async ({ qa }) => {
    for (const spec of specs) {
      const registered = allPages.some(
        (candidate) => candidate.path.replace(/\/$/, '') === spec.expectedFinalPath.replace(/\/$/, ''),
      );
      if (!registered) {
        qa.add({
          category: 'config',
          severity: 'medium',
          title: `${spec.code} の最終 LP が pages.yml に未登録です: ${spec.expectedFinalPath}`,
          expected: 'リダイレクト先の LP も巡回・視覚差分の対象にする',
          actual: '未登録 (表示崩れ・リンク切れが検査されません)',
          url: `${config.environment.baseUrl}${spec.expectedFinalPath}`,
        });
      }
    }
    // 参照が壊れていないことの確認 (pageById は未知の id で例外を投げる)
    for (const id of config.agency.persistenceFlow) pageById(allPages, id);
  });
});
