/**
 * チェックリスト表 (代理店 × 検査項目)。
 *
 * このサイトで代理店コードによって変わる仕様は数が限られている。
 * 検知結果を何百件も並べるのではなく、
 *
 *   表 = PC / SP それぞれ 1 枚
 *   行 = 代理店 (パターン / コード / 会社名 / みらやく掲載可否)
 *   列 = 検査項目
 *   セル = 「あり」「なし」。期待と違えば赤くする
 *
 * にして、1 画面で「全部そろっているか」を見られるようにする。
 *
 * PC と SP を混ぜないのは、端末で挙動が違ったときに
 * どちらが悪いのか分からなくなるため。
 *
 * セルの元になるのは Finding の checkId / observedValue / expectedValue。
 * 検査は合否どちらの場合も記録を残すため、
 * 「確認して仕様どおり」と「そもそも検査していない」を区別できる。
 * 検知が無いことを合格の根拠にすると、検査が動いていないだけの状態を
 * 「問題なし」と表示してしまう。
 */
import { SEVERITY_ORDER } from './findings';
import type { CheckId, QaRecord, Severity } from './types';

/** チェックリストの列 (代理店コードで変わる仕様のみ) */
export const CHECK_COLUMNS: Array<{ key: CheckId; label: string }> = [
  { key: 'redirect', label: 'リダイレクト' },
  { key: 'header-name', label: 'ヘッダーに代理店名' },
  { key: 'footer-name', label: 'フッターに代理店名' },
  { key: 'anshin-pack', label: 'あんしんパック' },
  { key: 'code-carry', label: '申込フォームでコード保持' },
  { key: 'storage', label: '保存先' },
];

/** セル 1 つの状態 */
export interface ChecklistCell {
  /**
   * ok = 期待どおり / ng = 期待と違う / info = 正解が未確定なので判定しない /
   * none = この代理店では検査していない
   */
  state: 'ok' | 'ng' | 'info' | 'none';
  /** 実際にそうだったか ("あり" / "なし" / "Cookie" など) */
  observed: string;
  /** そうあるべきだった値。null = 正解が未確定 */
  expected: string | null;
  /** ng のときの最も重い重大度 */
  severity: Severity | null;
  /** 補足 (画面のツールチップ用) */
  note: string;
  /**
   * 実際に確認できた値 (セルに小さく併記する)。
   *
   * 「あり」だけでは、本当に見に行ったのか判断できない。
   * 確認できた会社名などをそのまま出すことで、
   * 検査が動いていることが人にも分かる。
   */
  details: string[];
}

export interface ChecklistRow {
  code: string;
  company: string;
  mirayaku: string;
  /** パターン名 (ダイレクト / カカクコム / みらやく○ など) */
  pattern: string;
  /** この期待結果が有効になる日 (支店コードなど)。null = 今から有効 */
  effectiveFrom: string | null;
  cells: Record<string, ChecklistCell>;
  /** 1 つでも期待と違うものがあるか */
  failed: boolean;
}

export interface ChecklistTable {
  /** pc / sp */
  deviceId: string;
  deviceLabel: string;
  rows: ChecklistRow[];
}

export interface Checklist {
  columns: Array<{ key: string; label: string }>;
  tables: ChecklistTable[];
  /**
   * 期待結果を用意しているのに、今回 1 件も検査対象にならなかったパターン。
   * 「代理店が存在しない」のか「抽選から漏れた」のかを人が判断できるように出す。
   */
  missingPatterns: Array<{ pattern: string; reason: string }>;
}

export interface AgencyMeta {
  company: string;
  mirayaku: string;
  agency?: boolean;
  pattern?: string;
  effectiveFrom?: string | null;
}

/**
 * セルに併記する短い説明。
 *
 * 「「募集代理店：株式会社カカクコム・インシュアランス」を確認」のような
 * 文から、確認できた値だけを取り出す。
 * 「あり」だけでは本当に見に行ったのか分からないため、
 * 何を見て判断したのかを人にも見えるようにする。
 */
function clip(text: string): string {
  const value = text.trim();
  return value.length > 34 ? `${value.slice(0, 34)}…` : value;
}

function shortDetail(actual: string): string {
  const quoted = /「([^」]{1,60})」/.exec(actual);
  const text = (quoted ? quoted[1] : actual).trim();
  return text.length > 26 ? `${text.slice(0, 26)}…` : text;
}

