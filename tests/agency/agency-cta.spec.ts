/**
 * 申込導線の観測 (引き継ぎ方式が未確定でも実行できる検査)。
 *
 * 申込サイトへの引き継ぎ方式 (クエリ / Cookie / サーバーセッション / JavaScript) が
 * 確定していない段階では、方式を推測して合否を出すことはできない。
 * そこで、この検査では DOM から読み取れる事実だけを記録する:
 *   - 申込サイト (applicationBaseUrl) へ向かうリンク / フォームがあるか
 *   - そのボタンの表示文言 (config の selectors.ctaPrimary を実物に合わせるため)
 *   - リンクの URL に代理店コードが乗っているか
 *
 * クリックも送信も行わないため、本番 (読み取り専用) でも安全に実行できる。
 * 方式が確定したら agencies.yml の application を設定し、
 * tests/agency/agency-handoff.spec.ts の検査へ移す。
 */
import { test } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { agencySpecs } from '../../utils/agency';
import {
  describeApplicationLinks, installContextGuards, observeApplicationLinks,
  observeCodeInApplication, verifyCodeCarried,
} from '../../utils/handoff';
import { enterAsAgency } from '../../utils/agency-entry';
import { resolveSelector, expectedApplicationHost } from '../../utils/config';

const config = loadConfig();
const specs = agencySpecs(config);

/** application が設定済みの代理店は本来の引き継ぎ検査 (handoff) で検証する */
const observeSpecs = specs.filter((spec) => spec.application === null);

test.describe('申込導線の観測 @agency @cta', () => {
  test.skip(
    !config.environment.applicationBaseUrl,
    '申込サイトの URL (applicationBaseUrl) が未設定のため実行しません',
  );

  for (const spec of observeSpecs) {
    test(`${spec.code}: 申込サイトへの導線を記録する`, async ({ qa, page }) => {
      if (!(await enterAsAgency(qa, spec))) return;

      const links = await observeApplicationLinks(page, config, spec.code);
      qa.addAll(describeApplicationLinks(links, config, spec.code, page.url()));
      qa.collectMonitorFindings();
    });
  }

  // ------------------------------------------------------------------
  // 申込フォームへ遷移してもコードが維持されていること (必須)
  //
  //   引き継ぎ方式が未確定でも検査できるように、コードの置き場所を
  //   すべて見る (URL / 入力値 / 表示テキスト / 保存領域 / Cookie)。
  //   どこか 1 つでも残っていれば維持されているとみなす。
  //   方式を推測して 1 か所だけ見ると、正常なサイトを不具合として報告してしまう。
  //
  //   申込ボタンを押して遷移するだけで、入力も送信も行わない。
  // ------------------------------------------------------------------
  const ctaSelectorSource = config.agency.selectors.ctaPrimary;

  // 引き継ぎ方式が確定している代理店 (application 設定済み) も対象にする。
  // 「申込フォームに遷移してもコードが維持される」は全代理店で必須のため、
  // 方式の設定有無で検査の有無が変わってはならない。
  for (const spec of specs) {
    test(`${spec.code}: 申込フォームに遷移してもコードが維持される`, async ({ qa, page, context }) => {
      test.slow();
      test.skip(!ctaSelectorSource, '申込ボタンのセレクタ (selectors.ctaPrimary) が未設定です');
      // サイト側でコードとして扱われない (支店コードなど) 場合は
      // 引き継がれないのが正しい挙動なので検査しない
      test.skip(
        spec.recognized === false,
        'このコードはサイト側で代理店コードとして扱われないため、引き継ぎを期待しません',
      );

      // 新しいタブで開く場合にも安全装置を効かせる
      await installContextGuards(context, config, (finding) => qa.add(finding));

      if (!(await enterAsAgency(qa, spec))) return;

      // 代理店ごとに申込への入口が違う場合 (POST 送信のボタンなど) は
      // その代理店の CTA を使う。共通のセレクタで固定すると、
      // 正常なサイトを「申込フォームへ遷移できない」と誤って報告してしまう。
      const ctaSource = spec.cta?.testId ?? ctaSelectorSource!;
      const cta = page.locator(resolveSelector(ctaSource)).first();
      if ((await cta.count()) === 0) {
        qa.add({
          category: 'agency-handoff',
          severity: 'high',
          title: `${spec.code}: 申込ボタンが見つかりません`,
          expected: `${ctaSource} に一致するボタンがあること`,
          actual: '一致する要素がありません',
          url: page.url(),
        });
        return;
      }

      const expectedHost = expectedApplicationHost(config, null);
      const before = page.url();
      await cta.click({ timeout: 15000 }).catch((error: unknown) => {
        qa.add({
          category: 'agency-handoff',
          severity: 'high',
          title: `${spec.code}: 申込ボタンを押せませんでした`,
          expected: '申込ボタンを押せること',
          actual: String(error).split('\n')[0],
          url: before,
        });
      });
      // 別ドメインへの遷移を待つ (押しても遷移しない場合は下で報告する)
      await page.waitForURL((url) => url.host === expectedHost, { timeout: 20000 }).catch(() => undefined);
      await page.waitForLoadState('load').catch(() => undefined);

      const afterUrl = page.url();
      if (new URL(afterUrl).host !== expectedHost) {
        qa.add({
          category: 'agency-handoff',
          severity: 'critical',
          title: `${spec.code}: 申込フォームへ遷移できませんでした`,
          expected: `${expectedHost} へ遷移すること`,
          actual: `遷移先: ${afterUrl}`,
          url: afterUrl,
          agencyCode: spec.code,
        });
        qa.collectMonitorFindings();
        return;
      }

      qa.findings.setContext({ url: afterUrl });
      const otherCodes = specs.filter((entry) => entry.code !== spec.code).map((entry) => entry.code);
      const observation = await observeCodeInApplication(page, config, spec.code, otherCodes);
      qa.addAll(verifyCodeCarried(observation, spec.code, spec.code));
      await qa.captureScreenshot(`application-${spec.code}`);
      qa.collectMonitorFindings();
    });
  }
});
