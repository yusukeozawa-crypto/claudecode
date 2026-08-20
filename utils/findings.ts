/**
 * 検知結果 (Finding) の収集と重大度ゲート。
 *
 * 重大度の方針 (docs/severity.md):
 *   critical … 代理店の誤表示、代理店コードの欠落、申込への誤引き継ぎ
 *   high     … 申込導線の停止、主要リンク切れ、JavaScript エラー
 *   medium   … 表示崩れ、画像欠損
 *   low      … 誤字脱字、表記揺れ、軽微な画像差分
 */
import type { TestInfo } from '@playwright/test';
import { applyKnownIssue } from './known-issues';
import { maskFinding, maskUrl } from './secrets';
import type { Finding, FindingCategory, FindingInput, QaConfig, Severity } from './types';

export type { FindingInput };

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** カテゴリごとの既定の重大度 */
export const DEFAULT_SEVERITY: Record<FindingCategory, Severity> = {
  // 代理店に関する誤りは売上・信頼に直結するため Critical
  'agency-display': 'critical',
  'agency-persistence': 'critical',
  'agency-handoff': 'critical',
  'agency-redirect': 'critical',
  // 仕様と異なる遷移方式は「警告」として報告する (CI は失敗させない)
  'redirect-mechanism': 'medium',
  security: 'critical',
  'js-error': 'high',
  'broken-link': 'high',
  timeout: 'high',
  // リダイレクトループは Critical
  'redirect-loop': 'critical',
  'network-error': 'high',
  layout: 'medium',
  'horizontal-scroll': 'medium',
  'image-error': 'medium',
  'visual-diff': 'low',
  'text-rule': 'low',
  config: 'high',
};

/** 検査の実行文脈 (レポートの列になる) */
export interface FindingContext {
  environment: string;
  environmentLabel: string;
  baseUrl: string;
  browserId: string;
  deviceId: string;
  deviceLabel: string;
  pageId?: string;
  pageName?: string;
  agencyCode?: string;
  url?: string;
}

/** テスト 1 件ぶんの検知結果を集約する */
export class FindingCollector {
  private readonly items: Finding[] = [];

  constructor(
    private readonly config: QaConfig,
    private context: FindingContext,
  ) {}

  /** 検査対象 (ページ・代理店コード・URL) を切り替える */
  setContext(patch: Partial<FindingContext>): void {
    this.context = { ...this.context, ...patch };
  }

  get currentContext(): FindingContext {
    return { ...this.context };
  }

  add(input: FindingInput): Finding {
    const raw: Finding = {
      ...input,
      severity: input.severity ?? DEFAULT_SEVERITY[input.category],
      url: input.url ?? this.context.url ?? this.context.baseUrl,
      pageId: input.pageId ?? this.context.pageId,
      pageName: input.pageName ?? this.context.pageName,
      deviceId: input.deviceId ?? this.context.deviceId,
      browserId: input.browserId ?? this.context.browserId,
      agencyCode: input.agencyCode ?? this.context.agencyCode,
    };
    // 既知の不具合 (修正リリース待ち) は Low に落とす。
    // 期待結果は仕様どおりのままにしているため、修正日を過ぎれば
    // 元の重大度で報告され、直っていないことが分かる。
    const adjusted = applyKnownIssue(raw, this.config);
    // 一時トークン・セッション ID などの秘密情報はレポートに出力しない
    const finding = maskFinding(adjusted, this.config);
    this.items.push(finding);
    return finding;
  }

  addAll(inputs: FindingInput[]): void {
    for (const input of inputs) this.add(input);
  }

  get all(): Finding[] {
    return [...this.items];
  }

  /** CI を失敗させる重大度の検知結果 */
  get blocking(): Finding[] {
    const failOn = new Set(this.config.runtime.failOnSeverities);
    return this.items.filter((finding) => failOn.has(finding.severity));
  }

  /** レポート生成用に結果を添付し、重大度ゲートを適用する */
  async flush(testInfo: TestInfo): Promise<void> {
    const payload = {
      // 検査文脈の URL も出力前にマスクする。
      // 個人情報や一時トークンが URL に付いていた場合、
      // それ自体は検知結果として報告するが値はレポートへ出力しない。
      context: { ...this.context, url: this.context.url ? maskUrl(this.context.url, this.config) : this.context.url },
      environment: this.config.environmentName,
      environmentLabel: this.config.environment.label,
      baseUrl: this.config.environment.baseUrl,
      findings: this.items,
    };
    await testInfo.attach('qa-findings', {
      body: JSON.stringify(payload, null, 2),
      contentType: 'application/json',
    });

    const blocking = this.blocking;
    if (blocking.length > 0) {
      throw new Error(formatFindings(blocking));
    }
  }
}

/** 失敗メッセージ用の整形 */
export function formatFindings(findings: Finding[]): string {
  const lines = findings.map((finding, index) => {
    const parts = [
      `${index + 1}) [${SEVERITY_LABEL[finding.severity]}][${finding.category}] ${finding.title}`,
      finding.expected !== undefined ? `   期待: ${finding.expected}` : null,
      finding.actual !== undefined ? `   実際: ${finding.actual}` : null,
      finding.detail ? `   詳細: ${finding.detail}` : null,
      `   URL : ${finding.url}`,
    ].filter(Boolean);
    return parts.join('\n');
  });
  return `${findings.length} 件の不具合を検知しました:\n${lines.join('\n')}`;
}

/** 重大度の重い順に並べる */
export function sortBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}
