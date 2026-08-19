#!/usr/bin/env node
/**
 * OS 非依存で環境変数を渡して npm 依存のコマンドを実行する (cross-env の最小代替)。
 *   node scripts/with-env.mjs KEY=VALUE ... -- command [args...]
 */
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
if (separator === -1) {
  console.error('usage: node scripts/with-env.mjs KEY=VALUE ... -- command [args...]');
  process.exit(2);
}

const env = { ...process.env };
for (const assignment of argv.slice(0, separator)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(assignment);
  if (!match) {
    console.error(`環境変数の指定が不正です: ${assignment}`);
    process.exit(2);
  }
  env[match[1]] = match[2];
}

const [command, ...rest] = argv.slice(separator + 1);
if (!command) {
  console.error('実行するコマンドが指定されていません');
  process.exit(2);
}

// node_modules/.bin を PATH に加えることで playwright を直接呼べるようにする
const binDir = new URL('../node_modules/.bin', import.meta.url).pathname;
env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`;

const child = spawn(command, rest, { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
