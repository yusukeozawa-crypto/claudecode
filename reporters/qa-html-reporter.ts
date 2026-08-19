/**
 * QA レポート生成 (HTML + JSON)。
 *
 * 各テストが添付した qa-findings をまとめ、以下を確認できる HTML を出力する:
 *   実行日時 / 対象環境 / ページ / PC・SP / 代理店コード / 成功・失敗 /
 *   エラー内容 / 期待結果 / 実際の結果 / スクリーンショット / 再現に使用した URL
 *
 * Critical または High が 1 件でもあれば、終了コードを 1 にして CI を失敗させる。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  FullConfig, FullResult, Reporter, TestCase, TestResult,
} from '@playwright/test/reporter';
import { SEVERITY_LABEL, SEVERITY_ORDER, sortBySeverity } from '../utils/findings';
import { loadConfig, PROJECT_ROOT } from '../utils/config';
import type { Finding, QaRecord, Severity } from '../utils/types';

const REPORT_DIR = path.join(PROJECT_ROOT, 'reports');
const HTML_PATH = path.join(REPORT_DIR, 'qa-report.html');
const JSON_PATH = path.join(REPORT_DIR, 'qa-report.json');

interface FindingsAttachment {
  context: {
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
  };
  findings: Finding[];
}

export default class QaHtmlReporter implements Reporter {
  private readonly records: QaRecord[] = [];
  private startedAt = new Date();
  private environmentLabel = '';
  private environmentName = '';
  private baseUrl = '';
  private projectNames: string[] = [];
  /** ゲートの判定基準 (config/runtime.yml の failOnSeverities) */
  private failOnSeverities: Severity[] = ['critical', 'high'];

  onBegin(config: FullConfig): void {
    this.startedAt = new Date();
    this.projectNames = config.projects.map((project) => project.name);
    try {
      const qaConfig = loadConfig();
      this.environmentName = qaConfig.environmentName;
      this.environmentLabel = qaConfig.environment.label;
      this.baseUrl = qaConfig.environment.baseUrl;
      this.failOnSeverities = qaConfig.runtime.failOnSeverities;
    } catch {
      // 設定読み込みに失敗した場合もレポート生成自体は継続する
    }
  }

  onTestEnd(testCase: TestCase, result: TestResult): void {
    // リトライされたテストは最後の試行だけを採用する。
    // 全試行を積むと、失敗 → リトライ成功 のテストで失敗時の検知が残り、
    // 成功しているのにゲートが失敗する。
    const existingIndex = this.records.findIndex((entry) => entry.testId === testCase.id);
    if (existingIndex >= 0) this.records.splice(existingIndex, 1);

    const attachment = result.attachments.find((entry) => entry.name === 'qa-findings');
    let parsed: FindingsAttachment | null = null;

    if (attachment?.body) {
      try {
        parsed = JSON.parse(attachment.body.toString('utf8')) as FindingsAttachment;
      } catch {
        parsed = null;
      }
    }

    const metadata = (testCase.parent.project()?.metadata ?? {}) as {
      browserId?: string;
      deviceId?: string;
      deviceLabel?: string;
    };

    const screenshots = result.attachments
      .filter((entry) => entry.contentType === 'image/png' && entry.path)
      .map((entry) => path.relative(REPORT_DIR, entry.path as string));

    this.records.push({
      testId: testCase.id,
      testTitle: testCase.title,
      suite: testCase.parent.titlePath().filter(Boolean).join(' > '),
      environment: parsed?.context.environment ?? this.environmentName,
      environmentLabel: parsed?.context.environmentLabel ?? this.environmentLabel,
      baseUrl: parsed?.context.baseUrl ?? this.baseUrl,
      browserId: parsed?.context.browserId ?? metadata.browserId ?? '-',
      deviceId: parsed?.context.deviceId ?? metadata.deviceId ?? '-',
      deviceLabel: parsed?.context.deviceLabel ?? metadata.deviceLabel ?? '-',
      pageId: parsed?.context.pageId,
      pageName: parsed?.context.pageName,
      agencyCode: parsed?.context.agencyCode,
      url: parsed?.context.url,
      status: result.status,
      durationMs: result.duration,
      startedAt: result.startTime.toISOString(),
      findings: parsed?.findings ?? [],
      errorMessage: result.error?.message,
      attachedScreenshots: screenshots,
    });
  }

  async onEnd(result: FullResult): Promise<void> {
    fs.mkdirSync(REPORT_DIR, { recursive: true });

    const allFindings = this.records.flatMap((record) => record.findings);
    const counts = countBySeverity(allFindings);
    const summary = {
      generatedAt: new Date().toISOString(),
      startedAt: this.startedAt.toISOString(),
      durationMs: Date.now() - this.startedAt.getTime(),
      environment: this.environmentName,
      environmentLabel: this.environmentLabel,
      baseUrl: this.baseUrl,
      projects: this.projectNames,
      playwrightStatus: result.status,
      tests: {
        total: this.records.length,
        passed: this.records.filter((record) => record.status === 'passed').length,
        failed: this.records.filter((record) => record.status === 'failed' || record.status === 'timedOut').length,
        skipped: this.records.filter((record) => record.status === 'skipped').length,
      },
      findings: counts,
      // 判定基準は config/runtime.yml の failOnSeverities に従う。
      // ここで固定値を持つと、設定を変えたときにテスト側の判定とずれる。
      failOnSeverities: this.failOnSeverities,
      gateFailed: this.failOnSeverities.some((severity) => (counts[severity] ?? 0) > 0),
    };

    fs.writeFileSync(JSON_PATH, JSON.stringify({ summary, records: this.records }, null, 2), 'utf8');
    fs.writeFileSync(HTML_PATH, renderHtml(summary, this.records), 'utf8');

    const relativeHtml = path.relative(PROJECT_ROOT, HTML_PATH);
    console.log('');
    console.log('==================== QA レポート ====================');
    console.log(`対象環境      : ${summary.environmentLabel || '-'} (${summary.environment || '-'}) ${summary.baseUrl}`);
    console.log(`テスト        : 合計 ${summary.tests.total} / 成功 ${summary.tests.passed} / 失敗 ${summary.tests.failed} / スキップ ${summary.tests.skipped}`);
    console.log(`検知件数      : Critical ${counts.critical} / High ${counts.high} / Medium ${counts.medium} / Low ${counts.low}`);
    console.log(`HTML レポート : ${relativeHtml}`);
    console.log(`JSON          : ${path.relative(PROJECT_ROOT, JSON_PATH)}`);
    console.log(
      `判定基準      : ${this.failOnSeverities.map((severity) => severity.toUpperCase()).join(' / ')} を 1 件でも検知したら失敗`,
    );
    if (summary.gateFailed) {
      console.log('判定          : 判定基準に該当する不具合を検知したため CI は失敗として終了します');
    }
    console.log('====================================================');
  }

  /** Critical / High があれば終了コードを 1 にする */
  async onExit(): Promise<void> {
    const counts = countBySeverity(this.records.flatMap((record) => record.findings));
    if (counts.critical > 0 || counts.high > 0) {
      process.exitCode = 1;
    }
  }
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface ReportSummary {
  generatedAt: string;
  startedAt: string;
  durationMs: number;
  environment: string;
  environmentLabel: string;
  baseUrl: string;
  projects: string[];
  tests: { total: number; passed: number; failed: number; skipped: number };
  findings: Record<Severity, number>;
  gateFailed: boolean;
}

