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
import { capturePageSignatureStable, compareVisibleBlocks } from '../../utils/page-signature';
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

      const { missing: onlyLeft, extra: onlyRight, shared } = compareVisibleBlocks(
        leftSignature,
        rightSignature,
        ignoreKeys,
      );

      if (onlyLeft.length === 0 && onlyRight.length === 0) {
        qa.add({
          category: 'agency-display',
          severity: 'critical',
          title: `${leftProfile} と ${rightProfile} で表示が同じです (切り替えが効いていません)`,
          expected: `${left.code} (${leftProfile}) と ${right.code} (${rightProfile}) で表示が異なること`,
          actual: `表示されているブロックが完全に一致 (${shared.length} 件)`,
          url: rightSignature.url,
          detail:
            'みらやく掲載可否による表示切り替えが機能していない可能性があります。' +
            `比較: ${left.code} と ${right.code}`,
        });
      } else {
        // 差分の内容を記録する (設定に反映できるようにする)
        qa.add({
          category: 'agency-display',
          severity: 'low',
          title: `[確認OK] ${leftProfile} と ${rightProfile} の表示差分`,
          expected: `${leftProfile} と ${rightProfile} で表示が異なること`,
          actual:
            `${leftProfile} だけ: ${describeKeys(onlyLeft)} / ` +
            `${rightProfile} だけ: ${describeKeys(onlyRight)}`,
          url: rightSignature.url,
        });
      }
      qa.collectMonitorFindings();
    });
  }
});
