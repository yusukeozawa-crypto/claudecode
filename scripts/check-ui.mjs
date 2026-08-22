#!/usr/bin/env node
/**
 * ブラウザ画面 (ローカル Web UI) の自己検査。
 *
 *   npm run selftest:ui
 *
 * 画面を人が開かなくても、次が壊れていないことを確認する:
 *   - 状態の取得 (/api/state) が返る
 *   - 固定リスト以外の操作を実行しない (任意コマンドを動かさない)
 *   - reports/ の外のファイルを返さない
 *   - 対象サイトの URL の検証 (不正な形式を保存しない・パスを落とす)
 *   - 認証情報を画面に返さない
 *
 * 検査そのもの (npm run test:local) は実行しない (時間がかかるため)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.QA_UI_IMPORT = '1';
const { server, checklistOf, findingGroups } = await import('./ui-server.mjs');
const { buildNotes } = await import('./lib/notes.mjs');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const failures = [];

function check(name, fn) {
  try {
    const result = fn();
    return result instanceof Promise
      ? result.then(
          () => process.stdout.write(`  OK   ${name}\n`),
          (error) => {
            failures.push(name);
            process.stdout.write(`  NG   ${name}: ${error.message}\n`);
          },
        )
      : process.stdout.write(`  OK   ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`  NG   ${name}: ${error.message}\n`);
    return undefined;
  }
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const json = async (pathname, init) => {
  const response = await fetch(`${base}${pathname}`, init);
  return { status: response.status, body: await response.json() };
};

process.stdout.write('\nブラウザ画面の自己検査\n');

await check('画面の HTML を返す', async () => {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('自動QA'), '画面の見出しが含まれること');
  assert.ok(!/<script src="http/.test(html), '外部スクリプトを読み込まないこと');
});

await check('状態を取得できる', async () => {
  const { status, body } = await json('/api/state');
  assert.equal(status, 200);
  assert.equal(typeof body.running, 'boolean');
  // 練習用サイト (ローカルモック) は画面に出さない (ツール自身の動作確認用)
  assert.ok(Array.isArray(body.targets) && body.targets.length === 2, '検査対象が 2 つ返ること');
  assert.deepEqual(
    body.targets.map((target) => target.key),
    ['staging', 'production'],
    '画面から実行できるのはステージングと本番だけであること',
  );
  assert.ok(body.env && body.env.staging, '環境の設定状況が返ること');
});

await check('認証情報は画面に返さない', async () => {
  const { body } = await json('/api/state');
  const text = JSON.stringify(body.env);
  assert.ok(!/BASIC_PASS|password/i.test(text), 'パスワードのキーが含まれないこと');
  for (const target of ['staging', 'production']) {
    assert.equal(typeof body.env[target].hasCredentials, 'boolean', '設定済みかどうかだけを返すこと');
  }
});

await check('固定リスト以外の操作は実行しない', async () => {
  for (const key of ['rm -rf /', 'test:local; echo hacked', 'unknown']) {
    const { status, body } = await json(`/api/run?kind=action&key=${encodeURIComponent(key)}`, { method: 'POST' });
    assert.equal(status, 409, `${key} は拒否されること`);
    assert.equal(body.ok, false);
  }
});

await check('不明な件数の指定は実行しない', async () => {
  for (const size of ['huge', '1; rm -rf /', '']) {
    const { status, body } = await json(
      `/api/run?kind=test&key=staging&size=${encodeURIComponent(size)}`,
      { method: 'POST' },
    );
    assert.equal(status, 409, `${size || '(空)'} は拒否されること`);
    assert.equal(body.ok, false);
  }
});

await check('件数の選択肢が返る', async () => {
  const { body } = await json('/api/state');
  const keys = (body.sizes ?? []).map((size) => size.key);
  assert.deepEqual(keys, ['min', 'standard', 'all'], '最小 / 標準 / 全件を返すこと');
  assert.equal(body.restartRequired, false, '更新前は再起動の案内を出さないこと');
});

await check('画面は選択肢が無くても操作できる (古いサーバー対策)', async () => {
  const response = await fetch(base);
  const html = await response.text();
  // 更新直後は画面だけ新しくなり、動いているサーバーが古い状態になる。
  // 選択肢が返らない場合でも既定値を出し、開き直しを促す必要がある。
  assert.ok(html.includes("state.sizes || []"), '選択肢が無い場合の既定値を持つこと');
  assert.ok(html.includes('restart-notice'), '開き直しの案内を持つこと');
});

await check('reports の外のファイルは返さない', async () => {
  for (const target of ['%2e%2e%2fpackage.json', '..%2f..%2f.env', '%2e%2e%2f%2e%2e%2fconfig%2fagency.yml']) {
    const response = await fetch(`${base}/reports/${target}`);
    assert.ok(response.status === 403 || response.status === 404, `${target} を返さないこと (${response.status})`);
  }
});

await check('不正な URL は保存しない', async () => {
  for (const baseUrl of ['not-a-url', 'javascript:alert(1)', 'file:///etc/passwd', '']) {
    const { status, body } = await json('/api/env', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'staging', baseUrl }),
    });
    assert.equal(status, 400, `${baseUrl || '(空)'} は拒否されること`);
    assert.equal(body.ok, false);
  }
  const unknown = await json('/api/env', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'local', baseUrl: 'https://example.jp' }),
  });
  assert.equal(unknown.status, 400, '不明な環境は拒否されること');
});

await check('URL はドメインまでで保存する', async () => {
  const envPath = path.join(root, '.env');
  const backup = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null;
  try {
    const { body } = await json('/api/env', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'staging', baseUrl: 'https://lp.selfcheck.test/lp/service/?a=1' }),
    });
    assert.equal(body.ok, true);
    assert.equal(body.saved, 'https://lp.selfcheck.test', 'ドメインだけを保存すること');
    assert.equal(body.droppedPath, '/lp/service/', '落としたパスを知らせること');
    const saved = fs.readFileSync(envPath, 'utf8');
    assert.ok(/^STAGING_BASE_URL=https:\/\/lp\.selfcheck\.test$/m.test(saved), '.env に書かれること');
    // 同じキーが 2 行あると「どちらが効くのか」が分からなくなる
    const occurrences = saved.split('\n').filter((line) => line.startsWith('STAGING_BASE_URL=')).length;
    assert.equal(occurrences, 1, '同じキーを重複させないこと');
  } finally {
    if (backup === null) fs.rmSync(envPath, { force: true });
    else fs.writeFileSync(envPath, backup, 'utf8');
  }
});

await check('チェックリストをレポートから受け取れる', () => {
  // 計算はレポート側 (utils/checklist.ts) が行う。
  // 画面は結果を渡すだけなので、壊れた・古いレポートで落ちないことを確認する。
  const checklist = {
    columns: [{ key: 'redirect', label: 'リダイレクト' }],
    tables: [
      {
        deviceId: 'pc',
        deviceLabel: 'PC',
        rows: [
          {
            code: 'littlefamily03',
            company: '株式会社カカクコム・インシュアランス',
            mirayaku: '○',
            pattern: 'カカクコム',
            effectiveFrom: null,
            cells: { redirect: { state: 'ok', observed: 'あり', expected: 'あり', severity: null, note: '' } },
            failed: false,
          },
        ],
      },
    ],
    missingPatterns: [],
  };
  assert.deepEqual(checklistOf({ summary: { checklist } }), checklist, 'そのまま渡すこと');
  assert.deepEqual(
    checklistOf({ summary: {} }),
    { columns: [], tables: [], missingPatterns: [] },
    'チェックリストが無いレポートでも壊れないこと',
  );
  assert.deepEqual(
    checklistOf({ summary: { checklist: { columns: 'こわれた' } } }),
    { columns: [], tables: [], missingPatterns: [] },
    '形が違う場合は空にすること',
  );
  assert.deepEqual(
    checklistOf(null),
    { columns: [], tables: [], missingPatterns: [] },
    'レポートが無くても壊れないこと',
  );
});

await check('検知結果を同じ内容でまとめられる', () => {
  const groups = findingGroups([
    {
      agencyCode: 'A001',
      deviceId: 'pc',
      findings: [
        { severity: 'critical', category: 'agency-display', title: '誤表示', expected: 'X', actual: 'Y', url: 'u', deviceId: 'pc', agencyCode: 'A001' },
      ],
    },
    {
      agencyCode: 'A001',
      deviceId: 'sp',
      findings: [
        { severity: 'critical', category: 'agency-display', title: '誤表示', expected: 'X', actual: 'Y', url: 'u', deviceId: 'sp', agencyCode: 'A001' },
      ],
    },
    {
      agencyCode: 'A002',
      deviceId: 'pc',
      findings: [{ severity: 'low', category: 'text-rule', title: '表記', url: 'u', deviceId: 'pc', agencyCode: 'A002' }],
    },
  ]);
  assert.equal(groups.length, 2, 'PC と SP で同じ内容なら 1 件にまとめること');
  assert.equal(groups[0].severity, 'critical', '重い方を先に出すこと');
  assert.equal(groups[0].count, 2, '件数を数えること');
  assert.deepEqual(groups[0].devices, ['pc', 'sp'], 'どの端末で出たか分かること');
  assert.deepEqual(groups[0].agencies, ['A001'], 'どの代理店で出たか分かること');
});

await check('画面に渡すデータを小さく保つ (通信が詰まらないように)', async () => {
  // レポートには代理店 211 社の一覧が入っており、そのまま送ると 1 回で
  // 90KB を超える。画面は数秒ごとに取りに来るため、通信が詰まって
  // 「画面とつながっていません」と出る。実際にそうなった。
  const response = await fetch(`${base}/api/state`);
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(body.agencyMeta, undefined, '代理店 211 社の一覧を送らないこと');
  assert.equal(body.summary?.agencyMeta, undefined, '要約の中にも入れないこと');
  assert.equal(body.summary?.checklist, undefined, 'チェックリストを二重に送らないこと');
  assert.ok(
    text.length < 300 * 1024,
    `1 回のデータを 300KB 未満に保つこと (実際: ${Math.round(text.length / 1024)}KB)`,
  );
});

await check('チェックリストの表が画面にある', async () => {
  const { body } = await json('/api/state');
  assert.equal(typeof body.checklist, 'object', 'チェックリストが返ること');
  assert.ok(Array.isArray(body.checklist.tables), 'PC / SP の表が返ること');
  const response = await fetch(base);
  const html = await response.text();
  assert.ok(html.includes('会社名'), '会社名の列を持つこと');
  assert.ok(html.includes('みらやく'), 'みらやくの列を持つこと');
  // 「検知が無い」を ✅ にすると、検査が動いていないだけの状態を
  // 「問題なし」と見せてしまう。対象外は — で区別できる必要がある
  assert.ok(html.includes("cell.state === 'none'"), '検査していない項目を区別すること');
  assert.ok(html.includes('check-ng'), '期待と違うセルを赤くする指定を持つこと');
  assert.ok(html.includes('table.deviceLabel'), 'PC / SP を分けて出すこと');
});

await check('備考が検査の実行前でも出る', async () => {
  // 保留事項・後日確認は「忘れないため」のものなので、
  // 検査を 1 回も実行していない状態でも見えなければ意味がない。
  // そのためレポートではなく設定ファイルから作っている。
  const notes = buildNotes(root);
  assert.ok(notes.length > 0, '備考が 1 件以上あること');
  for (const note of notes) {
    assert.ok(note.id, 'id があること');
    assert.ok(note.title, 'title があること');
    assert.ok(
      ['不具合', '保留', '確認待ち', '仕様変更'].includes(note.kind),
      `kind が想定内であること: ${note.kind}`,
    );
  }
  const { body } = await json('/api/state');
  assert.ok(Array.isArray(body.notes) && body.notes.length > 0, '画面の状態に備考が入ること');
  const response = await fetch(base);
  const html = await response.text();
  assert.ok(html.includes('notes-section'), '備考の節を持つこと');
});

await check('設定から分かる備考は自動で出る (書き写さない)', async () => {
  // 手で書き写すと必ず古くなる。設定を変えたら備考も変わる必要がある。
  const notes = buildNotes(root);
  const ids = notes.map((note) => note.id);
  assert.ok(
    ids.some((id) => id.startsWith('known-issue:')),
    '既知の不具合 (known-issues.yml) が備考に出ること',
  );
  assert.ok(ids.includes('excluded-agencies'), '検査対象外の代理店が備考に出ること');
  assert.ok(ids.includes('storage-type-unknown'), '未実測の保存先が備考に出ること');

  // 修正予定日を過ぎたら「過ぎました」に変わること (放置に気づけるように)
  const future = buildNotes(root, { today: new Date('2026-01-01T00:00:00Z') });
  const past = buildNotes(root, { today: new Date('2030-01-01T00:00:00Z') });
  const before = future.find((note) => note.id === 'known-issue:branch-code-not-applied');
  const after = past.find((note) => note.id === 'known-issue:branch-code-not-applied');
  assert.equal(before.dueReached, false, '修正予定日の前は期日扱いにしないこと');
  assert.equal(after.dueReached, true, '修正予定日を過ぎたら期日扱いにすること');
  assert.ok(after.title.includes('過ぎました'), '過ぎたことが分かる表記であること');
  assert.equal(past[0].dueReached, true, '期日が来たものを先に出すこと');
});

await check('npm script に OS で意味が変わる記号を入れない (Windows 対策)', () => {
  // Windows では npm script が cmd.exe 経由で動く。
  //   | & < > ^ は cmd がコマンドの区切り・リダイレクトとして解釈するため、
  //   引用符で囲んでいても検査プロセスが壊れることがある。
  //
  // 実際に --grep-invert "@selfcheck|@discover|@visual" が
  // パイプとして解釈され、検査が EPIPE (broken pipe) で落ちていた。
  // Linux / macOS では再現しないため、ここで見張る必要がある。
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {};
  const risky = [];
  for (const [name, command] of Object.entries(scripts)) {
    const found = [...new Set((command.match(/[|&<>^]/g) ?? []))];
    if (found.length > 0) risky.push(`${name}: ${found.join(' ')} (${command})`);
  }
  assert.deepEqual(
    risky,
    [],
    '正規表現などは npm script ではなく設定ファイル (playwright.config.ts) 側に持たせてください:\n  ' +
      risky.join('\n  '),
  );
});

await check('画面の JavaScript に呼べない関数が無い', async () => {
  // 画面を組み立てる関数を消してしまうと、通信は生きているのに
  // 画面が出ない。しかも「画面とつながっていません」と表示されるため、
  // 原因を見誤る (実際に renderNotes を消して数回の実行を無駄にした)。
  //
  // 呼んでいる関数がすべて定義されているかをここで見張る。
  const response = await fetch(base);
  const html = await response.text();
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

  // 構文が壊れていないこと
  assert.doesNotThrow(() => new Function(script), '画面の JavaScript が構文エラーでないこと');

  // render〜 / show〜 を呼んでいるなら、その関数が定義されていること
  const defined = new Set([...script.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]));
  const called = new Set([...script.matchAll(/\b((?:render|show)[A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]));
  const missing = [...called].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `呼んでいるのに定義が無い関数: ${missing.join(', ')}`);
});

await check('通信の失敗と画面の組み立ての失敗を区別する', async () => {
  // 同じ文言を出すと、サーバーが動いているのに
  // 「黒い画面が閉じている」と読んで原因を見誤る (実際に起きた)。
  const response = await fetch(base);
  const html = await response.text();
  assert.ok(html.includes('画面とつながっていません'), '通信できない場合の文言があること');
  assert.ok(html.includes('画面の表示に失敗しました'), '組み立てで失敗した場合の文言があること');
  assert.ok(
    html.includes('render(state)') && html.includes('catch (error)'),
    '画面の組み立てを別に囲んで、失敗しても通信のせいにしないこと',
  );
});

await check('検知結果が画面の状態に含まれる', async () => {
  const { body } = await json('/api/state');
  assert.ok(Array.isArray(body.findings), '検知結果の一覧が返ること');
});

await new Promise((resolve) => server.close(resolve));

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} 件の問題があります\n`);
  process.exit(1);
}
process.stdout.write('\nすべて問題ありません\n');
