#!/usr/bin/env node
/**
 * 基準画像の更新 (npm run update:screenshots)。
 *
 * 基準画像はフォント描画に依存するため、作成した OS 以外では差分が出る。
 * 複数人が各自の PC で更新すると、コミットするたびに他のメンバーと CI で
 * 差分が出る状態になる (更新合戦になる)。
 *
 * そのため既定では CI と同じ Linux 以外での更新を止める。
 * どうしても手元で更新する場合は --force を付ける
 * (その基準画像はコミットしないこと)。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASELINE_PLATFORM = 'linux';
const args = process.argv.slice(2);
const forced = args.includes('--force');
const passthrough = args.filter((arg) => arg !== '--force');

if (process.platform !== BASELINE_PLATFORM && !forced) {
  console.error('');
  console.error('基準画像の更新を中止しました。');
  console.error('');
  console.error(`  現在の OS       : ${process.platform}`);
  console.error(`  基準画像の OS   : ${BASELINE_PLATFORM} (CI と同じ環境)`);
  console.error('');
  console.error('基準画像はフォント描画に依存するため、CI と異なる OS で更新すると');
  console.error('他のメンバーと CI で差分が出続けます (更新合戦になります)。');
  console.error('');
  console.error('推奨手順:');
  console.error('  1. 見た目の変更をコミットして push する');
  console.error('  2. CI (self-test) の Artifact から screenshots/baseline を取得する');
  console.error('  3. それをコミットする');
  console.error('');
  console.error('手元の確認用に更新する場合 (コミットしないこと):');
  console.error('  npm run update:screenshots -- --force');
  console.error('');
  process.exit(1);
}

if (forced && process.platform !== BASELINE_PLATFORM) {
  console.warn('');
  console.warn(`警告: ${process.platform} で基準画像を更新します。`);
  console.warn('この基準画像はコミットしないでください (CI と差分が出ます)。');
  console.warn('');
}

const binDir = path.join(fileURLToPath(new URL('..', import.meta.url)), 'node_modules', '.bin');
const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` };

const child = spawn(
  'playwright',
  ['test', '--grep', '@visual', '--update-snapshots', ...passthrough],
  { stdio: 'inherit', env, shell: process.platform === 'win32' },
);

child.on('exit', (code) => process.exit(code ?? 1));
