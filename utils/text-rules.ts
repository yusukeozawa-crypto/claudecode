/**
 * 誤字脱字・表記揺れのルールベース検出。
 * ルールは config/text-rules.yml で管理し、コード側にサイト固有の語を持たない。
 */
import type { FindingInput, QaConfig, TextRulesFile } from './types';

export interface TextIssue {
  ruleId: string;
  kind: 'unify' | 'canonical' | 'insurance-term' | 'prohibited' | 'typo' | 'formatting';
  found: string;
  suggestion?: string;
  note?: string;
  /** 検出箇所の前後を含む抜粋 */
  excerpt: string;
  count: number;
}

/** 除外語の位置を求め、その範囲での検出を無視できるようにする */
function excludedRanges(text: string, excludeWords: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const word of excludeWords) {
    if (!word) continue;
    let from = 0;
    for (;;) {
      const index = text.indexOf(word, from);
      if (index === -1) break;
      ranges.push([index, index + word.length]);
      from = index + word.length;
    }
  }
  return ranges;
}

function isInExcludedRange(index: number, length: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index + length <= end);
}

function findOccurrences(text: string, needle: string): number[] {
  const positions: number[] = [];
  if (!needle) return positions;
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) break;
    positions.push(index);
    from = index + needle.length;
  }
  return positions;
}

function excerptAt(text: string, index: number, length: number, window = 20): string {
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + length + window);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

/** 表示テキストからルール違反を抽出する */
export function detectTextIssues(text: string, rules: TextRulesFile): TextIssue[] {
  const issues: TextIssue[] = [];
  const excluded = excludedRanges(text, rules.excludeWords);

  const pushOccurrences = (
    needle: string,
    make: (excerpt: string, count: number) => TextIssue,
    skipIndex?: (index: number) => boolean,
  ): void => {
    const positions = findOccurrences(text, needle).filter(
      (index) => !isInExcludedRange(index, needle.length, excluded) && !(skipIndex?.(index) ?? false),
    );
    if (positions.length === 0) return;
    issues.push(make(excerptAt(text, positions[0], needle.length), positions.length));
  };

  // --- 表記統一ルール ---
  for (const rule of rules.unifyRules) {
    if (rule.detectOnly) {
      // 併用のみを検出する (どちらが正しいかは文脈依存)
      const present = rule.variants.filter((variant) => {
        const positions = findOccurrences(text, variant).filter(
          (index) => !isInExcludedRange(index, variant.length, excluded),
        );
        return positions.length > 0;
      });
      if (present.length > 1) {
        issues.push({
          ruleId: rule.id,
          kind: 'unify',
          found: present.join(' / '),
          note: rule.note ?? '表記が併用されています',
          excerpt: excerptAt(text, text.indexOf(present[0]), present[0].length),
          count: present.length,
        });
      }
      continue;
    }

    for (const variant of rule.variants) {
      if (rule.preferred && variant === rule.preferred) continue;
      // 「お申込み」が「お申し込み」の一部として誤検出されないよう、
      // 正式表記の位置と重なる検出は除外する
      const preferredPositions = rule.preferred ? findOccurrences(text, rule.preferred) : [];
      pushOccurrences(
        variant,
        (excerpt, count) => ({
          ruleId: rule.id,
          kind: 'unify',
          found: variant,
          suggestion: rule.preferred ?? undefined,
          note: rule.note,
          excerpt,
          count,
        }),
        (index) =>
          preferredPositions.some(
            (preferredIndex) =>
              index >= preferredIndex && index + variant.length <= preferredIndex + (rule.preferred?.length ?? 0),
          ),
      );
    }
  }

  // --- 正式名称の誤表記 ---
  for (const [wrong, correct] of Object.entries(rules.canonical.aliases ?? {})) {
    pushOccurrences(wrong, (excerpt, count) => ({
      ruleId: `canonical:${wrong}`,
      kind: 'canonical',
      found: wrong,
      suggestion: correct,
      note: '正式名称と異なる表記です',
      excerpt,
      count,
    }));
  }

  // --- 保険用語の統一 ---
  for (const term of rules.insuranceTerms) {
    for (const variant of term.variants) {
      pushOccurrences(variant, (excerpt, count) => ({
        ruleId: `insurance-term:${term.preferred}`,
        kind: 'insurance-term',
        found: variant,
        suggestion: term.preferred,
        note: '保険用語の表記統一',
        excerpt,
        count,
      }));
    }
  }

  // --- 使用禁止表現 ---
  for (const entry of rules.prohibited) {
    pushOccurrences(entry.pattern, (excerpt, count) => ({
      ruleId: `prohibited:${entry.pattern}`,
      kind: 'prohibited',
      found: entry.pattern,
      note: entry.reason,
      excerpt,
      count,
    }));
  }

  // --- 誤字候補 ---
  for (const pattern of rules.typoPatterns) {
    const exceptions = pattern.exceptWhenFollowedBy ?? [];
    pushOccurrences(
      pattern.wrong,
      (excerpt, count) => ({
        ruleId: `typo:${pattern.wrong}`,
        kind: 'typo',
        found: pattern.wrong,
        suggestion: pattern.correct,
        note: '誤字の候補',
        excerpt,
        count,
      }),
      (index) => {
        const following = text.slice(index + pattern.wrong.length);
        return exceptions.some((exception) => following.startsWith(exception));
      },
    );
  }

  // --- 体裁 ---
  if (rules.formatting.detectDoubleSpace) {
    const match = /[^\S\n]{2,}/.exec(text);
    if (match && match.index !== undefined) {
      issues.push({
        ruleId: 'formatting:double-space',
        kind: 'formatting',
        found: '連続スペース',
        note: '連続したスペースがあります',
        excerpt: excerptAt(text, match.index, match[0].length),
        count: (text.match(/[^\S\n]{2,}/g) ?? []).length,
      });
    }
  }

  if (rules.formatting.detectFullWidthAlphaNum) {
    const regex = /[Ａ-Ｚａ-ｚ０-９]{2,}/g;
    const matches = Array.from(text.matchAll(regex)).filter(
      (match) => match.index !== undefined && !isInExcludedRange(match.index, match[0].length, excluded),
    );
    if (matches.length > 0) {
      const first = matches[0];
      issues.push({
        ruleId: 'formatting:full-width-alnum',
        kind: 'formatting',
        found: first[0],
        note: '全角の英数字が使用されています',
        excerpt: excerptAt(text, first.index ?? 0, first[0].length),
        count: matches.length,
      });
    }
  }

  return issues;
}

