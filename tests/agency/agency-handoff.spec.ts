/**
 * 別ドメインの申込ページへの引き継ぎ検査 (config/agencies.yml から自動生成)。
 *
 * LP ドメインと申込ドメインは別ドメインであり、通常の Cookie は共有されない。
 * 引き継ぎ方法を推測せず、実際のネットワーク通信を記録して検証する。
 *
 * 検査項目:
 *   1. 遷移先ドメインが正しい
 *   2. 遷移先パスが正しい
 *   3. 代理店コードまたは引き継ぎ用トークンが送信されている
 *   4. 申込ページ側で正しい代理店として認識されている (URL だけでは合格にしない)
 *   5. 申込ページを数画面進めても代理店情報が保持される
 *   6. 戻る・再読み込み後も仕様どおり保持される
 *   7. コードが欠落した場合に別代理店へ誤帰属しない
 *   8. 無効コードの場合に通常経路へフォールバックする
 *   9. 別の代理店コードに置き換わっていない
 *  10. 申込完了処理は実行しない (フィクスチャが完了リクエストを遮断する)
 */
import { test } from '../qa-fixtures';
import { loadConfig, expectedApplicationHost } from '../../utils/config';
import { agencySpecs } from '../../utils/agency';
import {
  HandoffRecorder, clickCtaToApplication, requiresWriteRequest, verifyApplicationDestination,
  verifyApplicationPersistence, verifyFallbackHandoff, verifyHandoffStatically,
  verifyHandoffTransport, verifyRecognition,
} from '../../utils/handoff';
import { verifyUrlHygiene } from '../../utils/redirect';
import { buildEntryUrl, enterAsAgency, enterWithFallback } from '../../utils/agency-entry';

const config = loadConfig();
const specs = agencySpecs(config);

function entryUrl(path: string, code: string | null): string {
  const url = new URL(path, `${config.environment.baseUrl}/`);
  if (code) url.searchParams.set(config.agency.paramName, code);
  return url.toString();
}

