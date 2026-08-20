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
const { server, agencySummary, findingGroups } = await import('./ui-server.mjs');

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
  assert.ok(Array.isArray(body.targets) && body.targets.length === 3, '検査対象が 3 つ返ること');
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

await check('代理店ごとの一覧をまとめられる', () => {
  const summary = agencySummary([
    { agencyCode: 'A001', findings: [] },
    {
      agencyCode: 'A002',
      findings: [
        { category: 'agency-display', severity: 'medium', agencyCode: 'A002' },
        { category: 'agency-redirect', severity: 'critical', agencyCode: 'A002' },
      ],
    },
    { agencyCode: 'none', findings: [{ category: 'js-error', severity: 'high' }] },
  ]);
  const codes = summary.rows.map((row) => row.code);
  assert.deepEqual(codes, ['A002', 'A001'], '重い方を先に並べること (none は含めない)');
  const a002 = summary.rows[0];
  assert.equal(a002.cells.redirect, 'critical');
  assert.equal(a002.counts.display, 1);
  const a001 = summary.rows[1];
  assert.equal(a001.cells.display, null, '検知が無ければ OK (null) にすること');
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
