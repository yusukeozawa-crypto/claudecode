#!/usr/bin/env node
/**
 * 対話式ランチャー (npm run qa / run-qa.cmd から呼ばれる)。
 *
 * 「必要なときにボタンを押して確認する」運用のための入口。
 *   - 検査対象を番号で選ぶ (練習用 / ステージング / 本番)
 *   - 初回のみ依存関係とブラウザを用意する
 *   - 検査を実行し、レポートを既定のブラウザで開く
 *
 * 日本語の表示をこちら側 (Node) に集めている。
 * .cmd ファイルに日本語を書くと文字コードによって化けるため、
 * run-qa.cmd は ASCII のみで、実質このスクリプトを呼ぶだけにしている。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

const TARGETS = [
  {
    key: '1',
    label: '練習用サイト',
    note: '対象サイト不要。ツールの動作確認用',
    task: 'test:local',
    requiresEnv: false,
  },
  {
    key: '2',
    label: 'ステージング',
    note: '.env の STAGING_BASE_URL を検査する',
    task: 'test:staging',
    requiresEnv: true,
  },
  {
    key: '3',
    label: '本番',
    note: '読み取りのみ。申込完了やデータ送信は行わない',
    task: 'test:production',
    requiresEnv: true,
  },
];

const line = '─'.repeat(60);

function print(text = '') {
  process.stdout.write(`${text}\n`);
}

/** 子プロセスを実行し、終了コードを返す (出力はそのまま画面に流す) */
function run(command, args) {
  return new Promise((resolve) => {
    const binDir = path.join(root, 'node_modules', '.bin');
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

/**
 * 入力の受け付け。
 *
 * readline は 1 回だけ生成し、受け取った行は自前のキューに溜める。
 *   - 質問ごとに readline を作り直すと、パイプ経由の入力で
 *     残りの行が失われる (stdin が閉じられる)
 *   - 質問を出す前に届いた行も取りこぼさない
 *     (パイプ経由ではまとめて届くため)
 */
function createPrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const queued = [];
  let waiting = null;
  let closed = false;

  const deliver = (value) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(value);
      return true;
    }
    return false;
  };

  rl.on('line', (raw) => {
    const value = raw.trim();
    if (!deliver(value)) queued.push(value);
  });
  rl.on('close', () => {
    closed = true;
    // 入力が閉じたら待機中の質問を空文字で決着させる (無限に待たない)
    deliver('');
  });

  return {
    ask(question) {
      process.stdout.write(question);
      if (queued.length > 0) {
        const value = queued.shift();
        process.stdout.write(`${value}\n`);
        return Promise.resolve(value);
      }
      if (closed) {
        process.stdout.write('\n');
        return Promise.resolve('');
      }
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close() {
      if (!closed) rl.close();
    },
  };
}

/** レポートを既定のアプリで開く */
async function openReport(reportPath) {
  // start は cmd の内部コマンドなので shell 経由で呼ぶ (run は win32 で shell: true)。
  // 1 つ目の "" はウィンドウタイトルの位置 (パスがタイトルと解釈されるのを防ぐ)。
  if (process.platform === 'win32') return run(`start "" "${reportPath}"`, []);
  if (process.platform === 'darwin') return run('open', [reportPath]);
  return run('xdg-open', [reportPath]);
}

async function selectTarget() {
  const preset = process.argv[2];
  if (preset) {
    const byKey = TARGETS.find((target) => target.key === preset);
    const byTask = TARGETS.find((target) => target.task === preset || target.task.endsWith(`:${preset}`));
    const target = byKey ?? byTask;
    if (target) return target;
    print(`指定された対象 "${preset}" が分かりません。番号で選び直してください。`);
  }

  print('  何を検査しますか？');
  print();
  for (const target of TARGETS) {
    print(`    ${target.key} : ${target.label} — ${target.note}`);
  }
  print();

  const prompt = createPrompt();
  try {
    return await promptForTarget(prompt);
  } finally {
    prompt.close();
  }
}

async function promptForTarget(prompt) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await prompt.ask('  番号を入力して Enter: ');
    const target = TARGETS.find((entry) => entry.key === answer);
    if (target) return target;
    if (answer === '') {
      print();
      print('  入力を受け取れませんでした。');
      print('  run-qa.cmd をダブルクリックして実行してください。');
      print('  コマンドから実行する場合は番号を渡せます: npm run qa 1');
      return null;
    }
    print('  1 / 2 / 3 のいずれかを入力してください。');
  }
  return null;
}

async function main() {
  print();
  print(line);
  print('  Webサイト公開後 自動QA');
  print(line);
  print();

  const target = await selectTarget();
  if (!target) {
    print('  中止しました。');
    return 1;
  }

  if (target.requiresEnv && !fs.existsSync(path.join(root, '.env'))) {
    print();
    print('  [設定なし] .env ファイルがありません。');
    print();
    print('    1. .env.example をコピーして .env という名前にする');
    print('    2. .env をメモ帳で開き、検査したいサイトの URL を書く');
    print();
    print('    詳しくは QUICKSTART.md を参照してください。');
    return 1;
  }

  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    print();
    print('  初回準備: 必要な部品をダウンロードします (5〜10分)');
    print();
    if ((await run('npm', ['install'])) !== 0) {
      print();
      print('  [エラー] 部品のダウンロードに失敗しました。');
      print('           ネットワークに接続されているか確認してください。');
      return 1;
    }
  }

  print();
  print('  ブラウザを確認します...');
  if ((await run('npx', ['playwright', 'install', 'chromium'])) !== 0) {
    // 既にインストール済みなら一時的な通信エラーでも検査は実行できる。
    // ここで止めると「今すぐ確認したい」ときに確認できなくなるため、
    // 警告だけ出して先に進む (本当に無い場合は検査側が明示的に失敗する)。
    print();
    print('  [警告] ブラウザの確認に失敗しました (通信エラーの可能性)。');
    print('         インストール済みならそのまま検査を続行します。');
  }

  print();
  print(line);
  print(`  ${target.label} を検査します (3〜5分)`);
  print(line);
  print();
  await run('npm', ['run', target.task]);

  const reportPath = path.join(root, 'reports', 'qa-report.html');
  print();
  print(line);
  if (!fs.existsSync(reportPath)) {
    print('  [エラー] レポートが作成されませんでした。');
    print('           上に表示されているメッセージを確認してください。');
    print(line);
    return 1;
  }
  print('  レポートを開きます。Critical / High が 0 件なら異常なしです。');
  print(`  ファイル: ${path.relative(root, reportPath)}`);
  print(line);
  if ((await openReport(reportPath)) !== 0) {
    print();
    print('  自動で開けませんでした。上のファイルをダブルクリックしてください。');
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    print();
    print(`  [エラー] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