/** ルール違反を Finding に変換する (重大度は Low、使用禁止表現のみ Medium) */
export function textIssuesToFindings(
  issues: TextIssue[],
  context: { url: string; pageId?: string; pageName?: string },
): FindingInput[] {
  return issues.map((issue) => ({
    category: 'text-rule',
    severity: issue.kind === 'prohibited' ? 'medium' : 'low',
    title: `${describeKind(issue.kind)}: ${issue.found}${issue.count > 1 ? ` (${issue.count} 箇所)` : ''}`,
    expected: issue.suggestion ? `「${issue.suggestion}」に統一` : issue.note ?? '表記の確認',
    actual: `「${issue.found}」を検出`,
    url: context.url,
    pageId: context.pageId,
    pageName: context.pageName,
    detail: [issue.note, `該当箇所: ${issue.excerpt}`, `ルール: ${issue.ruleId}`].filter(Boolean).join(' / '),
  }));
}

function describeKind(kind: TextIssue['kind']): string {
  switch (kind) {
    case 'unify':
      return '表記揺れ';
    case 'canonical':
      return '正式名称の誤表記';
    case 'insurance-term':
      return '保険用語の表記揺れ';
    case 'prohibited':
      return '使用禁止表現';
    case 'typo':
      return '誤字候補';
    case 'formatting':
      return '体裁の不統一';
    default:
      return '表記の指摘';
  }
}

/** サイト横断の表記揺れ (ページ間で表記が分かれているもの) を検出する */
/**
 * 除外語の範囲と重ならない出現があるか。
 * ページ単位の検査と同じ扱いにするため、既存の excludedRanges を再利用する
 * (例: WEB のルールで WEBRTC を拾わない)。
 */
function hasRelevantOccurrence(text: string, term: string, excludeWords: string[]): boolean {
  if (!term) return false;
  const ranges = excludedRanges(text, excludeWords ?? []);
  return findOccurrences(text, term).some((index) => !isInExcludedRange(index, term.length, ranges));
}

export function detectCrossPageInconsistency(
  perPageText: Array<{ pageId: string; text: string }>,
  config: QaConfig,
): FindingInput[] {
  const findings: FindingInput[] = [];

  for (const rule of config.text.unifyRules) {
    if (rule.detectOnly) continue;
    const usage = new Map<string, string[]>();
    const candidates = rule.preferred ? [rule.preferred, ...rule.variants] : rule.variants;

    for (const candidate of candidates) {
      for (const page of perPageText) {
        // 除外語 (固有名詞など) の中に含まれる出現は数えない。
        // ページ単位の検査と同じ扱いにする (例: WEB のルールで WEBRTC を拾わない)
        if (hasRelevantOccurrence(page.text, candidate, config.text.excludeWords)) {
          const pages = usage.get(candidate) ?? [];
          pages.push(page.pageId);
          usage.set(candidate, pages);
        }
      }
    }

    if (usage.size > 1) {
      findings.push({
        category: 'text-rule',
        severity: 'low',
        title: `ページ間で表記が分かれています (${rule.id})`,
        expected: rule.preferred ? `「${rule.preferred}」に統一` : '表記を統一',
        actual: Array.from(usage.entries())
          .map(([term, pages]) => `${term}: ${pages.join(', ')}`)
          .join(' / '),
        url: config.environment.baseUrl,
        detail: rule.note,
      });
    }
  }

  return findings;
}
