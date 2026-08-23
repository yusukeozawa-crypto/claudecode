#!/usr/bin/env node
/**
 * 検査結果を CSV に書き出す (npm run export)。
 *
 *   npm run export
 *   npm run export -- --from=reports/保存/全件_20260823.json
 *
 * 出力:
 *   reports/export/checklist.csv  代理店 × 検査項目の表
 *   reports/export/findings.csv   検知の一覧
 *
 * すでに保存されているレポートを読むだけなので、検査を回し直す必要はない。
 * Excel で開いたときに日本語が壊れないよう、UTF-8 の BOM を付ける。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const fromArg = args.find((arg) => arg.startsWith('--from='));
const source = fromArg
  ? path.resolve(root, fromArg.slice('--from='.length))
  : path.join(root, 'reports', 'qa-report.json');
const outDir = path.join(root, 'reports', 'export');

if (!fs.existsSync(source)) {
  console.error(`レポートがありません: ${path.relative(root, source)}`);
  console.error('先に検査を実行するか、--from= で保存済みのファイルを指定してください。');
  process.exit(1);
}

/**
 * CSV の 1 セル。
 *   カンマ・改行・引用符が入っていても壊れないように囲む。
 *   Excel は先頭が = + - @ の値を数式として扱うため、その場合は前に ' を付ける。
 */
function cell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  // BOM: Excel で開いたときに日本語が文字化けしないようにする
  // 改行は CRLF (Excel の既定)
  return `﻿${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

const report = JSON.parse(fs.readFileSync(source, 'utf8'));
const summary = report.summary ?? {};
const records = report.records ?? [];
const meta = summary.agencyMeta ?? {};

// ---------- チェックリスト ----------
const checklist = summary.checklist ?? { columns: [], tables: [] };
const columns = checklist.columns ?? [];
const checklistRows = [
  [
    '端末',
    'パターン',
    '想定開始日',
    '代理店コード',
    '会社名',
    'みらやく',
    // 検査項目は「値」と「確認できた内容」の 2 列に分ける。
    // 1 列にまとめると Excel で並べ替え・絞り込みができない。
    ...columns.flatMap((column) => [column.label, `${column.label} (確認内容)`]),
  ],
];
for (const table of checklist.tables ?? []) {
  for (const row of table.rows ?? []) {
    checklistRows.push([
      table.deviceLabel ?? table.deviceId ?? '',
      row.pattern ?? '',
      row.effectiveFrom ?? '',
      row.code ?? '',
      row.company ?? '',
      row.mirayaku ?? '',
      ...columns.flatMap((column) => {
        const c = row.cells?.[column.key];
        if (!c || c.state === 'none') return ['未検査', ''];
        const detail = (c.details ?? []).join(' / ');
        // 期待と違うものは値だけ見ても分からないので、期待値も添える
        const value = c.state === 'ng' ? `${c.observed} (期待: ${c.expected ?? ''})` : c.observed;
        return [value, detail];
      }),
    ]);
  }
}

// ---------- 検知一覧 ----------
const findingRows = [
  ['重大度', '種別', '代理店コード', '会社名', '端末', 'ページ', '題名', '期待', '実際', '詳細', '再現URL'],
];
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const findings = records.flatMap((record) =>
  (record.findings ?? []).map((finding) => ({ finding, record })),
);
findings.sort(
  (a, b) => SEVERITY_ORDER.indexOf(a.finding.severity) - SEVERITY_ORDER.indexOf(b.finding.severity),
);
for (const { finding, record } of findings) {
  const code = finding.agencyCode ?? record.agencyCode ?? '';
  findingRows.push([
    SEVERITY_LABEL[finding.severity] ?? finding.severity,
    finding.category ?? '',
    code,
    meta[code]?.company ?? '',
    finding.deviceId ?? record.deviceId ?? '',
    finding.pageName ?? finding.pageId ?? record.pageName ?? '',
    finding.title ?? '',
    finding.expected ?? '',
    finding.actual ?? '',
    finding.detail ?? '',
    finding.url ?? '',
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
const checklistPath = path.join(outDir, 'checklist.csv');
const findingsPath = path.join(outDir, 'findings.csv');
fs.writeFileSync(checklistPath, toCsv(checklistRows), 'utf8');
fs.writeFileSync(findingsPath, toCsv(findingRows), 'utf8');

console.log('');
console.log('==================== CSV に書き出しました ====================');
console.log(`元データ      : ${path.relative(root, source)}`);
if (summary.startedAt) console.log(`実行日時      : ${new Date(summary.startedAt).toLocaleString('ja-JP')}`);
if (summary.partial) console.log('注意          : これは検査中の途中結果です (最後まで走っていません)');
console.log(`代理店 × 項目 : ${path.relative(root, checklistPath)}  (${checklistRows.length - 1} 行)`);
console.log(`検知の一覧    : ${path.relative(root, findingsPath)}  (${findingRows.length - 1} 行)`);
console.log('Excel でそのまま開けます (日本語が壊れないよう BOM を付けています)');
console.log('=============================================================');