function statusLabel(status: QaRecord['status']): string {
  switch (status) {
    case 'passed':
      return '成功';
    case 'failed':
      return '失敗';
    case 'timedOut':
      return 'タイムアウト';
    case 'skipped':
      return 'スキップ';
    default:
      return status;
  }
}

function renderHtml(summary: ReportSummary, records: QaRecord[]): string {
  const findings = sortBySeverity(records.flatMap((record) => record.findings));

  const findingRows = findings
    .map((finding) => {
      const record = records.find((entry) => entry.findings.includes(finding));
      // 検知結果に紐づく画像 (視覚差分の 3 枚など) を優先し、
      // 無い場合はテストに添付されたスクリーンショットを表示する
      const shotPaths =
        (finding.screenshots ?? []).length > 0
          ? (finding.screenshots ?? [])
          : (record?.attachedScreenshots ?? []);
      const shotLabel = (shot: string): string => {
        if (shot.includes('-expected.')) return '基準画像';
        if (shot.includes('-actual.')) return '現在画像';
        if (shot.includes('-diff.')) return '差分画像';
        return 'スクリーンショット';
      };
      const shots = shotPaths
        .map(
          (shot) =>
            `<a class="shot" href="${escapeHtml(shot)}" target="_blank" rel="noopener" title="${escapeHtml(shotLabel(shot))}"><img src="${escapeHtml(shot)}" alt="${escapeHtml(shotLabel(shot))}" loading="lazy"><span class="shot-label">${escapeHtml(shotLabel(shot))}</span></a>`,
        )
        .join('');
      return `
      <tr class="sev-${finding.severity}" data-severity="${finding.severity}" data-device="${escapeHtml(finding.deviceId)}" data-page="${escapeHtml(finding.pageId ?? '')}">
        <td><span class="badge badge-${finding.severity}">${SEVERITY_LABEL[finding.severity]}</span></td>
        <td>${escapeHtml(finding.category)}</td>
        <td>${escapeHtml(finding.pageName ?? finding.pageId ?? '-')}</td>
        <td>${escapeHtml(finding.deviceId?.toUpperCase() ?? '-')}<br><span class="muted">${escapeHtml(finding.browserId ?? '')}</span></td>
        <td>${escapeHtml(finding.agencyCode ?? '-')}</td>
        <td>
          <div class="title">${escapeHtml(finding.title)}</div>
          ${finding.detail ? `<div class="muted">${escapeHtml(finding.detail)}</div>` : ''}
        </td>
        <td class="expected">${escapeHtml(finding.expected ?? '-')}</td>
        <td class="actual">${escapeHtml(finding.actual ?? '-')}</td>
        <td class="url"><a href="${escapeHtml(finding.url)}" target="_blank" rel="noopener">${escapeHtml(finding.url)}</a></td>
        <td class="shots">${shots}</td>
      </tr>`;
    })
    .join('');

  const testRows = records
    .map(
      (record) => `
      <tr class="status-${record.status}">
        <td><span class="badge badge-${record.status === 'passed' ? 'pass' : record.status === 'skipped' ? 'skip' : 'fail'}">${statusLabel(record.status)}</span></td>
        <td>${escapeHtml(record.suite)}<div class="title">${escapeHtml(record.testTitle)}</div></td>
        <td>${escapeHtml(record.pageName ?? '-')}</td>
        <td>${escapeHtml(record.deviceId.toUpperCase())}<br><span class="muted">${escapeHtml(record.browserId)}</span></td>
        <td>${escapeHtml(record.agencyCode ?? '-')}</td>
        <td>${record.findings.length}</td>
        <td>${Math.round(record.durationMs)} ms</td>
        <td class="url">${record.url ? `<a href="${escapeHtml(record.url)}" target="_blank" rel="noopener">${escapeHtml(record.url)}</a>` : '-'}</td>
      </tr>`,
    )
    .join('');

  const severityCards = SEVERITY_ORDER.map(
    (severity) => `
      <div class="card card-${severity}">
        <div class="card-value">${summary.findings[severity]}</div>
        <div class="card-label">${SEVERITY_LABEL[severity]}</div>
      </div>`,
  ).join('');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>公開後QAレポート - ${escapeHtml(summary.environmentLabel)}</title>
<style>
  :root {
    --critical: #b3261e; --high: #d97706; --medium: #2563eb; --low: #6b7280;
    --bg: #f7f8fa; --panel: #ffffff; --border: #e2e5ea; --text: #1f2328;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { background: #12243a; color: #fff; padding: 20px 24px; }
  header h1 { margin: 0 0 8px; font-size: 20px; }
  header dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; font-size: 13px; }
  header dt { color: #9fb3c8; }
  main { padding: 20px 24px 60px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 20px; min-width: 110px; }
  .card-value { font-size: 26px; font-weight: 700; }
  .card-critical .card-value { color: var(--critical); }
  .card-high .card-value { color: var(--high); }
  .card-medium .card-value { color: var(--medium); }
  .card-low .card-value { color: var(--low); }
  .card-label { font-size: 12px; color: #5a6672; }
  .gate { margin: 12px 0 20px; padding: 12px 16px; border-radius: 8px; font-weight: 700; }
  .gate-fail { background: #fdecea; border: 1px solid #f3b7b2; color: var(--critical); }
  .gate-pass { background: #e9f7ef; border: 1px solid #b7e0c4; color: #14683a; }
  h2 { font-size: 16px; margin: 28px 0 10px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f0f2f5; position: sticky; top: 0; white-space: nowrap; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; color: #fff; font-size: 11px; font-weight: 700; white-space: nowrap; }
  .badge-critical { background: var(--critical); } .badge-high { background: var(--high); }
  .badge-medium { background: var(--medium); } .badge-low { background: var(--low); }
  .badge-pass { background: #14683a; } .badge-fail { background: var(--critical); } .badge-skip { background: #9aa4af; }
  .muted { color: #6b7280; font-size: 12px; }
  .title { font-weight: 600; }
  .expected { color: #14683a; } .actual { color: var(--critical); }
  .url { word-break: break-all; max-width: 260px; font-size: 12px; }
  .shots { white-space: nowrap; }
  .shot { display: inline-block; margin-right: 6px; text-align: center; text-decoration: none; color: #5a6671; }
  .shot img { height: 56px; border: 1px solid var(--border); border-radius: 4px; display: block; }
  .shot-label { display: block; font-size: 10px; margin-top: 2px; }
  .filters { margin: 10px 0; font-size: 13px; }
  .filters label { margin-right: 12px; }
  .empty { padding: 20px; color: #5a6672; }
  footer { padding: 20px 24px; color: #6b7280; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Webサイト公開後 自動QAレポート</h1>
  <dl>
    <dt>実行日時</dt><dd>${escapeHtml(new Date(summary.startedAt).toLocaleString('ja-JP'))} (所要 ${Math.round(summary.durationMs / 1000)} 秒)</dd>
    <dt>対象環境</dt><dd>${escapeHtml(summary.environmentLabel)} (${escapeHtml(summary.environment)})</dd>
    <dt>対象URL</dt><dd>${escapeHtml(summary.baseUrl)}</dd>
    <dt>実行構成</dt><dd>${escapeHtml(summary.projects.join(', '))}</dd>
    <dt>テスト結果</dt><dd>合計 ${summary.tests.total} / 成功 ${summary.tests.passed} / 失敗 ${summary.tests.failed} / スキップ ${summary.tests.skipped}</dd>
  </dl>
</header>
<main>
  <div class="cards">${severityCards}</div>
  <div class="gate ${summary.gateFailed ? 'gate-fail' : 'gate-pass'}">
    ${summary.gateFailed
      ? 'Critical / High を検知しました。CI は失敗として終了します。'
      : 'Critical / High の検知はありません。CI は成功として終了します。'}
  </div>

  <h2>検知した不具合 (${findings.length} 件)</h2>
  <div class="filters">
    表示する重大度:
    ${SEVERITY_ORDER.map(
      (severity) =>
        `<label><input type="checkbox" checked data-filter="${severity}"> ${SEVERITY_LABEL[severity]}</label>`,
    ).join('')}
  </div>
  <div class="panel">
    ${
      findings.length === 0
        ? '<p class="empty">検知した不具合はありません。</p>'
        : `<table id="findings">
      <thead><tr>
        <th>重大度</th><th>種別</th><th>ページ</th><th>PC/SP</th><th>代理店コード</th>
        <th>エラー内容</th><th>期待結果</th><th>実際の結果</th><th>再現URL</th><th>スクリーンショット</th>
      </tr></thead>
      <tbody>${findingRows}</tbody>
    </table>`
    }
  </div>

  <h2>テスト実行一覧</h2>
  <div class="panel">
    <table>
      <thead><tr>
        <th>結果</th><th>テスト</th><th>ページ</th><th>PC/SP</th><th>代理店コード</th><th>検知件数</th><th>所要</th><th>再現URL</th>
      </tr></thead>
      <tbody>${testRows}</tbody>
    </table>
  </div>
</main>
<footer>
  Playwright の詳細レポート: <a href="playwright-report/index.html">playwright-report/index.html</a>
  ｜ 生成日時 ${escapeHtml(new Date(summary.generatedAt).toLocaleString('ja-JP'))}
</footer>
<script>
  document.querySelectorAll('[data-filter]').forEach(function (input) {
    input.addEventListener('change', function () {
      var severity = input.getAttribute('data-filter');
      document.querySelectorAll('#findings tbody tr[data-severity="' + severity + '"]').forEach(function (row) {
        row.style.display = input.checked ? '' : 'none';
      });
    });
  });
</script>
</body>
</html>
`;
}
