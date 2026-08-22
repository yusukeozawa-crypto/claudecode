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
  FullConfig, FullResult, Reporter, Suite, TestCase, TestResult,
} from '@playwright/test/reporter';
import { SEVERITY_LABEL, SEVERITY_ORDER, sortBySeverity } from '../utils/findings';
import { loadConfig, PROJECT_ROOT } from '../utils/config';
import { agencySeed, agencySpecs } from '../utils/agency';
import { activeKnownIssues } from '../utils/known-issues';
import { buildChecklist } from '../utils/checklist';
import type { AgencyMeta, Checklist } from '../utils/checklist';
import { maskText } from '../utils/secrets';
import type { Finding, QaConfig, QaRecord, Severity } from '../utils/types';

const REPORT_DIR = path.join(PROJECT_ROOT, 'reports');
const HTML_PATH = path.join(REPORT_DIR, 'qa-report.html');
const JSON_PATH = path.join(REPORT_DIR, 'qa-report.json');
/** 進行状況 (ブラウザ UI が読む)。検査中に 1 テストごとに更新する */
const PROGRESS_PATH = path.join(REPORT_DIR, 'progress.json');
/** 過去の実行結果 (ブラウザ UI の履歴) */
const HISTORY_DIR = path.join(REPORT_DIR, 'history');

/**
 * テストを人が分かる単位にまとめる。
 * 「いま何を確認しているか」を検査中に見せるため。
 */
const GROUPS: Array<{ label: string; match: RegExp }> = [
  { label: '代理店の表示', match: /@consistency|agency-display|agency-cta/ },
  { label: 'リダイレクト', match: /@redirect/ },
  { label: '申込への引き継ぎ', match: /@handoff/ },
  { label: 'ページの表示・エラー', match: /@crawl|@health/ },
  { label: 'セキュリティ', match: /@security/ },
  { label: '文言', match: /@text/ },
  { label: '見た目の比較', match: /@visual/ },
  { label: '検出ロジックの自己検査', match: /@selfcheck/ },
  { label: '仕様調査', match: /@discover/ },
];

