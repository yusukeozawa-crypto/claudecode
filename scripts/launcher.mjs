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
import { withBinPath } from './lib/env-path.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

const TARGETS = [
  {
    key: '1',
    label: '練習用サイト',
    note: '対象サイト不要。ツールの動作確認用',
    task: 'test:local',
    prefix: null,
  },
  {
    key: '2',
    label: 'ステージング',
    note: '検査対象の URL を .env から読む',
    task: 'test:staging',
    prefix: 'STAGING',
  },
  {
    key: '3',
    label: '本番',
    note: '読み取りのみ。申込完了やデータ送信は行わない',
    task: 'test:production',
    prefix: 'PRODUCTION',
  },
];

const ENV_PATH = path.join(root, '.env');
const ENV_EXAMPLE_PATH = path.join(root, '.env.example');

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
      env: withBinPath(binDir),
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

/**
 * .env の読み取り。utils/config.ts の loadDotEnv と同じ書式を想定する
 * (KEY=VALUE、# はコメント、値の前後の引用符は取り除く)。
 */
function readEnvFile() {
  const values = new Map();
  if (!fs.existsSync(ENV_PATH)) return values;
  for (const rawLine of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    values.set(key, value);
  }
  return values;
}

/**
 * .env の値を書き換える。
 * 既存の行はコメントごと残し、該当キーの行だけ差し替える
 * (手で書いた設定やコメントを消さないため)。
 * ファイルが無い場合は .env.example を雛形にする。
 */
