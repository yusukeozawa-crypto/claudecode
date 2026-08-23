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
const { server, checklistOf, findingGroups, slimSummary } = await import('./ui-server.mjs');
const { buildNotes } = await import('./lib/notes.mjs');
const { buildLogic, logicMarkdown } = await import('./lib/logic.mjs');
const { parse: parseYaml } = await import('yaml');
const { parseOrigin, readEnvValues } = await import('./lib/env-file.mjs');
const os = await import('node:os');

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
  assert.deepEqual(keys, ['min', 'standard', 'wide', 'all'], '最小 / 標準 / 広め / 全件を返すこと');
  // 「全件」の件数は設定から数える (固定値だと除外リストを変えたときに古くなる)
  const all = (body.sizes ?? []).find((size) => size.key === 'all');
  assert.match(all.label, /^全件 \(\d+ 社/, '全件は実際の件数を出すこと');
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

await check('.env の読み方が検査本体と同じ (同じキーが複数行なら後の行)', () => {
  // 画面が先頭行、検査が末尾行を見ていたため、検査は動いているのに
  // 画面が「未設定」と表示していた。規則がずれていないことを固定する。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-env-'));
  try {
    fs.writeFileSync(
      path.join(dir, '.env'),
      ['PRODUCTION_APPLICATION_BASE_URL=', '# コメント', 'PRODUCTION_APPLICATION_BASE_URL=https://days.example.jp'].join('\n'),
      'utf8',
    );
    const { values, duplicates } = readEnvValues(dir);
    assert.equal(
      values.PRODUCTION_APPLICATION_BASE_URL,
      'https://days.example.jp',
      '後に書いた行を採用すること',
    );
    assert.deepEqual(duplicates, ['PRODUCTION_APPLICATION_BASE_URL'], '重複したキーを知らせること');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('画面に出す URL はドメインまで (設定のパスと二重にしない)', () => {
  // .env にパスまで入っている環境があり、設定側のパスとつながって
  // https://host/lp/service/lp/service/ と表示されていた。
  const parsed = parseOrigin('https://lp.example.jp/lp/service');
  assert.equal(parsed.origin, 'https://lp.example.jp', 'ドメインだけを取り出すこと');
  assert.equal(parsed.droppedPath, '/lp/service', '落としたパスを知らせること');
});

await check('途中の結果と確定した結果を区別できる', () => {
  // 全件の検査は 1 時間を超える。途中で止まったときに
  // 「ここまでは確認できた」を残す一方、それを確定した結果と
  // 読ませてはいけない。
  const running = slimSummary({ partial: true, tests: {}, findings: {} });
  assert.equal(running.partial, true, '途中の結果であることを画面に伝えること');
  const done = slimSummary({ tests: {}, findings: {} });
  assert.equal(done.partial, false, '確定した結果では立てないこと');
  assert.equal(slimSummary(null), null, 'レポートが無くても壊れないこと');

  const html = fs.readFileSync(path.join(root, 'scripts', 'ui', 'index.html'), 'utf8');
  assert.ok(html.includes('実行中の途中結果'), '途中の結果だと画面に出すこと');
});

await check('中断 (スリープ) があったら結果を信用しないよう伝える', () => {
  // スリープのあとは正常なサイトでもタイムアウトが大量に出る。
  // 「異常なし」でも結果自体が信用できないことを先に伝える必要がある。
  const withGap = slimSummary({
    tests: {}, findings: {},
    interruptions: [{ at: '2026-08-23T07:00:00.000Z', minutes: 42 }],
  });
  assert.equal(withGap.interruptions.length, 1, '中断を画面に伝えること');
  assert.deepEqual(slimSummary({ tests: {}, findings: {} }).interruptions, [], '無ければ空にすること');

  const html = fs.readFileSync(path.join(root, 'scripts', 'ui', 'index.html'), 'utf8');
  assert.ok(html.includes('interrupt-notice'), '中断の警告を出す場所があること');
  assert.ok(html.includes('この結果は信用できません'), '結果を信用しないよう書くこと');
  // 判定より前に出す (先に目に入らないと意味がない)
  assert.ok(
    html.indexOf('interrupt-notice') < html.indexOf('id="verdict"'),
    '判定より前に出すこと',
  );
});

await check('全件のときだけスリープの注意とコマンドを出す', () => {
  // 電源設定はツールでは変更しない。システム設定を書き換えると
  // ツールが落ちたときに戻せず、スリープしないパソコンが残る。
  const html = fs.readFileSync(path.join(root, 'scripts', 'ui', 'index.html'), 'utf8');
  assert.ok(html.includes('sleep-notice'), 'スリープの注意を出す場所があること');
  assert.ok(html.includes('powercfg /change standby-timeout-ac 0'), '止める側のコマンドを出すこと');
  assert.ok(html.includes('powercfg /change standby-timeout-ac 30'), '戻す側のコマンドも出すこと');
  assert.ok(html.includes("sizeSelect.value !== 'all'"), '全件のときだけ出すこと');
  // ツール自身が powercfg を実行してはいけない
  const server = fs.readFileSync(path.join(root, 'scripts', 'ui-server.mjs'), 'utf8');
  assert.ok(!/powercfg/.test(server), 'ツールが電源設定を変更しないこと');
});

await check('CSV の書き出しは固定リストの操作として実行する', () => {
  const server = fs.readFileSync(path.join(root, 'scripts', 'ui-server.mjs'), 'utf8');
  assert.ok(/export: \{ label: .+script: 'export' \}/.test(server), 'export が固定リストにあること');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.export, 'node scripts/export-csv.mjs', 'npm script があること');
  const html = fs.readFileSync(path.join(root, 'scripts', 'ui', 'index.html'), 'utf8');
  assert.ok(html.includes('data-action="export"'), '画面にボタンがあること');
});

await check('CSV は Excel で開いても日本語が壊れない', () => {
  // BOM が無いと Excel が文字化けする。CSV の意味が無くなる。
  const script = fs.readFileSync(path.join(root, 'scripts', 'export-csv.mjs'), 'utf8');
  assert.ok(script.includes('\ufeff'), 'BOM を付けること');
  assert.ok(/\\r\\n/.test(script), '改行を CRLF にすること');
  // = で始まる値を数式として実行させない
  assert.ok(/\[=\+\\-@\]/.test(script), '数式として解釈される値を打ち消すこと');
});

await check('検査が終わると CSV も自動で作られる', () => {
  // JSON は機械が読む形なので、そのままでは表計算で開けない。
  // 毎回 CSV も作っておかないと「あとで書き出す」手間が残る。
  const reporter = fs.readFileSync(path.join(root, 'reporters', 'qa-html-reporter.ts'), 'utf8');
  assert.ok(reporter.includes('export-csv.mjs'), 'レポート生成時に CSV も作ること');
  assert.ok(reporter.includes('CSV (Excel用)'), '作った場所を画面に出すこと');
  // 同じ処理を 2 か所に持たない (片方が必ず古くなる)
  assert.ok(!/anshinPack|checklist\.csv.*headers/.test(reporter), 'CSV の組み立てを二重に持たないこと');
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

await check('ロジックの説明が検査の実行前でも出る', async () => {
  // 「どういうロジックですか」と聞かれたときに出すものなので、
  // 検査結果ではなく設定ファイルから作る (実行していなくても出る)。
  const logic = buildLogic(root);
  assert.deepEqual(
    logic.tabs.map((tab) => tab.id),
    ['simple', 'detail', 'limits'],
    '簡易 / 詳細 / 限界と前提 の 3 つを返すこと',
  );
  for (const tab of logic.tabs) {
    assert.ok(tab.label, 'タブ名があること');
    assert.ok(tab.blocks.length > 0, `${tab.label} に中身があること`);
    for (const block of tab.blocks) {
      assert.ok(block.title, '見出しがあること');
      assert.ok(
        (block.lines ?? []).length > 0 || block.table,
        `${block.title} に本文か表があること`,
      );
    }
  }
  // 実行中に変わらないものなので、数秒ごとの状態とは別の口から取る
  const { body } = await json('/api/logic');
  assert.ok(body.logic && Array.isArray(body.logic.tabs), '画面がロジックを取得できること');
  const { body: state } = await json('/api/state');
  assert.equal(state.logic, undefined, '数秒ごとの通信にロジックを混ぜないこと');
  const html = await (await fetch(base)).text();
  assert.ok(html.includes('logic-section'), 'ロジックの節を持つこと');
  assert.ok(html.includes('data-logic-tab'), 'タブで切り替えられること');
  assert.ok(html.includes('data-action="logic"'), '書き出しボタンがあること');
  assert.ok(html.includes("fetch('/api/logic')"), '画面が別の口から取ること');
});

await check('ロジックの説明は設定から作る (書き写さない)', () => {
  // 説明を手で書くと、設定を変えたときに説明だけが古くなる。
  // 古い説明を人に渡すと、そこを突かれて全体が信用されなくなる。
  const markdown = logicMarkdown(buildLogic(root));
  const agency = parseYaml(fs.readFileSync(path.join(root, 'config', 'agency.yml'), 'utf8'));
  const devices = parseYaml(fs.readFileSync(path.join(root, 'config', 'devices.yml'), 'utf8'));
  const runtime = parseYaml(fs.readFileSync(path.join(root, 'config', 'runtime.yml'), 'utf8'));

  assert.ok(markdown.includes(agency.paramName), 'URL パラメータ名が設定と同じであること');
  for (const keyword of agency.agencyNameTexts.anshinPack) {
    assert.ok(markdown.includes(keyword), `安心パックの判定語が出ること: ${keyword}`);
  }
  for (const entry of agency.agencyNameTexts.anshinPackAlwaysForbidden ?? []) {
    assert.ok(markdown.includes(entry.text), `固定で違反にする文言が出ること: ${entry.text}`);
    assert.ok(markdown.includes(entry.reason), 'そう決めた理由も一緒に出ること');
  }
  for (const device of devices.devices) {
    assert.ok(
      markdown.includes(`${device.viewport.width}×${device.viewport.height}`),
      `端末の大きさが設定と同じであること: ${device.id}`,
    );
  }
  for (const severity of runtime.failOnSeverities) {
    assert.ok(markdown.includes(severity), `失敗にする重大度が出ること: ${severity}`);
  }
  // 検査項目はチェックリストの列 (utils/checklist.ts) と同じであること
  const source = fs.readFileSync(path.join(root, 'utils', 'checklist.ts'), 'utf8');
  const block = source.match(/CHECK_COLUMNS[^=]*=\s*\[([\s\S]*?)\];/)[1];
  const labels = [...block.matchAll(/label:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(labels.length > 0, 'チェックリストの列を読み取れること');
  for (const label of labels) {
    assert.ok(markdown.includes(label), `検査項目が説明に出ること: ${label}`);
  }
});

await check('ロジックの説明に「分からないこと」が書いてある', () => {
  // 限界を隠した説明を渡すと、読んだ人 (や AI) に穴を突かれて
  // 全体が信用されなくなる。先に書いておく。
  const limits = buildLogic(root).tabs.find((tab) => tab.id === 'limits');
  const written = limits.blocks
    .map((block) => `${block.title} ${(block.lines ?? []).join(' ')}`)
    .join('\n');
  for (const phrase of [
    '抽選',               // 毎回全件を見ていない
    'A/B',                // 片方しか見ていない
    '検知できません',     // 語を含まない訴求文
    '読み取り専用',       // 本番では送信を伴う確認をしない
    '証拠ではありません', // コード保持は有効なコードの証拠ではない
    'スリープ',           // 中断された実行は信用しない
  ]) {
    assert.ok(written.includes(phrase), `限界の説明に含まれること: ${phrase}`);
  }
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
