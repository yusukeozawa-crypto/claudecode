/**
 * 端末をまたいだ食い違いの検出。
 *
 * PC と SP は別々のプロセスで実行されるため、テストの中からは
 * 「もう片方の端末では何と書いてあったか」を見られない。
 * すべての結果がそろうレポート生成時にだけ比較できる。
 */
import type { Finding, QaRecord } from './types';

/** 端末の表示名 (端末をまたいだ比較の結果に出す) */
const DEVICE_LABEL: Record<string, string> = { pc: 'PC', sp: 'SP' };

/**
 * 端末 (PC / SP) をまたいで一致すべき値を見比べる。
 *
 *   PC と SP は別々に実行されるため、テストの中からは
 *   「もう片方の端末では何と書いてあったか」を見られない。
 *   すべての結果がそろうこの段階でだけ比較できる。
 *
 *   レイアウトや文章量は端末で違ってよい。ここで見るのは
 *   Finding.sameAcrossDevices に入れた「同じであるべき値」だけ。
 *   ページ全体を比べるとノイズだらけになって使えない。
 */
export function compareAcrossDevices(records: QaRecord[]): QaRecord[] {
  // key → label / device → value
  const groups = new Map<string, { label: string; byDevice: Map<string, string> }>();
  for (const record of records) {
    for (const finding of record.findings) {
      const target = finding.sameAcrossDevices;
      if (!target) continue;
      const device = finding.deviceId ?? record.deviceId;
      if (!device || device === 'unknown') continue;
      let group = groups.get(target.key);
      if (!group) {
        group = { label: target.label, byDevice: new Map() };
        groups.set(target.key, group);
      }
      group.byDevice.set(device, target.value);
    }
  }

  const findings: Finding[] = [];
  for (const [key, group] of groups) {
    // 1 端末しか記録が無ければ比べられない (片方が未実行・スキップ)
    if (group.byDevice.size < 2) continue;
    const values = [...new Set(group.byDevice.values())];
    if (values.length <= 1) continue;
    const detail = [...group.byDevice.entries()]
      .map(([device, value]) => `${DEVICE_LABEL[device] ?? device}: 「${value}」`)
      .join(' / ');
    const agencyCode = key.includes(':') ? key.slice(key.indexOf(':') + 1) : undefined;
    findings.push({
      category: 'text-rule',
      severity: 'low',
      title: `${group.label}が端末で違います`,
      expected: `${group.label}は PC と SP で同じであること`,
      actual: detail,
      url: '',
      deviceId: 'pc, sp',
      agencyCode,
      detail:
        'レイアウトや文章量は端末で違って構いませんが、同じボタンの文言が違う場合は'
        + '打ち間違いの可能性があります。意図した違いであれば無視してください。',
    });
  }

  if (findings.length === 0) return [];
  const first = records[0];
  return [
    {
      testId: 'cross-device-consistency',
      testTitle: '端末をまたいだ表記の一致',
      suite: '文言チェック',
      environment: first?.environment ?? '',
      environmentLabel: first?.environmentLabel ?? '',
      baseUrl: first?.baseUrl ?? '',
      browserId: 'report',
      deviceId: 'pc, sp',
      deviceLabel: 'PC / SP',
      status: 'passed',
      durationMs: 0,
      startedAt: new Date().toISOString(),
      findings,
    },
  ];
}