function writeEnvValues(updates) {
  let lines;
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  } else if (fs.existsSync(ENV_EXAMPLE_PATH)) {
    lines = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8').split(/\r?\n/);
  } else {
    lines = [];
  }

  const remaining = new Map(Object.entries(updates));
  const rewritten = lines.map((line) => {
    const match = /^(\s*)([A-Z0-9_]+)\s*=/.exec(line);
    if (!match) return line;
    const key = match[2];
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of remaining) rewritten.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, `${rewritten.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

/**
 * 入力された URL からドメイン部分 (オリジン) だけを取り出す。
 *
 * .env に入れるのはドメインまで。検査するページのパスは
 * config/pages.yml が持つため、パスを含めて入れると二重になり
 * 「どこを検査しているのか」が分かりにくくなる。
 */
function parseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const droppedPath = url.pathname !== '/' && url.pathname !== '' ? url.pathname : null;
  const droppedQuery = url.search !== '' ? url.search : null;
  return { origin: url.origin, droppedPath, droppedQuery };
}

/**
 * URL を 1 件聞く (不正な形式はやり直し)。
 * optional: true の場合は空入力を「設定しない」として受け付ける。
 */
async function askUrl(prompt, label, current, pathOwner, optional = false) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hint = current ? ` [現在: ${current}]` : optional ? ' [任意]' : '';
    const answer = await prompt.ask(`    ${label}${hint}: `);
    if (answer === '' && current) return current;
    if (answer === '' && optional) return '';
    const parsed = answer === '' ? null : parseOrigin(answer);
    if (parsed) {
      if (parsed.droppedPath || parsed.droppedQuery) {
        // 黙って捨てると「入れたのに使われていない」と誤解されるため必ず伝える
        print(`      → ドメイン部分のみを使用します: ${parsed.origin}`);
        if (parsed.droppedPath) {
          print(`         ${parsed.droppedPath} は ${pathOwner} 側で管理します`);
        }
      }
      return parsed.origin;
    }
    if (answer === '') {
      print(optional ? '    URL か、空のまま Enter を入力してください。' : '    URL を入力してください。');
    } else {
      print('    https:// または http:// から始まる URL を入力してください。');
    }
  }
  return null;
}

/**
 * 検査対象の URL・認証情報が .env に揃っているか確認し、
 * 足りなければその場で聞いて .env に書き込む。
 *
 * Windows のエクスプローラーでは「.env」という名前のファイルを作れないため、
 * 手作業で用意させずここで作れるようにしている。
 */
async function ensureEnvConfigured(target, prompt) {
  if (!target.prefix) return true;

  const lpKey = `${target.prefix}_BASE_URL`;
  const appKey = `${target.prefix}_APPLICATION_BASE_URL`;
  const userKey = `${target.prefix}_BASIC_USER`;
  const passKey = `${target.prefix}_BASIC_PASS`;

  const current = readEnvFile();
  // 申込ページの URL は任意 (申込導線の検査は代理店設定が入るまで行わない)
  if (current.get(lpKey)) return true;

  print();
  print(line);
  print(`  ${target.label} の設定がありません。ここで作成できます。`);
  print(line);
  print();
  print('  入力する内容:');
  print('    ・LP の URL         例) https://staging.example.jp');
  print('    ・申込ページの URL  申込導線を検査する場合のみ。不要なら空のまま Enter');
  print('    ・Basic 認証の ID とパスワード (不要なら空のまま Enter)');
  print();
  print('  入力した内容は .env に保存されます (Git にはコミットされません)。');
  print('  ※ パスワードは入力中に画面に表示されます。画面共有中は注意してください。');
  print('  ※ 手で用意する場合は .env.example をコピーして .env にしてください。');
  print();

  const answer = await prompt.ask('  いま設定しますか？ (y = はい / n = やめる): ');
  if (!/^y(es)?$/i.test(answer)) {
    print();
    print('  中止しました。設定してから再度実行してください。');
    return false;
  }

  print();
  const lpUrl = await askUrl(
    prompt,
    'LP の URL',
    current.get(lpKey),
    '検査するページの設定 (config/pages.yml)',
  );
  if (!lpUrl) {
    print('    入力を確認できませんでした。中止します。');
    return false;
  }
  // 申込導線の検査は代理店設定 (application) が入るまで行わないため、
  // 申込ページの URL は任意にしている。
  const appUrl = await askUrl(
    prompt,
    '申込ページの URL',
    current.get(appKey),
    '代理店ごとの申込設定 (application.expectedPath)',
    true,
  );
  if (appUrl === null) {
    print('    入力を確認できませんでした。中止します。');
    return false;
  }

  print();
  print('    Basic 認証 (ブラウザのポップアップで ID を聞かれる方式)');
  print('    不要な場合は何も入力せず Enter を押してください。');
  const basicUser = await prompt.ask('    ID: ');
  const basicPass = basicUser === '' ? '' : await prompt.ask('    パスワード: ');

  const updates = { [lpKey]: lpUrl };
  if (appUrl !== '') updates[appKey] = appUrl;
  if (basicUser !== '') {
    updates[userKey] = basicUser;
    updates[passKey] = basicPass;
  }
  writeEnvValues(updates);

  print();
  print('  .env を保存しました。');
  print(`    ${lpKey}=${lpUrl}`);
  print(`    ${appKey}=${appUrl === '' ? '(未設定 — 申込導線の検査は行いません)' : appUrl}`);
  if (basicUser !== '') {
    print(`    ${userKey}=${basicUser}`);
    print(`    ${passKey}=${'*'.repeat(Math.min(basicPass.length, 12))} (画面には表示しません)`);
  } else {
    print('    Basic 認証: なし');
  }
  print();
  print('  内容を変えたい場合は .env をメモ帳で開いて編集できます。');
  return true;
}

/** レポートを既定のアプリで開く */
async function openReport(reportPath) {
  // start は cmd の内部コマンドなので shell 経由で呼ぶ (run は win32 で shell: true)。
  // 1 つ目の "" はウィンドウタイトルの位置 (パスがタイトルと解釈されるのを防ぐ)。
  if (process.platform === 'win32') return run(`start "" "${reportPath}"`, []);
  if (process.platform === 'darwin') return run('open', [reportPath]);
  return run('xdg-open', [reportPath]);
}

async function selectTarget(prompt) {
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

  return promptForTarget(prompt);
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

  const prompt = createPrompt();
  let target;
  try {
    target = await selectTarget(prompt);
    if (!target) {
      print('  中止しました。');
      return 1;
    }
    if (!(await ensureEnvConfigured(target, prompt))) return 1;
  } finally {
    // 以降は子プロセスが stdin を使うため、ここで入力を手放す
    prompt.close();
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
