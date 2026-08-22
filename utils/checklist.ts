/**
 * チェックリスト表 (代理店 × 検査項目)。
 *
 * このサイトで代理店コードによって変わる仕様は数が限られている。
 * 検知結果を何百件も並べるのではなく、
 *
 *   行 = 代理店 (コード / 会社名 / みらやく掲載可否)
 *   列 = 検査項目
 *   セル = ✅ (確認できた) / ❌ (仕様どおりでない) / — (この代理店では対象外)
 *
 * の 1 枚の表にして、1 画面で「全部そろっているか」を見られるようにする。
 *
 * セルの元になるのは Finding の checkId。
 * 検査は合否どちらの場合も checkId 付きの結果を残すため、
 * 「確認して問題なし (✅)」と「そもそも検査していない (—)」を区別できる。
 * 検知が無いことを ✅ の根拠にすると、検査が動いていないだけの状態を
 * 「問題なし」と表示してしまう。
 */
import { SEVERITY_ORDER } from './findings';
import type { CheckId, QaRecord, Severity } from './types';

/** チェックリストの列 (代理店コードで変わる仕様のみ) */
export const CHECK_COLUMNS: Array<{ key: CheckId; label: string }> = [
  { key: 'redirect', label: 'リダイレクト' },
  { key: 'code-applied', label: '代理店コードの付与' },
  { key: 'header-name', label: 'ヘッダーに代理店名' },
  { key: 'footer-name', label: 'フッターに代理店名' },
  { key: 'anshin-pack', label: 'あんしんパック' },
  { key: 'code-carry', label: '申込フォームでコード保持' },
];

/** セル 1 つの状態 */
export interface ChecklistCell {
  /** ok = 確認できた / ng = 仕様どおりでない / none = この代理店では検査対象外 */
  state: 'ok' | 'ng' | 'none';
  /** ng のときの最も重い重大度 */
  severity: Severity | null;
  /** 検知件数 (ng のとき) */
  count: number;
  /** 何を期待した検査かの説明 (画面のツールチップ用) */
  note: string;
}

export interface ChecklistRow {
  code: string;
  company: string;
  mirayaku: string;
  cells: Record<string, ChecklistCell>;
  /** 1 つでも ng があるか */
  failed: boolean;
  /** ✅ が付いた項目数 / 検査した項目数 */
  okCount: number;
  checkedCount: number;
}

export interface Checklist {
  columns: Array<{ key: string; label: string }>;
  rows: ChecklistRow[];
}

/** 合格として記録された結果か (検査が動いて問題が無かった) */
function isPass(severity: Severity, title: string): boolean {
  // 合格の記録は Low + 「[確認OK]」で残す。
  // Low には「未設定なので実測値を記録した」等の情報も入るため、
  // 重大度だけでは合格と区別できない。
  return severity === 'low' && title.includes('[確認OK]');
}

function worseOf(a: Severity | null, b: Severity | null): Severity | null {
  if (!a) return b;
  if (!b) return a;
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

/**
 * 検知結果からチェックリスト表を組み立てる。
 *
 * meta は代理店コード → 会社名 / みらやく掲載可否。
 * コードだけでは人が「どの会社か」を判断できないため必須。
 */
export function buildChecklist(
  records: QaRecord[],
  meta: Record<string, { company: string; mirayaku: string; agency?: boolean }> = {},
): Checklist {
  const rows = new Map<string, ChecklistRow>();

  const emptyCells = (): Record<string, ChecklistCell> =>
    Object.fromEntries(
      CHECK_COLUMNS.map((column) => [
        column.key,
        { state: 'none' as const, severity: null, count: 0, note: '' },
      ]),
    );

  const ensure = (code: string): ChecklistRow => {
    const existing = rows.get(code);
    if (existing) return existing;
    const info = meta[code] ?? { company: '', mirayaku: '' };
    const created: ChecklistRow = {
      code,
      company: info.company,
      mirayaku: info.mirayaku,
      cells: emptyCells(),
      failed: false,
      okCount: 0,
      checkedCount: 0,
    };
    rows.set(code, created);
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

      const cell = ensure(code).cells[checkId];
      if (isPass(finding.severity, finding.title)) {
        // すでに ng が入っている場合は ng を優先する
        // (PC で通り SP で落ちるなら、その代理店は ❌ として扱う)
        if (cell.state !== 'ng') {
          cell.state = 'ok';
          if (cell.note === '') cell.note = finding.actual ?? finding.expected ?? '';
        }
      } else {
        cell.state = 'ng';
        cell.severity = worseOf(cell.severity, finding.severity);
        cell.count += 1;
        cell.note = finding.actual ?? finding.expected ?? '';
      }
    }
  }

  for (const row of rows.values()) {
    for (const column of CHECK_COLUMNS) {
      const cell = row.cells[column.key];
      if (cell.state === 'none') continue;
      row.checkedCount += 1;
      if (cell.state === 'ok') row.okCount += 1;
      else row.failed = true;
    }
  }

  // ❌ のある代理店を先に出す (対応すべき行が上に来る)
  const sorted = [...rows.values()].sort((a, b) => {
    if (a.failed !== b.failed) return a.failed ? -1 : 1;
    return a.code.localeCompare(b.code);
  });

  return { columns: CHECK_COLUMNS.map(({ key, label }) => ({ key, label })), rows: sorted };
}
