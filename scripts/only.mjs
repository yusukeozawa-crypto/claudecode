/**
 * 指定した代理店コードだけを検査する。
 *
 *   npm run only -- littlefamily03 littlefamily42
 *   npm run only -- production littlefamily03
 *
 * 1 社だけ・数社だけをすぐ確かめたい場面のための入口。
 * 設定ファイルは書き換えず、この実行の間だけ有効にする。
 * 環境変数を自分で組み立てなくてよいようにしている
 * (PowerShell と bash で書き方が違い、間違えやすいため)。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENVIRONMENTS = ['local', 'staging', 'production'];

const args = process.argv.slice(2);
// 最初の引数が環境名ならそれを使う (省略時は既定の環境)
const environment = ENVIRONMENTS.includes(args[0]) ? args.shift() : null;
const codes = args.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);

if (codes.length === 0) {
  process.stdout.write(
    '\n  使い方: npm run only -- <代理店コード> [コード...]\n'
    + '          npm run only -- production littlefamily03 littlefamily42\n\n'
    + `  環境を省略すると既定の環境で実行します (指定できる環境: ${ENVIRONMENTS.join(' / ')})\n\n`,
  );
  process.exit(1);
}

process.stdout.write(`\n  このコードだけ検査します: ${codes.join(', ')}\n\n`);

const child = spawn('npx', ['playwright', 'test', '--grep', '@agency'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    QA_AGENCY_ONLY: codes.join(','),
    ...(environment ? { QA_ENV: environment } : {}),
  },
});
child.on('exit', (code) => process.exit(code ?? 1));
