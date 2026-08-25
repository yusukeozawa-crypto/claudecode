/**
 * 表示の一貫性検査 (@agency)。
 *
 * みらやくの表示・非表示は 1 つのセクションだけでなく、
 * フッターの表記や各所の注釈にも及ぶ。どこが変わるかを列挙しきれないため、
 * 「どこが変わるか」を知らずに成立する次の性質で検査する。
 *
 *   1. 同じパターンの代理店同士は表示が一致するはず
 *      一致しなければ、その代理店だけ扱いが違う (誤設定・データ不整合)
 *   2. 表示が異なるべきパターン同士 (みらやく ○ と ×) は相違があるはず
 *      同じなら切り替えそのものが効いていない
 *   3. 代理店コードを付けたら、コードなしと表示が変わるはず
 *      同じなら、そのコードは表示に何も効いていない
 *      (未登録コード・適用漏れ。ここが効いていないと以降の項目は無意味)
 *
 * セクション名を config に列挙する方式と併用できる。
 * こちらは「列挙漏れ」を埋めるための検査。
 */
import { test } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { agencySpecs, expectsDisplayChange, judgeCodeReflection } from '../../utils/agency';
import { observeAnshinOccurrences } from '../../utils/anshin-pack';
import { buildEntryUrl } from '../../utils/agency-entry';
import {
  capturePageSignatureStable, compareVisibleBlocks, diffTextLines, evaluateDisplayDifference,
} from '../../utils/page-signature';
import type { PageSignature } from '../../utils/page-signature';
import type { QaSession } from '../../utils/qa-session';
import type { AgencySpec } from '../../utils/types';

const config = loadConfig();
const specs = agencySpecs(config);
const ignoreKeys = new Set(config.agencies.displayIgnoreKeys ?? []);

/** パターンごとにまとめる (パターン未設定の代理店は対象外) */
function groupByProfile(entries: AgencySpec[]): Map<string, AgencySpec[]> {
  const groups = new Map<string, AgencySpec[]>();
  for (const spec of entries) {
    if (!spec.profile) continue;
    const list = groups.get(spec.profile);
    if (list) list.push(spec);
    else groups.set(spec.profile, [spec]);
  }
  return groups;
}

const groups = groupByProfile(specs);

function describeKeys(keys: string[]): string {
  const shown = keys.slice(0, 8).join(', ');
  return keys.length > 8 ? `${shown} ...他 ${keys.length - 8} 件` : shown || '(なし)';
}

/** テキスト差分を読める形にする */
function describeLines(lines: string[]): string {
  const shown = lines.slice(0, 4).map((line) => `「${line.slice(0, 60)}」`).join(' / ');
  return lines.length > 4 ? `${shown} ...他 ${lines.length - 4} 行` : shown || '(なし)';
}

/** 代理店コードで LP を開き、表示シグネチャを取る */
async function captureFor(
  qa: QaSession,
  page: Parameters<typeof capturePageSignatureStable>[0],
  spec: AgencySpec,
): Promise<PageSignature | null> {
  const url = buildEntryUrl(config, spec.entryPath, spec.code);
  if (!(await qa.goto({ url, agencyCode: spec.code }))) return null;
  return capturePageSignatureStable(page);
}

