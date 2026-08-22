#!/usr/bin/env node
/**
 * 検知した不具合を文字だけで出力する (npm run findings)。
 *
 * HTML レポートは画面で読む用。共有・相談のために
 * 「何が出たか」を貼り付けられる形で出す。
 * 秘密情報はレポート生成時にマスキング済みの値をそのまま使う。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JSON_PATH = path.join(root, 'reports', 'qa-report.json');

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

const args = process.argv.slice(2);
const limitArg = args.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 40;
const onlyArg = args.find((arg) => arg.startsWith('--severity='));
const only = onlyArg ? onlyArg.split('=')[1].split(',') : null;
// 代理店コードで絞る (--code=littlefamily03)。
//   1 社の挙動を追うとき、全件から目で探すのは現実的ではない。
const codeArg = args.find((arg) => arg.startsWith('--code='));
const codes = codeArg ? codeArg.split('=')[1].split(',').filter((value) => value !== '') : null;
// 文字で絞る (--find=リダイレクト)。題名・期待・実際のいずれかに含まれるもの
const findArg = args.find((arg) => arg.startsWith('--find='));
const keyword = findArg ? findArg.split('=').slice(1).join('=') : null;

if (!fs.existsSync(JSON_PATH)) {
  console.error('レポートがありません。先に検査を実行してください (run-qa.cmd または npm run test:local)。');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const { summary, records } = report;

console.log('');
console.log('==================== 検知内容 ====================');
console.log(`実行日時 : ${new Date(summary.startedAt).toLocaleString('ja-JP')}`);
console.log(`対象環境 : ${summary.environmentLabel} (${summary.environment}) ${summary.baseUrl}`);
console.log(
  `テスト   : 合計 ${summary.tests.total} / 成功 ${summary.tests.passed} / 失敗 ${summary.tests.failed} / スキップ ${summary.tests.skipped}`,
);
if (summary.agencySampling) {
  const { seed, scope, selected, total } = summary.agencySampling;
  console.log(`代理店   : ${selected} / ${total} 件 (${scope === 'all' ? '全件' : `抽選 QA_AGENCY_SEED=${seed}`})`);
}
const counts = summary.findings ?? {};
console.log(
  `検知件数 : ${SEVERITY_ORDER.map((severity) => `${SEVERITY_LABEL[severity]} ${counts[severity] ?? 0}`).join(' / ')}`,
);

const findings = records.flatMap((record) => record.findings ?? []);
const matchesFilters = (finding) => {
  if (only && !only.includes(finding.severity)) return false;
  if (codes && !codes.includes(finding.agencyCode ?? '')) return false;
  if (keyword) {
    const haystack = [finding.title, finding.expected, finding.actual, finding.detail].join(' ');
    if (!haystack.includes(keyword)) return false;
  }
  return true;
};
const target = findings.filter(matchesFilters);
if (codes) console.log(`絞り込み : 代理店 ${codes.join(', ')}`);
if (keyword) console.log(`絞り込み : 「${keyword}」を含むもの`);
target.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

if (target.length === 0) {
  console.log('');
  console.log(
    codes || keyword || only
      ? '絞り込みに一致する検知はありません。'
      : '検知した不具合はありません。',
  );
} else {
  // 同じ内容が代理店・端末ごとに並ぶため、内容単位でまとめる
  const groups = new Map();
  for (const finding of target) {
    const key = [finding.severity, finding.category, finding.title, finding.expected, finding.actual].join(' | ');
    const group = groups.get(key);
    if (group) group.items.push(finding);
    else groups.set(key, { finding, items: [finding] });
  }

  console.log('');
  console.log(`種類ごとにまとめて ${groups.size} 件 (延べ ${target.length} 件)`);
  let index = 0;
  for (const { finding, items } of groups.values()) {
    index += 1;
    if (index > limit) {
      console.log('');
      console.log(`... 他 ${groups.size - limit} 種類 (--limit=${groups.size} で全件表示)`);
      break;
    }
    const devices = [...new Set(items.map((item) => item.deviceId).filter(Boolean))];
    const codes = [...new Set(items.map((item) => item.agencyCode).filter(Boolean))];
    const pages = [...new Set(items.map((item) => item.pageName ?? item.pageId).filter(Boolean))];
    console.log('');
    console.log(`[${SEVERITY_LABEL[finding.severity]}] ${finding.title}`);
    console.log(`  種別   : ${finding.category}`);
    if (finding.detail) console.log(`  詳細   : ${finding.detail}`);
    console.log(`  期待   : ${finding.expected ?? '-'}`);
    console.log(`  実際   : ${finding.actual ?? '-'}`);
    if (pages.length > 0) console.log(`  ページ : ${pages.join(', ')}`);
    if (devices.length > 0) console.log(`  端末   : ${devices.join(', ')}`);
    if (codes.length > 0) {
      const shown = codes.slice(0, 6).join(', ');
      console.log(`  代理店 : ${shown}${codes.length > 6 ? ` ...他 ${codes.length - 6} 件` : ''} (${codes.length} 件)`);
    }
    console.log(`  件数   : ${items.length}`);
    console.log(`  再現URL: ${finding.url}`);
  }
}

const failed = records.filter((record) => record.status === 'failed' || record.status === 'timedOut');
if (failed.length > 0) {
  console.log('');
  console.log(`---- 失敗したテスト (${failed.length} 件) ----`);
  const byMessage = new Map();
  for (const record of failed) {
    const first = (record.errorMessage ?? '(メッセージなし)').split('\n')[0].slice(0, 160);
    byMessage.set(first, (byMessage.get(first) ?? 0) + 1);
  }
  for (const [message, count] of [...byMessage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(count).padStart(3)} 件: ${message}`);
  }
}
console.log('');
console.log('==================================================');
