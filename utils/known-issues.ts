/**
 * 既知の不具合の扱い。
 *
 * すでに把握していて修正リリースが決まっている不具合は、
 * 毎回 Critical で報告されると本当の異常が埋もれてしまう。
 * かといって期待結果を現状に書き換えると、
 * 「修正されたこと」も「壊れ直したこと」も分からなくなる。
 *
 * そこで期待結果は仕様どおりのままにし、検知結果だけを
 *   ・修正日前 → Low に落とす (既知として記録は残す)
 *   ・修正日以降 → 通常の重大度で報告する
 * と切り替える。修正リリース後に直っていなければ、その日から Critical で出る。
 */
import { matchesAnyGlob } from './patterns';
import type { Finding, KnownIssue, QaConfig } from './types';

/** 「修正日を過ぎていない」= まだ既知として扱う */
export function isActive(issue: KnownIssue, now: Date = new Date()): boolean {
  if (!issue.fixedOn) return true;
  const fixedOn = new Date(`${issue.fixedOn}T00:00:00`);
  if (Number.isNaN(fixedOn.getTime())) return true;
  return now < fixedOn;
}

/** いま既知として扱う不具合の一覧 */
export function activeKnownIssues(config: QaConfig, now: Date = new Date()): KnownIssue[] {
  return (config.knownIssues?.knownIssues ?? []).filter((issue) => isActive(issue, now));
}

/**
 * この検知結果が既知の不具合に該当するか。
 * 代理店コードと検知種別の両方が一致したときだけ該当とみなす
 * (同じ代理店の別の不具合を見逃さないため)。
 */
export function matchKnownIssue(
  finding: Pick<Finding, 'category' | 'agencyCode'>,
  config: QaConfig,
  now: Date = new Date(),
): KnownIssue | null {
  const code = finding.agencyCode;
  if (!code || code === 'none') return null;
  for (const issue of activeKnownIssues(config, now)) {
    if (issue.categories.length > 0 && !issue.categories.includes(finding.category)) continue;
    const codes = issue.codes ?? [];
    const matched = codes.includes(code) || matchesAnyGlob(code, codes.filter((pattern) => pattern.includes('*')));
    if (matched) return issue;
  }
  return null;
}

/**
 * 既知の不具合に該当する検知結果を Low に落とす。
 * 元の重大度は残す (直っていないことを後から判断できるようにするため)。
 */
export function applyKnownIssue(finding: Finding, config: QaConfig, now: Date = new Date()): Finding {
  const issue = matchKnownIssue(finding, config, now);
  if (!issue) return finding;
  if (finding.severity === 'low') return finding;
  const fixedOn = issue.fixedOn ? ` (${issue.fixedOn} 修正予定)` : '';
  return {
    ...finding,
    severity: 'low',
    title: `[既知${fixedOn}] ${finding.title}`,
    detail: [
      `既知の不具合として登録済み: ${issue.title} (${issue.id})`,
      `本来の重大度: ${finding.severity}`,
      issue.note?.trim(),
      finding.detail,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' / '),
  };
}