test.describe('表示の一貫性 @agency @consistency', () => {
  // ------------------------------------------------------------------
  // 1. 同じパターンの代理店同士は表示が一致するはず
  // ------------------------------------------------------------------
  for (const [profile, members] of groups) {
    if (members.length < 2) continue;
    test(`${profile}: 同じ分類の代理店は表示が一致する (${members.length} 件)`, async ({ qa, page }) => {
      test.slow();
      const reference = members[0];
      const referenceSignature = await captureFor(qa, page, reference);
      if (!referenceSignature) return;

      for (const spec of members.slice(1)) {
        const signature = await captureFor(qa, page, spec);
        if (!signature) continue;
        const { missing, extra } = compareVisibleBlocks(referenceSignature, signature, ignoreKeys);

        if (missing.length > 0 || extra.length > 0) {
          qa.add({
            category: 'agency-display',
            severity: 'critical',
            title: `${spec.code}: 同じ分類 (${profile}) の代理店と表示が一致しません`,
            expected: `${reference.code} と同じ表示になること (分類: ${profile})`,
            actual:
              (missing.length > 0 ? `表示されていない: ${describeKeys(missing)}` : '') +
              (missing.length > 0 && extra.length > 0 ? ' / ' : '') +
              (extra.length > 0 ? `余分に表示されている: ${describeKeys(extra)}` : ''),
            url: signature.url,
            detail:
              'みらやく掲載可否の判定、または代理店ごとの設定に不整合がある可能性があります。' +
              `基準: ${reference.code} (${reference.label})`,
          });
        }

        // 表示の違いはセクションの有無だけでなく、フッターの表記や注釈など
        // 文言だけの違いとして現れることもある。
        // ただし代理店名のように代理店ごとに変わる文言もあるため、
        // ブロックの不一致 (Critical) とは分けて Medium で報告する。
        const textDiff = diffTextLines(referenceSignature, signature);
        if (textDiff.onlyInA.length > 0 || textDiff.onlyInB.length > 0) {
          qa.add({
            category: 'agency-display',
            severity: 'medium',
            title: `${spec.code}: 同じ分類 (${profile}) の代理店と文言が異なります`,
            expected: `${reference.code} と同じ文言になること (分類: ${profile})`,
            actual:
              `${reference.code} だけ: ${describeLines(textDiff.onlyInA)} / ` +
              `${spec.code} だけ: ${describeLines(textDiff.onlyInB)}`,
            url: signature.url,
            detail:
              '代理店名など代理店ごとに変わる文言であれば問題ありません。' +
              'みらやくの掲載可否に関わる文言が混ざっている場合は要確認です。',
          });
        }
      }
      qa.collectMonitorFindings();
    });
  }

  // ------------------------------------------------------------------
  // 2. 表示が異なるべきパターン同士は相違があるはず
  // ------------------------------------------------------------------
  for (const pair of config.agencies.displayMustDiffer ?? []) {
    const [leftProfile, rightProfile] = pair;
    const left = groups.get(leftProfile ?? '')?.[0];
    const right = groups.get(rightProfile ?? '')?.[0];
    if (!left || !right) continue;

    test(`${leftProfile} と ${rightProfile} は表示が異なる`, async ({ qa, page }) => {
      test.slow();
      const leftSignature = await captureFor(qa, page, left);
      if (!leftSignature) return;
      const rightSignature = await captureFor(qa, page, right);
      if (!rightSignature) return;

      // 表示の違いはセクションの有無だけでなく、フッターの表記や注釈など
      // 文言だけの違いとして現れることもある。両方を見ないと
      // 「切り替えが効いていない」と誤判定する。
      const difference = evaluateDisplayDifference(leftSignature, rightSignature, ignoreKeys);
      const { blocksDiffer, textDiffers, onlyInA: onlyLeft, onlyInB: onlyRight, sharedBlocks: shared } = difference;
      const textDiff = { onlyInA: difference.textOnlyInA, onlyInB: difference.textOnlyInB };

      if (!difference.differs) {
        qa.add({
          category: 'agency-display',
          severity: 'critical',
          title: `${leftProfile} と ${rightProfile} で表示が同じです (切り替えが効いていません)`,
          expected: `${left.code} (${leftProfile}) と ${right.code} (${rightProfile}) で表示が異なること`,
          actual: `表示ブロック (${shared.length} 件) と文言 (${leftSignature.textLines.length} 行) が完全に一致`,
          url: rightSignature.url,
          detail:
            'みらやく掲載可否による表示切り替えが機能していない可能性があります。' +
            `比較: ${left.code} と ${right.code}`,
        });
      } else {
        // 何が違うのかを記録する (設定に反映し、以降は変化を検知できるようにする)
        qa.add({
          category: 'agency-display',
          severity: 'low',
          title: `[確認OK] ${leftProfile} と ${rightProfile} の表示差分`,
          expected: `${leftProfile} と ${rightProfile} で表示が異なること`,
          actual:
            (blocksDiffer
              ? `ブロック — ${leftProfile} だけ: ${describeKeys(onlyLeft)} / ${rightProfile} だけ: ${describeKeys(onlyRight)}`
              : 'ブロックの構成は同一') +
            ' | ' +
            (textDiffers
              ? `文言 — ${leftProfile} だけ: ${describeLines(textDiff.onlyInA)} / ${rightProfile} だけ: ${describeLines(textDiff.onlyInB)}`
              : '文言は同一'),
          url: rightSignature.url,
          detail:
            'ここに出た差分が、みらやく掲載可否による表示の違いです。' +
            'セクションであれば config の visibleSections / hiddenSections に設定できます。',
        });
      }
      qa.collectMonitorFindings();
    });
  }
  // ------------------------------------------------------------------
  // 3. ① コードの反映 (コードなしと比べる)
  //
  //   実サイトで「代理店名も出ない・みらやくの切り替えも効かない」代理店が
  //   見つかった。個別の項目 (代理店名・安心パック) が別々に Critical に
  //   なるため、原因が 1 つ (コードが反映されていない) だと読み取れなかった。
  //
  //   これは総合判定ではなく最初に見る 1 歩目:
  //     変化なし       … コードなしと完全に同じ。右の項目を読む意味がない
  //     変化なしの疑い … 差分はあるが、期待した変化が 1 つも起きていない
  //     変化あり       … 右の項目を個別に読む
  //
  //   「差分があれば反映された」とはしない。Zoho の A/B テストや
  //   実行ごとに変わる文言でも差分は出るため、実サイトで 4 社を
  //   「反映された」と読み違えた (PC だけ差分が出て、SP は完全一致だった)。
  // ------------------------------------------------------------------
  /** コードなしの表示。同じワーカーの中では取り直さない (実行時間のため) */
  const noCodeBaselines = new Map<string, PageSignature>();

  async function noCodeBaseline(
    qa: QaSession,
    page: Parameters<typeof capturePageSignatureStable>[0],
    entryPath: string,
  ): Promise<PageSignature | null> {
    const cached = noCodeBaselines.get(entryPath);
    if (cached) return cached;
    const url = buildEntryUrl(config, entryPath, null);
    // コードなしを先に開く (コード付きを先に開くと保存された
    // コードが残り、コードなしの表示が汚れる)
    if (!(await qa.goto({ url, agencyCode: null }))) return null;
    const signature = await capturePageSignatureStable(page);
    // 取れなかった場合は覚えない (次のテストでもう一度試す)
    if (!signature) return null;
    noCodeBaselines.set(entryPath, signature);
    return signature;
  }

  /**
   * コードなしと表示が変わるはずの代理店。
   *
   * 判定は設定から導く (新しい設定項目を増やさない):
   *   代理店名が出る       … コードなしには出ないので必ず変わる
   *   安心パックが消える   … コードなしには出ているので必ず変わる
   * どちらでもない (自社コード = オリジナル表示) は対象外。
   */
  const sameAsNoCode = config.agencies.sameAsNoCodeProfiles ?? [];
  const mustChange = specs.filter((spec) => expectsDisplayChange(spec, sameAsNoCode));
  const notChecked = specs.filter((spec) => !expectsDisplayChange(spec, sameAsNoCode));

  /** フッターの代理店名の接頭辞 (「募集代理店：」)。会社名の表記ゆれに依存しない */
  const namePrefix = (config.agency.agencyNameTexts?.footer ?? '').split('{company}')[0].trim();

  for (const spec of mustChange) {
    test(`${spec.code}: ① コードの反映`, async ({ qa, page }) => {
      test.slow();
      const baseline = await noCodeBaseline(qa, page, spec.entryPath);
      if (!baseline) return;
      const signature = await captureFor(qa, page, spec);
      if (!signature) return;

      const difference = evaluateDisplayDifference(baseline, signature, ignoreKeys);

      // 期待した変化が実際に起きたかを、この場で測る。
      //   差分の有無だけでは「反映された」と言えないため
      //   (A/B テストの割り当てでも差分は出る)。
      const nameShown = spec.agencyName === 'shown' && namePrefix !== ''
        ? signature.textLines.some((line) => line.includes(namePrefix))
        : null;
      const texts = config.agency.agencyNameTexts;
      const anshinCleared = spec.anshinPack === 'absent' && texts
        ? (await observeAnshinOccurrences(
          page,
          texts.anshinPack ?? [],
          texts.anshinPackAnnotationMarkers ?? ['※'],
          texts.anshinPackNegations ?? [],
          (texts.anshinPackAlwaysForbidden ?? []).map((entry) => entry.text),
          (texts.anshinPackAlwaysAllowed ?? []).map((entry) => entry.text),
        )).every((entry) => entry.allowed)
        : null;

      const verdict = judgeCodeReflection({ differs: difference.differs, nameShown, anshinCleared });
      const expectedChanges = [
        spec.agencyName === 'shown' ? '代理店名が出る' : '',
        spec.anshinPack === 'absent' ? '安心パックの記載が消える' : '',
      ]
        .filter((part) => part !== '')
        .join(' / ');
      const observedChanges = [
        nameShown === null ? '' : `代理店名: ${nameShown ? '出ている' : '出ていない'}`,
        anshinCleared === null ? '' : `安心パック: ${anshinCleared ? '消えている' : '残っている'}`,
      ]
        .filter((part) => part !== '')
        .join(' / ');
      const noCodeUrl = buildEntryUrl(config, spec.entryPath, null);

      if (verdict === 'unchanged') {
        qa.add({
          checkId: 'code-effective',
          checkOk: false,
          observedValue: '変化なし',
          expectedValue: '変化あり',
          observedDetail: ['コードなしと完全一致', `文言 ${baseline.textLines.length} 行`],
          category: 'agency-display',
          severity: 'critical',
          title: `${spec.label}: コードを付けても表示が変わりません (コードなしと完全一致)`,
          expected: `コードを付けると ${expectedChanges} こと`,
          actual:
            `表示ブロック (${difference.sharedBlocks.length} 件) と文言 (${baseline.textLines.length} 行) が`
            + 'コードなしと完全に一致',
          url: signature.url,
          agencyCode: spec.code,
          detail:
            'このコードが未登録か、コードの適用そのものが効いていない可能性があります。'
            + 'この状態では代理店名も みらやく掲載可否も反映されないため、'
            + 'ほかの項目の検知はすべてこの 1 つが原因です。'
            + `比較したのはコードなしの ${noCodeUrl} です。`,
        });
      } else if (verdict === 'suspect') {
        qa.add({
          checkId: 'code-effective',
          checkOk: false,
          observedValue: '変化なしの疑い',
          expectedValue: '変化あり',
          observedDetail: ['期待した変化が起きていない', observedChanges],
          category: 'agency-display',
          // 完全一致より弱い根拠なので Critical にはしない。
          // ただし人が必ず見るように High にする (放置させない)。
          severity: 'high',
          title: `${spec.label}: コードを付けても期待した変化が起きていません (要目視)`,
          expected: `コードを付けると ${expectedChanges} こと`,
          actual:
            `${observedChanges}。コードなしとの差分はありますが `
            + `(ブロック +${difference.onlyInB.length} / -${difference.onlyInA.length}、`
            + `文言 +${difference.textOnlyInB.length} / -${difference.textOnlyInA.length} 行)、`
            + '期待した変化は 1 つも起きていません',
          url: signature.url,
          agencyCode: spec.code,
          detail:
            '差分は A/B テストの割り当てや、実行ごとに変わる文言でも出ます。'
            + 'そのため差分があることは「コードが反映された」証拠になりません。'
            + `実際にブラウザで開いて確認してください: ${signature.url} `
            + `(比較したコードなし: ${noCodeUrl})`,
        });
      } else {
        qa.add({
          checkId: 'code-effective',
          checkOk: true,
          observedValue: '変化あり',
          expectedValue: '変化あり',
          observedDetail: [
            observedChanges || '差分あり',
            `文言 +${difference.textOnlyInB.length} / -${difference.textOnlyInA.length} 行`,
          ],
          category: 'agency-display',
          severity: 'low',
          title: `[確認OK] ${spec.label}: コードを付けると表示が変わります`,
          expected: `コードを付けると ${expectedChanges} こと`,
          actual:
            (difference.blocksDiffer
              ? `ブロック — コードなしだけ: ${describeKeys(difference.onlyInA)} / `
                + `${spec.code} だけ: ${describeKeys(difference.onlyInB)}`
              : 'ブロックの構成は同一')
            + ' | '
            + (difference.textDiffers
              ? `文言 — コードなしだけ: ${describeLines(difference.textOnlyInA)} / `
                + `${spec.code} だけ: ${describeLines(difference.textOnlyInB)}`
              : '文言は同一')
            + (observedChanges === '' ? '' : ` | ${observedChanges}`),
          url: signature.url,
          agencyCode: spec.code,
        });
      }
      qa.collectMonitorFindings();
    });
  }

  // 検査していないのではなく「変わらないのが正しい」代理店。
  //   表を「ー」にすると「検査漏れ」と読めてしまうため、
  //   対象外であることを記録する (ページは開かない)。
  if (notChecked.length > 0) {
    test(`① コードの反映: 対象外の代理店を記録する (${notChecked.length} 件)`, async ({ qa }) => {
      for (const spec of notChecked) {
        qa.add({
          checkId: 'code-effective',
          // 正解が「変わらないこと」なので合否は付けない (表では白のまま)
          observedValue: '対象外',
          expectedValue: null,
          observedDetail: ['コードを付けても変わらないのが正しい'],
          category: 'agency-display',
          severity: 'low',
          title: `[対象外] ${spec.label}: コードの反映は検査しません`,
          expected: 'コードなしと同じ表示になること (自社コードなど)',
          actual: '期待結果が「表示は変わらない」ため、この項目は判定しません',
          agencyCode: spec.code,
        });
      }
    });
  }

  // ------------------------------------------------------------------
  // 4. コードなしと同じ表示になるはずのパターン
  //    支店コードのように「コードを付けても何も変わらない」ものを検査する。
  //    差分が出た場合、仕様変更 (支店コードが有効になった) か
  //    不具合のどちらとも断定できないため Medium で報告する。
  // ------------------------------------------------------------------
  for (const profile of config.agencies.sameAsNoCodeProfiles ?? []) {
    const member = groups.get(profile)?.[0];
    if (!member) continue;

    test(`${profile} はコードなしと同じ表示になる`, async ({ qa, page }) => {
      test.slow();
      // 基準はコードなしの LP
      const baselineUrl = buildEntryUrl(config, member.entryPath, null);
      if (!(await qa.goto({ url: baselineUrl, agencyCode: null }))) return;
      const baseline = await capturePageSignatureStable(page);
      if (!baseline) return;

      const signature = await captureFor(qa, page, member);
      if (!signature) return;

      const difference = evaluateDisplayDifference(baseline, signature, ignoreKeys);
      if (!difference.differs) {
        qa.add({
          category: 'agency-display',
          severity: 'low',
          title: `[確認OK] ${profile} (${member.code}) はコードなしと同じ表示です`,
          expected: 'コードなしの表示と一致すること',
          actual: `表示ブロック ${difference.sharedBlocks.length} 件・文言ともに一致`,
          url: signature.url,
        });
      } else {
        qa.add({
          category: 'agency-display',
          severity: 'medium',
          title: `${member.code}: コードなしと表示が異なります (${profile})`,
          expected: `${profile} はコードなしと同じ表示になること`,
          actual:
            (difference.blocksDiffer
              ? `ブロック — コードなしだけ: ${describeKeys(difference.onlyInA)} / ${member.code} だけ: ${describeKeys(difference.onlyInB)}`
              : 'ブロックの構成は同一') +
            ' | ' +
            (difference.textDiffers
              ? `文言 — コードなしだけ: ${describeLines(difference.textOnlyInA)} / ${member.code} だけ: ${describeLines(difference.textOnlyInB)}`
              : '文言は同一'),
          url: signature.url,
          detail:
            '支店コードが有効になった (仕様変更) か、表示が意図せず変わった可能性があります。' +
            '仕様変更であれば config/agency-profiles.yml の sameAsNoCodeProfiles から外してください。',
        });
      }
      qa.collectMonitorFindings();
    });
  }
});
