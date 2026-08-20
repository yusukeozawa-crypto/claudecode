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
 *
 * セクション名を config に列挙する方式と併用できる。
 * こちらは「列挙漏れ」を埋めるための検査。
 */
import { test } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { agencySpecs } from '../../utils/agency';
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
  // 3. コードなしと同じ表示になるはずのパターン
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
