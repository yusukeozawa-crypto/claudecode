#!/usr/bin/env node
/**
 * ツール自身を最新版に更新する (Git を使わない環境向け)。
 *
 *   npm run update
 *
 * GitHub からブランチの ZIP を取得し、いま使っているフォルダのファイルを
 * 上書きする。次のものは触らない (消さない・上書きしない):
 *   .env            対象サイトの URL / 認証情報
 *   node_modules    インストール済みのライブラリ
 *   reports         これまでの検査結果
 *   screenshots     取得済みのスクリーンショット
 *
 * 更新後は依存関係の取得 (npm install) まで自動で行う。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withBinPath } from './lib/env-path.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const OWNER = process.env.QA_UPDATE_OWNER || 'yusukeozawa-crypto';
const REPO = process.env.QA_UPDATE_REPO || 'claudecode';
const BRANCH = process.env.QA_UPDATE_BRANCH || 'claude/playwright-qa-tool-32f7p6';

/** 上書きせずに残すもの (フォルダ直下の名前で判定する) */
const KEEP = new Set(['.env', 'node_modules', 'reports', 'screenshots', '.git']);
/**
 * フォルダの中で個別に残すファイル。
 *   config/ は新しい版で置き換えるが、画面から保存した上書き設定
 *   (config/overrides.yml) は運用側の判断なので消してはいけない。
 */
const KEEP_FILES = new Set(['config/overrides.yml', 'config/overrides.yml.bak']);

function print(text = '') {
  process.stdout.write(`${text}\n`);
}

/** ここが本当にこのツールのフォルダかを確認する (別フォルダを壊さないため) */
function assertToolRoot() {
  const packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error(`package.json が見つかりません: ${packagePath}`);
  const name = JSON.parse(fs.readFileSync(packagePath, 'utf8')).name;
  if (name !== 'web-release-qa') throw new Error(`このフォルダは検査ツールではありません (name=${name})`);
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`ダウンロードに失敗しました (HTTP ${response.status}): ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);
  return buffer.length;
}

/** OS 標準の機能で ZIP を展開する (追加インストール不要にするため) */
function extract(zipPath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result =
    process.platform === 'win32'
      ? spawnSync(
          'powershell',
          ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destination}" -Force`],
          { stdio: 'inherit' },
        )
      : spawnSync('unzip', ['-q', '-o', zipPath, '-d', destination], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('ZIP の展開に失敗しました');
}

/** 展開結果の中身 (単一のフォルダ) を返す */
function extractedRoot(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.length !== 1) throw new Error(`展開結果の形が想定と違います (フォルダ ${entries.length} 件)`);
  return path.join(directory, entries[0].name);
}

/** source の中身を target へ上書きコピーする (KEEP / KEEP_FILES は触らない) */
function copyInto(source, target, depth = 0, prefix = '') {
  let files = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (depth === 0 && KEEP.has(entry.name)) continue;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    // 画面から保存した上書き設定は、新しい版に同名のファイルが
    // あっても上書きしない (運用側の判断を消さないため)
    if (KEEP_FILES.has(relative)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      files += copyInto(from, to, depth + 1, relative);
    } else {
      fs.copyFileSync(from, to);
      files += 1;
    }
  }
  return files;
}

async function main() {
  assertToolRoot();
  const url = `https://github.com/${OWNER}/${REPO}/archive/refs/heads/${BRANCH}.zip`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-update-'));
  const zipPath = path.join(work, 'update.zip');

  print('検査ツールを最新版に更新します。');
  print(`  取得元 : ${OWNER}/${REPO} (${BRANCH})`);
  print(`  更新先 : ${root}`);
  print('  .env / reports / screenshots / config/overrides.yml はそのまま残ります。');
  print();

  print('1/3 ダウンロード中...');
  const size = await download(url, zipPath);
  print(`    ${(size / 1024 / 1024).toFixed(1)} MB を取得しました`);

  print('2/3 展開して上書き中...');
  const extractDir = path.join(work, 'extracted');
  extract(zipPath, extractDir);
  const files = copyInto(extractedRoot(extractDir), root);
  print(`    ${files} 個のファイルを更新しました`);

  print('3/3 ライブラリを更新中 (npm install)...');
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: withBinPath(path.join(root, 'node_modules', '.bin')),
  });

  fs.rmSync(work, { recursive: true, force: true });

  if (install.status !== 0) {
    print();
    print('[エラー] npm install に失敗しました。上のメッセージを確認してください。');
    return 1;
  }

  print();
  print('更新が完了しました。');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    print();
    print(`[エラー] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