function groupLabel(testCase: TestCase): string {
  const key = `${testCase.titlePath().join(' ')} ${testCase.location.file}`;
  return GROUPS.find((group) => group.match.test(key))?.label ?? 'その他';
}

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
  /** マスキングに使う設定 (読み込みに失敗した場合は null) */
  private qaConfig: QaConfig | null = null;

  /** 進行状況 (ブラウザ UI 用) */
  private plannedTotal = 0;
  private completed = 0;
  private readonly groupProgress = new Map<string, { done: number; total: number }>();
  private currentLabel = '';

  onBegin(config: FullConfig, suite: Suite): void {
    this.startedAt = new Date();
    this.projectNames = config.projects.map((project) => project.name);
    const tests = suite.allTests();
    this.plannedTotal = tests.length;
    for (const testCase of tests) {
      const label = groupLabel(testCase);
      const entry = this.groupProgress.get(label) ?? { done: 0, total: 0 };
      entry.total += 1;
      this.groupProgress.set(label, entry);
    }
    try {
      const qaConfig = loadConfig();
      this.qaConfig = qaConfig;
      this.environmentName = qaConfig.environmentName;
      this.environmentLabel = qaConfig.environment.label;
      this.baseUrl = qaConfig.environment.baseUrl;
      this.failOnSeverities = qaConfig.runtime.failOnSeverities;
    } catch {
      // 設定読み込みに失敗した場合もレポート生成自体は継続する
    }
    this.writeProgress(true);
  }

  /**
   * 進行状況をファイルに書く。ブラウザ UI がこれを読んで表示する。
   * 書き込み失敗で検査を止めないよう、例外は無視する。
   */
  private writeProgress(running: boolean): void {
    try {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const counts = countBySeverity(this.records.flatMap((record) => record.findings));
      fs.writeFileSync(
        PROGRESS_PATH,
        JSON.stringify(
          {
            running,
            environment: this.environmentName,
            environmentLabel: this.environmentLabel,
            startedAt: this.startedAt.toISOString(),
            updatedAt: new Date().toISOString(),
            total: this.plannedTotal,
            completed: this.completed,
            current: this.currentLabel,
            findings: counts,
            groups: [...this.groupProgress.entries()].map(([label, entry]) => ({
              label,
              done: entry.done,
              total: entry.total,
            })),
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      // 進行状況の書き込み失敗は検査結果に影響しない
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
      // Playwright のエラーメッセージには遷移先 URL がそのまま含まれる
      // (トークン・個人情報を含み得る) ため、保存前にマスクする
      errorMessage: this.qaConfig
        ? maskText(result.error?.message, this.qaConfig)
        : result.error?.message,
      attachedScreenshots: screenshots,
    });

    // 進行状況の更新 (ブラウザ UI 用)
    this.completed += 1;
    this.currentLabel = groupLabel(testCase);
    const group = this.groupProgress.get(this.currentLabel);
    if (group) group.done += 1;
    this.writeProgress(true);
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
      agencySampling: describeAgencySampling(),
      // コードだけでは人が判断できないため、会社名と みらやく掲載可否を持たせる
      agencyMeta: describeAgencyMeta(),
      // 代理店 × 検査項目のチェックリスト。
      // ブラウザ画面もこの値をそのまま表示する (同じ計算を 2 か所に持たない)
      checklist: buildChecklist(this.records, describeAgencyMeta(), allPatternLabels()),
      // 判定基準は config/runtime.yml の failOnSeverities に従う。
      // ここで固定値を持つと、設定を変えたときにテスト側の判定とずれる。
      failOnSeverities: this.failOnSeverities,
      gateFailed: this.failOnSeverities.some((severity) => (counts[severity] ?? 0) > 0),
    };

    fs.writeFileSync(JSON_PATH, JSON.stringify({ summary, records: this.records }, null, 2), 'utf8');
    this.writeProgress(false);
    this.saveHistory(summary);
    fs.writeFileSync(HTML_PATH, renderHtml(summary, this.records), 'utf8');

    const relativeHtml = path.relative(PROJECT_ROOT, HTML_PATH);
    console.log('');
    console.log('==================== QA レポート ====================');
    console.log(`対象環境      : ${summary.environmentLabel || '-'} (${summary.environment || '-'}) ${summary.baseUrl}`);
    console.log(`テスト        : 合計 ${summary.tests.total} / 成功 ${summary.tests.passed} / 失敗 ${summary.tests.failed} / スキップ ${summary.tests.skipped}`);
    if (summary.agencySampling) {
      const { seed, scope, selected, total } = summary.agencySampling;
      console.log(
        `代理店        : ${selected} / ${total} 件 (${scope === 'all' ? '全件' : '抽選'})` +
          (scope === 'all' ? '' : `  再現用: QA_AGENCY_SEED=${seed}`),
      );
    }
    console.log(`検知件数      : Critical ${counts.critical} / High ${counts.high} / Medium ${counts.medium} / Low ${counts.low}`);
    // 既知の不具合は Low に落としているため、何を既知として扱ったかを明示する
    // (黙って下げると「検知されていない」と誤解されるため)
    for (const issue of describeKnownIssues()) {
      console.log(`既知の不具合  : ${issue}`);
    }
    console.log(`HTML レポート : ${relativeHtml}`);
    console.log(`JSON          : ${path.relative(PROJECT_ROOT, JSON_PATH)}`);
    console.log(
      `判定基準      : ${this.failOnSeverities.map((severity) => severity.toUpperCase()).join(' / ')} を 1 件でも検知したら失敗`,
    );
    if (summary.gateFailed) {
      console.log('判定          : 判定基準に該当する不具合を検知したため CI は失敗として終了します');
    }
    console.log('====================================================');

    // 対応が必要な検知内容をその場に出す。
    // HTML を開かないと何が起きたか分からない状態だと、
    // 「失敗したことは分かるが原因が分からない」で止まってしまう。
    this.printAttentionFindings(allFindings);
  }

  /**
   * 実行結果を履歴として残す (ブラウザ UI の一覧用)。
   * 全文ではなく要約だけを保存する (件数が増えても軽いままにするため)。
   */
  private saveHistory(summary: ReportSummary): void {
    try {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      const stamp = summary.startedAt.replace(/[:.]/g, '-');
      fs.writeFileSync(
        path.join(HISTORY_DIR, `${stamp}-${summary.environment || 'unknown'}.json`),
        JSON.stringify(summary, null, 2),
        'utf8',
      );
      // 古い履歴は 50 件で打ち切る (フォルダが無限に増えないように)
      const files = fs
        .readdirSync(HISTORY_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort();
      for (const name of files.slice(0, Math.max(0, files.length - 50))) {
        fs.rmSync(path.join(HISTORY_DIR, name), { force: true });
      }
    } catch {
      // 履歴の保存失敗は検査結果に影響しない
    }
  }

  /**
   * 対応が必要な検知内容をコンソールに出す。
   *
   * 同じ内容が代理店・端末ごとに何十件も並ぶため、内容単位でまとめる。
   * 全件は npm run findings で見られる。
   */
  private printAttentionFindings(findings: Finding[]): void {
    const attention = findings.filter((finding) => this.failOnSeverities.includes(finding.severity));
    if (attention.length === 0) return;

    const groups = new Map<string, { finding: Finding; items: Finding[] }>();
    for (const finding of sortBySeverity(attention)) {
      const key = [finding.severity, finding.category, finding.title, finding.expected, finding.actual].join(' | ');
      const group = groups.get(key);
      if (group) group.items.push(finding);
      else groups.set(key, { finding, items: [finding] });
    }

    const MAX_GROUPS = 8;
    console.log('');
    console.log(`---------- 対応が必要な検知 (${groups.size} 種類 / 延べ ${attention.length} 件) ----------`);
    let index = 0;
    for (const { finding, items } of groups.values()) {
      index += 1;
      if (index > MAX_GROUPS) {
        console.log('');
        console.log(`... 他 ${groups.size - MAX_GROUPS} 種類。すべて見るには: npm run findings`);
        break;
      }
      const devices = [...new Set(items.map((item) => item.deviceId).filter(Boolean))];
      const codes = [...new Set(items.map((item) => item.agencyCode).filter(Boolean))];
      console.log('');
      console.log(`[${SEVERITY_LABEL[finding.severity]}] ${finding.title}`);
      console.log(`  期待   : ${finding.expected ?? '-'}`);
      console.log(`  実際   : ${finding.actual ?? '-'}`);
      if (finding.detail) console.log(`  詳細   : ${finding.detail}`);
      if (devices.length > 0) console.log(`  端末   : ${devices.join(', ')}`);
      if (codes.length > 0) {
        const shown = codes.slice(0, 5).join(', ');
        console.log(`  代理店 : ${shown}${codes.length > 5 ? ` ...他 ${codes.length - 5} 件` : ''}`);
      }
      console.log(`  件数   : ${items.length}`);
      console.log(`  再現URL: ${finding.url}`);
    }
    console.log('');
    console.log('--------------------------------------------------------');
    console.log('詳しく見る: npm run findings   画面で見る: reports/qa-report.html');
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
  /** 代理店の抽選シードと対象件数 (同じ組み合わせを再現するために記録する) */
  agencySampling: { seed: string; scope: string; selected: number; total: number } | null;
  agencyMeta: Record<string, AgencyMeta>;
  /** 代理店 × 検査項目のチェックリスト */
  checklist?: Checklist;
  findings: Record<Severity, number>;
  gateFailed: boolean;
}

/**
 * 代理店の抽選内容。
 * 抽選は実行ごとに変わるため、レポートにシードを残さないと
 * 「どの代理店を検査したのか」「同じ組み合わせをどう再現するか」が分からなくなる。
 */
/**
 * いま既知として扱っている不具合の説明。
 * 設定が読めない場合 (実行環境の設定不備) は何も出さない。
 */
function describeKnownIssues(): string[] {
  try {
    const config = loadConfig();
    return activeKnownIssues(config).map(
      (issue) =>
        `${issue.title} (${issue.id})` +
        (issue.fixedOn ? ` — ${issue.fixedOn} 修正予定まで Low として扱う` : ' — Low として扱う'),
    );
  } catch {
    return [];
  }
}

/**
 * 代理店コード → 会社名 / みらいの約束 (みらやく) 掲載可否。
 * レポートと画面の一覧表に出すため。無効コードは「検査用」と示す。
 */
function describeAgencyMeta(): Record<string, AgencyMeta> {
  const meta: Record<string, AgencyMeta> = {};
  try {
    const config = loadConfig();
    for (const agency of config.agencies.agencies) {
      meta[agency.code] = {
        company: agency.company ?? agency.label ?? '',
        mirayaku: agency.mirayaku ?? '',
        agency: true,
        // 表の 1 列目に出すパターン名 (ダイレクト / カカクコム / みらやく○ など)
        pattern: agency.patternLabel ?? agency.profile ?? '',
        // 支店コードのように「先のリリースで反映される」期待結果は日付を添える
        effectiveFrom: agency.effectiveFrom ?? null,
      };
    }
    for (const invalid of config.agencies.invalidCodes ?? []) {
      // agency: false = 実在しない検査用のコード。チェックリストの行にはしない
      meta[invalid.code] = { company: `無効コードの検査用 (${invalid.label})`, mirayaku: '-', agency: false };
    }
  } catch {
    // 設定が読めない場合は空のまま (表にはコードだけ出る)
  }
  return meta;
}

/**
 * 期待結果を用意しているパターン名の一覧。
 * 今回検査されなかったパターンを表に示すために使う
 * (「代理店が無い」のか「抽選から漏れた」のかを人が判断できるように)。
 */
function allPatternLabels(): string[] {
  try {
    const config = loadConfig();
    const labels = new Set<string>();
    for (const agency of config.agencies.agencies) {
      if (agency.patternLabel) labels.add(agency.patternLabel);
    }
    return [...labels];
  } catch {
    return [];
  }
}

function describeAgencySampling(): ReportSummary['agencySampling'] {
  try {
    const config = loadConfig();
    const total = config.agencies.agencies.length;
    const selected = agencySpecs(config).length;
    const scope = selected === total ? 'all' : 'sample';
    return { seed: agencySeed(), scope, selected, total };
  } catch {
    // 設定が読めない場合はレポートを壊さない
    return null;
  }
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

/** 代理店コードごとの結果 1 行 */
interface AgencyRow {
  code: string;
  /** 観点ごとの最悪の重大度 (無ければ null = 問題なし) */
  cells: Record<string, Severity | null>;
  /** 観点ごとの件数 */
  counts: Record<string, number>;
  worst: Severity | null;
  checked: boolean;
}

/** 代理店一覧表の列。種別をまとめて「何の観点か」で並べる */
const AGENCY_COLUMNS: Array<{ key: string; label: string; categories: string[] }> = [
  { key: 'display', label: '表示', categories: ['agency-display', 'text-rule', 'layout', 'horizontal-scroll', 'visual-diff'] },
  { key: 'redirect', label: 'リダイレクト', categories: ['agency-redirect', 'redirect-mechanism', 'redirect-loop'] },
  { key: 'persistence', label: 'コード保持', categories: ['agency-persistence'] },
  { key: 'handoff', label: '申込引き継ぎ', categories: ['agency-handoff'] },
  { key: 'error', label: 'エラー', categories: ['js-error', 'network-error', 'image-error', 'broken-link', 'timeout'] },
  { key: 'security', label: 'セキュリティ', categories: ['security'] },
];

/** 重大度の重い順 (null = 問題なし) */
function worseOf(a: Severity | null, b: Severity | null): Severity | null {
  if (!a) return b;
  if (!b) return a;
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

/**
 * 代理店コードごとの一覧表を組み立てる。
 *
 * 「今回どのコードを検査して、それぞれどうだったか」を 1 画面で見るため。
 * 抽選で毎回対象が変わるので、検査したコードを明示することが重要。
 */
export function buildAgencyRows(records: QaRecord[]): AgencyRow[] {
  const rows = new Map<string, AgencyRow>();
  const emptyCells = (): Record<string, Severity | null> =>
    Object.fromEntries(AGENCY_COLUMNS.map((column) => [column.key, null]));
  const emptyCounts = (): Record<string, number> =>
    Object.fromEntries(AGENCY_COLUMNS.map((column) => [column.key, 0]));

  const ensure = (code: string): AgencyRow => {
    const existing = rows.get(code);
    if (existing) return existing;
    const created: AgencyRow = { code, cells: emptyCells(), counts: emptyCounts(), worst: null, checked: true };
    rows.set(code, created);
    return created;
  };

  // 検査した代理店コード (検知が無くても行を作る = 「確認済み」を示す)
  for (const record of records) {
    const code = record.agencyCode;
    if (!code || code === 'none') continue;
    ensure(code);
  }

  for (const record of records) {
    for (const finding of record.findings) {
      const code = finding.agencyCode ?? record.agencyCode;
      if (!code || code === 'none') continue;
      const row = ensure(code);
      const column = AGENCY_COLUMNS.find((entry) => entry.categories.includes(finding.category));
      const key = column?.key ?? 'display';
      row.cells[key] = worseOf(row.cells[key], finding.severity);
      row.counts[key] += 1;
      row.worst = worseOf(row.worst, finding.severity);
    }
  }

  return [...rows.values()].sort((a, b) => {
    const order = SEVERITY_ORDER.indexOf(a.worst ?? 'low') - SEVERITY_ORDER.indexOf(b.worst ?? 'low');
    if (a.worst && b.worst && order !== 0) return order;
    if (a.worst && !b.worst) return -1;
    if (!a.worst && b.worst) return 1;
    return a.code.localeCompare(b.code);
  });
}

/**
 * チェックリスト表 (PC / SP それぞれ 1 枚)。
 *
 * 行 = 代理店、列 = 検査項目、セル = 「あり」「なし」。
 * 期待と違うセルは赤くする。
 * PC と SP を混ぜないのは、端末で挙動が違ったときに
 * どちらが悪いのか分からなくなるため。
 */
function renderChecklist(checklist: Checklist): string {
  if (checklist.tables.length === 0) {
    return '<p class="empty">代理店コードを使った検査はありませんでした。</p>';
  }

  const renderTable = (table: Checklist['tables'][number]): string => {
    const body = table.rows
      .map((row) => {
        const cells = checklist.columns
          .map((column) => {
            const cell = row.cells[column.key];
            if (!cell || cell.state === 'none') {
              return '<td class="check-none" title="この代理店では検査していません">—</td>';
            }
            if (cell.state === 'info') {
              // 正解が未確定の項目 (保存先など)。実態だけ出す
              return `<td class="check-info" title="${escapeHtml(cell.note)}">${escapeHtml(cell.observed)}</td>`;
            }
            // 何を見て判断したのかを小さく併記する
            const seen = cell.detail ? `<span class="seen">${escapeHtml(cell.detail)}</span>` : '';
            if (cell.state === 'ok') {
              return `<td class="check-ok" title="${escapeHtml(cell.note)}">${escapeHtml(cell.observed)}${seen}</td>`;
            }
            return (
              `<td class="check-ng" title="${escapeHtml(cell.note)}">${escapeHtml(cell.observed)}` +
              `<span class="muted">期待: ${escapeHtml(cell.expected ?? '')}</span>${seen}</td>`
            );
          })
          .join('');
        const pattern =
          escapeHtml(row.pattern || '-') +
          (row.effectiveFrom ? `<span class="muted">${escapeHtml(row.effectiveFrom)} 以降の想定</span>` : '');
        return (
          `<tr class="${row.failed ? 'agency-ng' : 'agency-ok'}">` +
          `<td class="pattern">${pattern}</td>` +
          `<th scope="row">${escapeHtml(row.code)}</th>` +
          `<td class="company">${escapeHtml(row.company || '-')}</td>` +
          `<td class="mirayaku">${escapeHtml(row.mirayaku || '-')}</td>` +
          `${cells}</tr>`
        );
      })
      .join('');

    return `<h3>${escapeHtml(table.deviceLabel)}</h3>
    <table class="checklist">
      <thead><tr>
        <th>パターン</th><th>代理店コード</th><th>会社名</th><th>みらやく</th>
        ${checklist.columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  };

  const missing =
    checklist.missingPatterns.length === 0
      ? ''
      : '<p class="muted">今回検査されなかったパターン: ' +
        checklist.missingPatterns
          .map((entry) => `${escapeHtml(entry.pattern)} (${escapeHtml(entry.reason)})`)
          .join(' / ') +
        '</p>';

  return checklist.tables.map(renderTable).join('') + missing;
}

function renderAgencyTable(records: QaRecord[], meta: ReportSummary['agencyMeta']): string {
  const rows = buildAgencyRows(records);
  if (rows.length === 0) return '<p class="empty">代理店コードを使った検査はありませんでした。</p>';

  const body = rows
    .map((row) => {
      const cells = AGENCY_COLUMNS.map((column) => {
        const severity = row.cells[column.key];
        const count = row.counts[column.key];
        if (!severity) return '<td class="ok">OK</td>';
        return `<td class="ng sev-${severity}"><span class="badge badge-${severity}">${SEVERITY_LABEL[severity]}</span> ${count} 件</td>`;
      }).join('');
      const info = meta[row.code] ?? { company: '', mirayaku: '' };
      return `<tr class="${row.worst ? `agency-ng sev-${row.worst}` : 'agency-ok'}">` +
        `<th scope="row">${escapeHtml(row.code)}</th>` +
        `<td class="company">${escapeHtml(info.company || '-')}</td>` +
        `<td class="mirayaku">${escapeHtml(info.mirayaku || '-')}</td>` +
        `${cells}</tr>`;
    })
    .join('');

  return `<table id="agencies">
      <thead><tr>
        <th>代理店コード</th><th>会社名</th><th>みらやく</th>
        ${AGENCY_COLUMNS.map((column) => `<th>${column.label}</th>`).join('')}
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
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
        <td><span class="badge badge-${escapeHtml(finding.severity)}">${SEVERITY_LABEL[finding.severity]}</span></td>
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
  .gate { margin: 12px 0 20px; padding: 14px 18px; border-radius: 8px; }
  .gate-title { display: block; font-size: 18px; font-weight: 700; }
  .gate-note { display: block; margin-top: 4px; font-size: 12px; opacity: 0.85; }
  .gate-fail { background: #fdecea; border: 1px solid #f3b7b2; color: var(--critical); }
  .gate-warn { background: #fff8e6; border: 1px solid #f0d79a; color: #8a5a00; }
  .gate-pass { background: #e9f7ef; border: 1px solid #b7e0c4; color: #14683a; }
  .tests-details { margin: 28px 0 0; }
  .tests-details > summary { cursor: pointer; font-size: 16px; font-weight: 700; padding: 6px 0; }
  #tests tbody tr.status-passed { display: none; }
  body.show-passed #tests tbody tr.status-passed { display: table-row; }
  #tests-empty { display: none; }
  body.no-attention #tests-empty { display: block; }
  body.no-attention.show-passed #tests-empty { display: none; }
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
  #agencies th[scope="row"] { background: #fafbfc; font-family: ui-monospace, monospace; white-space: nowrap; }
  #agencies td { text-align: center; white-space: nowrap; }
  #agencies td.company { text-align: left; white-space: normal; min-width: 180px; }
  #agencies td.mirayaku { font-weight: 700; }
  #agencies td.ok { color: #14683a; font-weight: 700; }
  #agencies tr.agency-ng th[scope="row"] { background: #fdecea; }
  table.checklist { margin-bottom: 8px; }
  table.checklist th[scope="row"] { background: #fafbfc; font-family: ui-monospace, monospace; white-space: nowrap; }
  table.checklist td { text-align: center; white-space: nowrap; }
  table.checklist th, table.checklist td { padding: 8px 6px; font-size: 13px; }
  table.checklist td.company { text-align: left; white-space: normal; min-width: 160px; }
  table.checklist td.pattern { text-align: left; white-space: nowrap; font-weight: 700; }
  table.checklist td.pattern .muted { display: block; font-weight: 400; }
  table.checklist td.mirayaku { font-weight: 700; font-size: 15px; }
  table.checklist td.check-none { color: #c3c9d0; }
  table.checklist td.check-info { color: #44505c; }
  table.checklist td.check-ng { background: #fdecea; color: #9c2f24; font-weight: 700; }
  table.checklist td.check-ng .muted { display: block; font-size: 11px; font-weight: 400; }
  table.checklist td .seen { display: block; font-size: 10px; color: #6b7280; font-weight: 400; max-width: 170px; white-space: normal; margin: 2px auto 0; }
  table.checklist tr.agency-ng th[scope="row"] { background: #fdecea; }
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
    ${
      summary.agencySampling
        ? `<dt>代理店</dt><dd>${summary.agencySampling.selected} / ${summary.agencySampling.total} 件 ${
            summary.agencySampling.scope === 'all'
              ? '(全件)'
              : `(実行ごとに抽選) — 同じ組み合わせを再現するには QA_AGENCY_SEED=${escapeHtml(summary.agencySampling.seed)}`
          }</dd>`
        : ''
    }
  </dl>
</header>
<main>
  <div class="cards">${severityCards}</div>
  <div class="gate ${summary.gateFailed ? 'gate-fail' : findings.length > 0 ? 'gate-warn' : 'gate-pass'}">
    <span class="gate-title">${
      summary.gateFailed
        ? `要対応: 至急の不具合を ${summary.findings.critical + summary.findings.high} 件検知しました`
        : findings.length > 0
          ? `至急の不具合はありません (Medium / Low が ${findings.length} 件)`
          : '異常は検知されませんでした'
    }</span>
    <span class="gate-note">${
      summary.gateFailed
        ? 'CI は失敗として終了します。下の一覧の Critical / High から対応してください。'
        : 'CI は成功として終了します。'
    }</span>
  </div>

  <h2>チェックリスト (PC / SP 別)</h2>
  <div class="panel">
    ${renderChecklist(summary.checklist ?? buildChecklist(records, summary.agencyMeta ?? {}))}
  </div>
  <p class="muted">赤いセル = 期待と違う値。— = この代理店では検査していない。「保存先」は正解が未確定のため表示のみ (赤にしません)。検査した代理店コードは実行ごとに抽選されます。</p>

  <h2>種別ごとの内訳 (${buildAgencyRows(records).length} コード)</h2>
  <div class="panel">
    ${renderAgencyTable(records, summary.agencyMeta ?? {})}
  </div>
  <p class="muted">OK = その観点で検知なし。検査した代理店コードは実行ごとに抽選されます。</p>

  <h2>検知した不具合 (${findings.length} 件)</h2>
  <div class="filters">
    表示する重大度:
    ${SEVERITY_ORDER.map((severity) => {
      // 既定は対応が必要なもの (Critical / High) だけ。
      // Medium / Low は毎回出る記録なので、件数だけ見せて既定では隠す。
      const checked = severity === 'critical' || severity === 'high';
      const count = summary.findings[severity] ?? 0;
      return `<label><input type="checkbox" ${checked ? 'checked' : ''} data-filter="${severity}"> ${SEVERITY_LABEL[severity]} (${count})</label>`;
    }).join('')}
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

  <details class="tests-details">
    <summary>テスト実行一覧 (${summary.tests.total} 件) — 原因を詳しく追うとき以外は開く必要はありません</summary>
    <div class="filters">
      <label><input type="checkbox" id="show-passed"> 成功したテストも表示する (${summary.tests.passed} 件)</label>
    </div>
    <div class="panel">
      <table id="tests">
        <thead><tr>
          <th>結果</th><th>テスト</th><th>ページ</th><th>PC/SP</th><th>代理店コード</th><th>検知件数</th><th>所要</th><th>再現URL</th>
        </tr></thead>
        <tbody>${testRows}</tbody>
      </table>
      <p class="empty" id="tests-empty">失敗・タイムアウト・スキップしたテストはありません。</p>
    </div>
  </details>
</main>
<footer>
  Playwright の詳細レポート: <a href="playwright-report/index.html">playwright-report/index.html</a>
  ｜ 生成日時 ${escapeHtml(new Date(summary.generatedAt).toLocaleString('ja-JP'))}
</footer>
<script>
  (function () {
    var attention = document.querySelectorAll('#tests tbody tr:not(.status-passed)').length;
    if (attention === 0) document.body.classList.add('no-attention');
    var toggle = document.getElementById('show-passed');
    if (toggle) {
      toggle.addEventListener('change', function () {
        document.body.classList.toggle('show-passed', toggle.checked);
      });
    }
  })();
  document.querySelectorAll('[data-filter]').forEach(function (input) {
    var apply = function () {
      var severity = input.getAttribute('data-filter');
      document.querySelectorAll('#findings tbody tr[data-severity="' + severity + '"]').forEach(function (row) {
        row.style.display = input.checked ? '' : 'none';
      });
    };
    input.addEventListener('change', apply);
    // 読み込み時にも適用する (既定で Medium / Low を隠すため)
    apply();
  });
</script>
</body>
</html>
`;
}
