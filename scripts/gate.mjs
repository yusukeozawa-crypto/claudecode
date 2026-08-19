#!/usr/bin/env node
/**
 * 重大度ゲート。
 * reports/qa-report.json を読み、Critical または High が 1 件でもあれば終了コード 1 で終了する。
 * (Playwright 実行そのものも同じ判定で失敗するが、CI で明示的に判定したい場合に使用する)
 */
import fs from 'node:fs';
import path from 'node:path';

const reportPath = path.resolve(process.cwd(), 'reports/qa-report.json');

if (!fs.existsSync(reportPath)) {
  console.error('reports/qa-report.json が見つかりません。先に npm test を実行してください。');
  process.exit(2);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const counts = report.summary?.findings ?? { critical: 0, high: 0, medium: 0, low: 0 };
// 判定基準はレポートに記録された設定 (config/runtime.yml の failOnSeverities) に従う。
// ここで固定値を持つと、設定を変えたときにテスト側の判定とずれる。
const failOn = report.summary?.failOnSeverities ?? ['critical', 'high'];
const severityLabel = failOn.map((severity) => severity.toUpperCase()).join(' / ');

console.log(`対象環境 : ${report.summary?.environmentLabel ?? '-'} (${report.summary?.baseUrl ?? '-'})`);
console.log(`検知件数 : Critical ${counts.critical} / High ${counts.high} / Medium ${counts.medium} / Low ${counts.low}`);
console.log(`判定基準 : ${severityLabel} を 1 件でも検知したら失敗`);

const blockingCount = failOn.reduce((total, severity) => total + (counts[severity] ?? 0), 0);

if (blockingCount > 0) {
  console.error(`判定: 失敗 — ${severityLabel} の不具合を検知しました。`);
  const blocking = (report.records ?? [])
    .flatMap((record) => record.findings ?? [])
    .filter((finding) => failOn.includes(finding.severity));
  for (const finding of blocking.slice(0, 20)) {
    console.error(` - [${finding.severity}] ${finding.title} (${finding.pageName ?? finding.pageId ?? '-'} / ${finding.deviceId ?? '-'}) ${finding.url}`);
  }
  if (blocking.length > 20) console.error(` ... 他 ${blocking.length - 20} 件`);
  process.exit(1);
}

console.log(`判定: 成功 — ${severityLabel} の不具合はありません。`);