test.describe('申込ページへの引き継ぎ @agency @handoff', () => {
  for (const spec of specs) {
    test(`${spec.code}: ${spec.application.handoffMethod} 方式で申込ドメインへ引き継がれる`, async ({ qa, page }) => {
      test.slow();
      if (!(await enterAsAgency(qa, spec))) return;

      // 読み取り専用環境 (本番) では、POST 送信を伴う引き継ぎは実行できない。
      // DOM から読み取れる範囲 (遷移先ドメイン・パス・hidden 項目) を検証し、
      // 実際の送信と申込側での認識はスキップした事実を記録する。
      if (qa.isReadOnly && requiresWriteRequest(spec)) {
        qa.addAll(await verifyHandoffStatically(page, config, spec));
        qa.add({
          category: 'agency-handoff',
          severity: 'low',
          title: `${spec.code}: ${spec.application.handoffMethod} 方式の送信検査をスキップしました`,
          expected: '読み取り専用環境ではデータ送信を行わない',
          actual: 'CTA の遷移先と hidden 項目のみ検証しました (申込側での認識は未検証)',
          url: page.url(),
        });
        await qa.captureScreenshot(`handoff-static-${spec.code}`);
        qa.collectMonitorFindings();
        return;
      }

      // --- 申込ドメイン宛の通信を記録する ---
      const recorder = new HandoffRecorder(
        page,
        config,
        spec.application.expectedCode,
        spec.application.handoffParam,
      );

      const clicked = await clickCtaToApplication(page, spec, config);
      if (!clicked.navigated) {
        recorder.detach();
        qa.add({
          category: 'agency-handoff',
          severity: 'critical',
          title: `${spec.code}: CTA から申込ページへ遷移できませんでした`,
          expected: `${expectedApplicationHost(config, spec.application.expectedDomain)}${spec.application.expectedPath} へ遷移すること`,
          actual: clicked.error ?? '遷移しませんでした',
          url: page.url(),
        });
        return;
      }

      qa.findings.setContext({ url: page.url() });

      // --- (1)(2) 遷移先のドメイン・パス ---
      qa.addAll(verifyApplicationDestination(page.url(), spec, config));

      // --- (3) コード / トークンの送信 ---
      qa.addAll(verifyHandoffTransport(recorder.observation, spec, page.url()));

      // --- (4)(9) 申込側で認識された代理店 ---
      qa.addAll(await verifyRecognition(page, config, spec, `${spec.code}: 申込ページ`));

      // --- 申込 URL に個人情報等が付加されていないこと ---
      qa.addAll(verifyUrlHygiene(page.url(), config, `${spec.code}: 申込 URL`));

      await qa.captureScreenshot(`handoff-${spec.code}`);

      // --- (5)(6) 数画面進める / 再読み込み / 戻る ---
      qa.addAll(await verifyApplicationPersistence(page, config, spec));

      // トークン方式では「トークンが存在すること」のみを確認する (値は比較しない)
      if (spec.application.handoffMethod === 'token' || spec.application.handoffMethod === 'server-session') {
        const tokenCount = recorder.observation.tokenValues.length;
        qa.add({
          category: 'agency-handoff',
          severity: tokenCount > 0 ? 'low' : 'critical',
          title:
            tokenCount > 0
              ? `${spec.code}: 一時トークンによる引き継ぎを確認しました`
              : `${spec.code}: 一時トークンが観測されませんでした`,
          expected: `${spec.application.handoffParam} が送信され、申込側で ${spec.application.expectedCode} に復元されること`,
          actual:
            tokenCount > 0
              ? `トークンを ${tokenCount} 件観測 (値はレポートに出力しません)`
              : 'トークンなし',
          url: page.url(),
        });
      }

      recorder.detach();
      qa.collectMonitorFindings();
    });
  }

  // ------------------------------------------------------------------
  // (7) 代理店コードなしで申込ページへ入った場合、誤帰属しないこと
  // ------------------------------------------------------------------
  test('代理店コードなしで申込ページへ入ると通常経路になり誤帰属しない', async ({ qa, page }) => {
    const expectation = config.agencies.noCodeExpectation;
    if (!(await enterWithFallback(qa, expectation, null))) return;

    const applicationEntry = new URL(
      expectation.application.expectedPath,
      `${config.environment.applicationBaseUrl}/`,
    ).toString();
    const reached = await qa.goto({ url: applicationEntry });
    if (!reached) return;

    qa.addAll(await verifyFallbackHandoff(page, config, expectation, 'コードなし: 申込ページ'));
    qa.collectMonitorFindings();
  });

  // ------------------------------------------------------------------
  // (8) 無効コードでは通常経路へフォールバックすること
  // ------------------------------------------------------------------
  for (const invalid of config.agencies.invalidCodes) {
    test(`無効コード ${invalid.code}: 申込ページで通常経路へフォールバックする`, async ({ qa, page }) => {
      const expectation = config.agencies.invalidExpectation;
      if (!(await enterWithFallback(qa, expectation, invalid.code))) return;

      // 無効コードを申込ドメインへ直接渡した場合も代理店として扱われないこと
      const applicationEntry = new URL(
        expectation.application.expectedPath,
        `${config.environment.applicationBaseUrl}/`,
      );
      applicationEntry.searchParams.set(config.agency.paramName, invalid.code);
      const reached = await qa.goto({ url: applicationEntry.toString(), agencyCode: invalid.code });
      if (!reached) return;

      qa.addAll(
        await verifyFallbackHandoff(page, config, expectation, `無効コード ${invalid.code}: 申込ページ`),
      );
      qa.collectMonitorFindings();
    });
  }

  // ------------------------------------------------------------------
  // (9) 他の代理店のコードに置き換えられていないこと (組み合わせ検証)
  //     ある代理店で流入したのに、別の代理店として認識されないことを確認する
  // ------------------------------------------------------------------
  for (const spec of specs) {
    test(`${spec.code}: 申込ページで他の代理店として認識されない`, async ({ qa, page }) => {
      if (!(await enterAsAgency(qa, spec))) return;

      if (qa.isReadOnly && requiresWriteRequest(spec)) {
        qa.add({
          category: 'agency-handoff',
          severity: 'low',
          title: `${spec.code}: 読み取り専用環境のため申込側の認識確認をスキップしました`,
          expected: '読み取り専用環境ではデータ送信を行わない',
          actual: `${spec.application.handoffMethod} 方式は送信を伴うため未検証`,
          url: page.url(),
        });
        return;
      }

      const clicked = await clickCtaToApplication(page, spec, config);
      if (!clicked.navigated) return;

      // 申込側 API が返す代理店識別情報で確認する (画面表示だけに依存しない)
      const sessionApi = new URL(
        config.agency.application.sessionApiPattern.replace(/^\*\*/, '').replace(/\*$/, ''),
        config.environment.applicationBaseUrl,
      ).toString();
      const response = await page.request.get(sessionApi, { failOnStatusCode: false }).catch(() => null);

      if (!response || !response.ok()) {
        qa.add({
          category: 'agency-handoff',
          severity: 'high',
          title: `${spec.code}: 申込側 API から代理店情報を取得できません`,
          expected: `${sessionApi} が 200 を返すこと`,
          actual: response ? `HTTP ${response.status()}` : 'リクエスト失敗',
          url: page.url(),
        });
        return;
      }

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const recognizedCode = String(payload?.[config.agency.paramName] ?? '');

      if (recognizedCode !== spec.application.expectedCode) {
        qa.add({
          category: 'agency-handoff',
          severity: 'critical',
          title: `${spec.code}: 申込側が認識した代理店コードが誤っています`,
          expected: spec.application.expectedCode,
          actual: recognizedCode || '(なし)',
          url: page.url(),
        });
      }
      qa.collectMonitorFindings();
    });
  }
});
