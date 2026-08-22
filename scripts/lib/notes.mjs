/**
 * 備考 (保留事項 / 後日確認 / 後日仕様変更) を組み立てる。
 *
 * ブラウザ画面の「備考」に出す。検査結果とは別に、
 * 「今は判断できないこと」「あとで確認すること」を忘れないための覚え書き。
 *
 * 手で書くのは config/notes.yml だけ。
 * 設定から分かるものは自動で拾う (書き写すと必ず古くなるため):
 *   ・既知の不具合と その修正予定日      (config/known-issues.yml)
 *   ・検査対象外にした代理店              (config/agencies.yml)
 *   ・未実測の項目 (保存先 / 遷移方式 / リダイレクト回数)
 *
 * 検査を 1 回も実行していなくても出せるように、
 * レポートではなく設定ファイルから直接作る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** 期日が来ているか (来ていれば画面で強調する) */
function isDue(due, today = new Date()) {
  if (!due) return false;
  const at = new Date(`${due}T00:00:00`);
  if (Number.isNaN(at.getTime())) return false;
  return today.getTime() >= at.getTime();
}

function readYaml(file) {
  try {
    return parseYaml(fs.readFileSync(file, 'utf8')) ?? {};
  } catch {
    // 設定が読めない場合は備考を空にする (画面を壊さない)
    return {};
  }
}

/**
 * 環境ごとの設定を重ねる (config/xxx.local.yml が優先)。
 * 検査本体と同じ考え方 (utils/config.ts) に合わせる。
 */
function readConfig(configDir, name, environment) {
  const base = readYaml(path.join(configDir, `${name}.yml`));
  if (!environment) return base;
  const overridePath = path.join(configDir, `${name}.${environment}.yml`);
  if (!fs.existsSync(overridePath)) return base;
  return { ...base, ...readYaml(overridePath) };
}

/**
 * 備考の一覧を作る。
 *
 * @param root プロジェクトのルート
 * @param options.environment 環境名 (local のときモック用の設定を読む)
 * @param options.today 期日の判定に使う日付 (テスト用)
 */
export function buildNotes(root, options = {}) {
  const configDir = path.join(root, 'config');
  const { environment = null, today = new Date() } = options;
  const notes = [];

  // ---- 1. 手で書いた備考 ----
  const manual = readYaml(path.join(configDir, 'notes.yml')).notes ?? [];
  for (const note of manual) {
    if (!note || !note.id) continue;
    notes.push({
      id: String(note.id),
      kind: String(note.kind ?? '保留'),
      title: String(note.title ?? note.id),
      detail: String(note.detail ?? '').trim(),
      due: note.due ? String(note.due) : null,
      dueReached: isDue(note.due, today),
      source: 'notes.yml',
    });
  }

  // ---- 2. 既知の不具合 (修正予定日つき) ----
  for (const issue of readYaml(path.join(configDir, 'known-issues.yml')).knownIssues ?? []) {
    if (!issue || !issue.id) continue;
    const fixedOn = issue.fixedOn ? String(issue.fixedOn) : null;
    const passed = isDue(fixedOn, today);
    notes.push({
      id: `known-issue:${issue.id}`,
      kind: '仕様変更',
      title: passed
        ? `${issue.title} — 修正予定日 (${fixedOn}) を過ぎました`
        : `${issue.title} — ${fixedOn ?? '日付未定'} に修正予定`,
      detail: [
        String(issue.note ?? '').trim(),
        passed
          ? '既知扱いは終了しました。直っていればこの検知は出ません。' +
            '出続ける場合は本来の重大度で報告されます。' +
            '直ったことを確認したら config/known-issues.yml から削除してください。'
          : `${fixedOn} までは Low として報告します (毎回 Critical が並んで本当の異常が埋もれるのを防ぐため)。` +
            'この日を過ぎたら本来の重大度に戻ります。',
        `対象コード: ${(issue.codes ?? []).join(', ') || '(未設定)'}`,
      ]
        .filter((part) => part !== '')
        .join(' '),
      due: fixedOn,
      dueReached: passed,
      source: 'known-issues.yml',
    });
  }

  // ---- 3. 検査対象外にした代理店 ----
  const agenciesFile = readConfig(configDir, 'agencies', environment);
  const excluded = agenciesFile.excludedAgencies ?? [];
  if (excluded.length > 0) {
    notes.push({
      id: 'excluded-agencies',
      kind: '保留',
      title: `検査対象外にしている代理店が ${excluded.length} 件あります`,
      detail:
        excluded
          .map((entry) => `${entry.code}${entry.company ? ` (${entry.company})` : ''}: ${entry.reason ?? '理由未設定'}`)
          .join(' / ') +
        ' — 期待結果が決まれば config/agency-profiles.yml の設定を変えて対象に戻せます。',
      due: null,
      dueReached: false,
      source: 'agencies.yml',
    });
  }

  // ---- 4. 未実測の項目 ----
  const agencyFile = readConfig(configDir, 'agency', environment);
  if ((agencyFile.storage?.type ?? 'none') === 'none') {
    notes.push({
      id: 'storage-type-unknown',
      kind: '確認待ち',
      title: '代理店コードの保存先 (Cookie / localStorage) が未確認',
      detail:
        'config/agency.yml の storage.type が none のため、保存値を根拠にした判定を行っていません ' +
        '(URL のみで引き回す実装を誤検知しないため)。' +
        '「仕様調査」ボタンで Cookie 名 / localStorage キーが分かったら設定してください。',
      due: null,
      dueReached: false,
      source: 'agency.yml',
    });
  }

  const agencies = agenciesFile.agencies ?? [];
  const unknownMechanism = agencies.filter((agency) => agency?.redirectMechanism === 'unknown');
  if (unknownMechanism.length > 0) {
    notes.push({
      id: 'redirect-mechanism-unknown',
      kind: '確認待ち',
      title: `リダイレクトの実装方式が未実測の代理店が ${unknownMechanism.length} 件あります`,
      detail:
        'HTTP 3xx / JavaScript / meta refresh / SPA のどれかが未確定です。' +
        '確定するまで方式は照合せず、実測値をレポートに記録しています ' +
        '(推測した方式で判定すると正常なサイトを不具合として報告してしまうため)。' +
        `例: ${unknownMechanism.slice(0, 3).map((agency) => agency.code).join(', ')}`,
      due: null,
      dueReached: false,
      source: 'agencies.yml',
    });
  }

  const unknownCount = agencies.filter((agency) => agency?.expectedRedirectCount === null);
  if (unknownCount.length > 0) {
    notes.push({
      id: 'redirect-count-unknown',
      kind: '確認待ち',
      title: `リダイレクト回数が未設定の代理店が ${unknownCount.length} 件あります`,
      detail:
        '回数の変化 (リダイレクトが増えた・減った) を検知できません。' +
        'レポートに実測値が出ているので、それを config/agency-profiles.yml の ' +
        'expectedRedirectCount に設定してください。' +
        `例: ${unknownCount.slice(0, 3).map((agency) => agency.code).join(', ')}`,
      due: null,
      dueReached: false,
      source: 'agencies.yml',
    });
  }

  // 期日が来たものを先に出す (対応すべきものが上に来る)
  // 不具合を先頭に置く (サイト側の実害があるものから読ませる)
  const kindOrder = ['不具合', '仕様変更', '確認待ち', '保留'];
  return notes.sort((a, b) => {
    if (a.dueReached !== b.dueReached) return a.dueReached ? -1 : 1;
    const order = kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind);
    if (order !== 0) return order;
    return a.title.localeCompare(b.title);
  });
}