function worseOf(a: Severity | null, b: Severity | null): Severity | null {
  if (!a) return b;
  if (!b) return a;
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

const DEVICE_LABEL: Record<string, string> = { pc: 'PC', sp: 'スマートフォン' };

/**
 * 検知結果からチェックリストを組み立てる。
 *
 * meta は代理店コード → 会社名 / みらやく掲載可否 / パターン名。
 * コードだけでは人が「どの会社か」を判断できないため必須。
 * allPatterns には期待結果を用意しているパターン名をすべて渡す
 * (今回検査されなかったパターンを missingPatterns として示すため)。
 */
export function buildChecklist(
  records: QaRecord[],
  meta: Record<string, AgencyMeta> = {},
  allPatterns: string[] = [],
  patternOrder: string[] = [],
  /**
   * 設定が足りないために検査できなかった項目。
   *   検査していない「ー」と、設定漏れで検査できていない状態は別物。
   *   同じ「ー」に見えると、設定漏れに何日も気づけない。
   */
  unconfigured: Array<{ checkId: string; reason: string }> = [],
): Checklist {
  // device → code → row
  const tables = new Map<string, Map<string, ChecklistRow>>();
  const unconfiguredBy = new Map(unconfigured.map((item) => [item.checkId, item.reason]));

  const emptyCells = (): Record<string, ChecklistCell> =>
    Object.fromEntries(
      CHECK_COLUMNS.map((column) => [
        column.key,
        unconfiguredBy.has(column.key)
          ? {
            state: 'info' as const,
            observed: '未設定',
            expected: null,
            severity: null,
            note: unconfiguredBy.get(column.key) ?? '',
            details: ['設定が必要'],
          }
          : { state: 'none' as const, observed: '', expected: null, severity: null, note: '', details: [] },
      ]),
    );

  const ensure = (deviceId: string, code: string): ChecklistRow => {
    let byCode = tables.get(deviceId);
    if (!byCode) {
      byCode = new Map();
      tables.set(deviceId, byCode);
    }
    const existing = byCode.get(code);
    if (existing) return existing;
    const info = meta[code] ?? { company: '', mirayaku: '' };
    const created: ChecklistRow = {
      code,
      company: info.company,
      mirayaku: info.mirayaku,
      pattern: info.pattern ?? '',
      effectiveFrom: info.effectiveFrom ?? null,
      cells: emptyCells(),
      failed: false,
    };
    byCode.set(code, created);
    return created;
  };

  for (const record of records) {
    for (const finding of record.findings) {
      const checkId = finding.checkId;
      if (!checkId) continue;
      if (!CHECK_COLUMNS.some((column) => column.key === checkId)) continue;
      const code = finding.agencyCode ?? record.agencyCode;
      if (!code || code === 'none') continue;
      // 無効コードの検査 (未登録コードで代理店名が出ないこと等) は
      // 「代理店ごとにそろっているか」の表には出さない。
      // 実在しない行が混ざると、何社を確認したのかが読めなくなる。
      if (meta[code]?.agency === false) continue;
      const deviceId = finding.deviceId ?? record.deviceId ?? 'pc';

      const cell = ensure(deviceId, code).cells[checkId];
      const observed = finding.observedValue ?? '';
      const expected = finding.expectedValue ?? null;

      // 併記する行は検査側が持っていればそれを使う。
      //   無ければ actual から 1 行だけ取り出す (従来の結果でも表示できる)。
      const details = finding.observedDetail
        ? finding.observedDetail.filter((line) => line.trim() !== '').map(clip)
        : [shortDetail(finding.actual ?? '')].filter((line) => line !== '');

      if (expected === null) {
        // 正解が未確定の項目 (保存先など)。実態だけ出す
        if (cell.state === 'none') {
          cell.state = 'info';
          cell.observed = observed;
          cell.note = finding.actual ?? '';
          cell.details = details;
        }
        continue;
      }

      // 仕様どおりだったかは検査側が持っている値で決める。
      //   代理店名の列は「表示されている会社名」をそのまま出すため、
      //   値の一致では合否を決められない。
      //   古い結果 (checkOk が無い) は値の一致で判断する。
      const ok = finding.checkOk ?? observed === expected;
      // 一度 ng になったセルは ng のままにする
      // (同じ項目を複数回検査した場合、悪い方を残す)
      if (cell.state === 'ng' && ok) continue;

      cell.state = ok ? 'ok' : 'ng';
      cell.observed = observed;
      cell.expected = expected;
      cell.note = finding.actual ?? '';
      cell.details = details;
      if (!ok) cell.severity = worseOf(cell.severity, finding.severity);
    }
  }

  const built: ChecklistTable[] = [];
  // pc → sp の順に並べる (見る順番を毎回同じにする)
  const deviceOrder = ['pc', 'sp'];
  const deviceIds = [...tables.keys()].sort(
    (a, b) => (deviceOrder.indexOf(a) + 1 || 99) - (deviceOrder.indexOf(b) + 1 || 99),
  );

  const seenPatterns = new Set<string>();
  for (const deviceId of deviceIds) {
    const rows = [...(tables.get(deviceId) ?? new Map()).values()];
    for (const row of rows) {
      row.failed = CHECK_COLUMNS.some((column) => row.cells[column.key].state === 'ng');
      if (row.pattern) seenPatterns.add(row.pattern);
    }
    // 並び順は設定 (patternOrder) で固定する。
    //   毎回同じ順で並んでいないと、前回の結果と見比べられない。
    //   問題のある行を先に出す並べ方は、行が入れ替わって読みにくい。
    const rank = (pattern: string): number => {
      const index = patternOrder.indexOf(pattern);
      return index < 0 ? patternOrder.length : index;
    };
    rows.sort((a, b) => {
      const order = rank(a.pattern) - rank(b.pattern);
      if (order !== 0) return order;
      if (a.pattern !== b.pattern) return a.pattern.localeCompare(b.pattern);
      return a.code.localeCompare(b.code);
    });
    built.push({ deviceId, deviceLabel: DEVICE_LABEL[deviceId] ?? deviceId.toUpperCase(), rows });
  }

  const missingPatterns = allPatterns
    .filter((pattern) => !seenPatterns.has(pattern))
    .map((pattern) => ({
      pattern,
      reason: '該当する代理店コードが今回の検査対象にありませんでした',
    }));

  return {
    columns: CHECK_COLUMNS.map(({ key, label }) => ({ key, label })),
    tables: built,
    missingPatterns,
  };
}
