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
import { expectedApplicationHost } from '../../utils/config';

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

  // 引き継ぎ方式が確定している代理店 (application 設定済み) も対象にする。
  // 「申込フォームに遷移してもコードが維持される」は全代理店で必須のため、
  // 方式の設定有無で検査の有無が変わってはならない。
  for (const spec of specs) {
    test(`${spec.code}: 申込フォームに遷移してもコードが維持される`, async ({ qa, page, context }) => {
      test.slow();
      // サイト側でコードとして扱われない (支店コードなど) 場合は
      // 引き継がれないのが正しい挙動なので検査しない
      test.skip(
        spec.recognized === false,
        'このコードはサイト側で代理店コードとして扱われないため、引き継ぎを期待しません',
      );

      // 新しいタブで開く場合にも安全装置を効かせる
      await installContextGuards(context, config, (finding) => qa.add(finding));

      if (!(await enterAsAgency(qa, spec))) return;

      // 申込への入口は「文言」ではなく「行き先」で探す。
      //
      //   文言 (text=今すぐ申込) で探すと、SP と専用 LP で別の要素に当たり
      //   押せず、正常なサイトを「申込フォームへ遷移できない」と
      //   誤って報告していた。行き先で探せば、文言やデザインが変わっても
      //   壊れない。
      const expectedHost = expectedApplicationHost(config, null);
      const before = page.url();
      const links = await observeApplicationLinks(page, config, spec.code);
      // リンクを優先し、無ければ送信フォーム (POST 方式の代理店) を使う
      const clickable = [...links.filter((link) => link.kind === 'link'), ...links.filter((link) => link.kind === 'form')];
      const target = clickable.find((link) => link.visible) ?? clickable[0] ?? null;

      if (!target) {
        qa.add({
          category: 'agency-handoff',
          severity: 'critical',
          title: `${spec.code}: 申込サイトへの導線が見つかりません`,
          expected: `${expectedHost} へ行くリンクがあること`,
          actual: 'リンクもフォームも見つかりません',
          url: before,
          agencyCode: spec.code,
        });
        qa.collectMonitorFindings();
        return;
      }

      // 押せる状態で見つからなかった場合は、それ自体を報告する。
      //   引き継ぎの確認は遷移先を直接開いて続ける
      //   (「押せない」と「引き継がれない」を切り分けるため)。
      const hiddenOnly = !target.visible;
      if (hiddenOnly) {
        qa.add({
          category: 'agency-handoff',
          severity: 'high',
          title: `${spec.code}: 申込ボタンが画面に表示されていません`,
          expected: '申込ボタンが表示されていて押せること',
          actual: `リンクは ${clickable.length} 件あるが、いずれも表示されていません (例: 「${target.text}」→ ${target.path})`,
          url: before,
          agencyCode: spec.code,
          detail:
            '固定ヘッダー・追従バナー・折りたたみの中に隠れている可能性があります。' +
            '引き継ぎの確認は遷移先を直接開いて続けました。',
        });
      }

      // 押す相手も「表示されている方」を選ぶ。
      //   PC 用と SP 用のボタンが両方 HTML にあるため、:visible を付けないと
      //   隠れている方を押して「反応しません」と誤検知する。
      const selector =
        target.kind === 'form'
          ? `form[action="${target.url}"] :is(button, input[type="submit"])`
          : `a[href="${target.url}"]`;
      const visibleLocator = page.locator(`${selector} >> visible=true`).first();
      const locator = (await visibleLocator.count()) > 0 ? visibleLocator : page.locator(selector).first();
      let clicked = false;
      if (!hiddenOnly && (await locator.count()) > 0) {
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
        // 別タブで開く場合 (target="_blank") に備える。
        //   元のページの URL を見ているだけでは「遷移していない」と
        //   誤判定する (実サイトの専用 LP で発生した)。
        const popupPromise = context.waitForEvent('page', { timeout: 20000 }).catch(() => null);
        clicked = await locator
          .click({ timeout: 15000 })
          .then(() => true)
          .catch(() => false);
        // 重なりで押せない場合は重なりを無視して押す
        if (!clicked) {
          clicked = await locator
            .click({ timeout: 8000, force: true })
            .then(() => true)
            .catch(() => false);
        }
        if (!clicked) {
          qa.add({
            category: 'agency-handoff',
            severity: 'high',
            title: `${spec.code}: 申込ボタンを押せませんでした`,
            expected: '申込ボタンを押せること',
            actual: `「${target.text}」を押しても反応しません`,
            url: before,
            agencyCode: spec.code,
            detail: '他の要素が重なっている可能性があります。遷移先を直接開いて引き継ぎの確認を続けました。',
          });
        }

        // 別タブが開いた場合はその行き先を確認する。
        //   Cookie は同じコンテキストで共有されるため、
        //   その URL を元のタブで開いても引き継ぎの確認は成立する。
        const popup = await popupPromise;
        if (popup) {
          await popup.waitForLoadState('load').catch(() => undefined);
          const popupUrl = popup.url();
          await popup.close().catch(() => undefined);
          if (popupUrl && popupUrl !== 'about:blank') {
            await qa.goto({ url: popupUrl, agencyCode: spec.code });
          }
        }
      }

      // 押せなかった場合は遷移先を直接開く (引き継ぎは確認できる)。
      // フォーム方式は送信内容が URL に無いため直接開けない
      if (!clicked && target.kind === 'link') {
        await qa.goto({ url: target.url, agencyCode: spec.code });
      }

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
