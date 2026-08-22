#!/usr/bin/env node
/**
 * ブラウザで操作する画面 (ローカル Web UI)。
 *
 *   npm run ui   → http://127.0.0.1:4180 を開く
 *
 * 黒い画面を見ずに次のことができる:
 *   - 検査したい環境を選んでボタンで実行
 *   - 進行状況を日本語で表示 (いま何を確認しているか)
 *   - 終わったら結論 (異常なし / 問題あり) と代理店ごとの一覧を表示
 *   - 過去の実行履歴を一覧
 *   - ツール自身の更新
 *
 * 外部ライブラリは使わない (Node 標準の http のみ)。
 * 127.0.0.1 のみで待ち受ける (他の端末からは見えない)。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withBinPath } from './lib/env-path.mjs';
import { parseOrigin, writeEnvValues } from './lib/env-file.mjs';
import { buildNotes } from './lib/notes.mjs';
import { parse as parseYaml } from 'yaml';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPORT_DIR = path.join(root, 'reports');
const HISTORY_DIR = path.join(REPORT_DIR, 'history');
const PROGRESS_PATH = path.join(REPORT_DIR, 'progress.json');
const UI_PATH = path.join(root, 'scripts', 'ui', 'index.html');
const PORT = Number(process.env.QA_UI_PORT ?? 4180);

/** 実行できる検査。npm script 名は固定リストからしか選べない (任意のコマンドは実行させない) */
//   練習用サイト (ローカルモック) は画面には出さない。
//   ツール自身の動作確認用で、対象サイトの品質とは関係がないため。
//   必要なときは黒い画面で npm run test:local を実行する。
const TARGETS = {
  staging: { label: 'ステージング', script: 'test:staging', note: '.env の STAGING_BASE_URL を検査する' },
  production: { label: '本番', script: 'test:production', note: '読み取りのみ。申込完了やデータ送信は行わない' },
};

/**
 * 検査の入口になる LP のパス。
 *
 *   .env にはドメインだけを保存する (ページのパスは設定ファイルが持つ)。
 *   ただし画面にドメインだけを出すと「検査しているのは本当にあの LP か」が
 *   分からない。実際に開く URL を出す。
 */
function lpEntryPath() {
  try {
    const file = path.join(root, 'config', 'agencies.yml');
    const parsed = parseYaml(fs.readFileSync(file, 'utf8')) ?? {};
    return parsed.noCodeExpectation?.entryPath ?? '/';
  } catch {
    return '/';
  }
}

/** 環境ごとの .env のキー名 */
const ENV_KEYS = {
  staging: { base: 'STAGING_BASE_URL', application: 'STAGING_APPLICATION_BASE_URL', user: 'STAGING_BASIC_USER', pass: 'STAGING_BASIC_PASS' },
  production: { base: 'PRODUCTION_BASE_URL', application: 'PRODUCTION_APPLICATION_BASE_URL', user: 'PRODUCTION_BASIC_USER', pass: 'PRODUCTION_BASIC_PASS' },
};

/**
 * 検査する代理店の件数。
 *   導入中は「最小」で動作を確定させ、問題がなくなってから増やす。
 *   設定ファイルを書き換えず、実行ごとに選べるようにしている。
 */
const SIZES = {
  min: { label: '最小 (パターンごと 1 社)', env: { QA_AGENCY_PER_PROFILE: '1' } },
  standard: { label: '標準 (パターンごと 3 社)', env: { QA_AGENCY_PER_PROFILE: '3' } },
  all: { label: '全件 (211 社・時間がかかります)', env: { QA_AGENCY_SCOPE: 'all' } },
};

/** 検査以外の操作 */
const ACTIONS = {
  update: { label: '最新版に更新', script: 'update' },
  'discover-staging': { label: '仕様調査 (ステージング)', script: 'discover:staging' },
  'discover-production': { label: '仕様調査 (本番)', script: 'discover:production' },
};

/** いま動いている子プロセス (同時に 1 つだけ) */
let current = null;
/** 直近の実行ログ (画面に出す。長くなりすぎないよう末尾のみ保持) */
let logLines = [];
/**
 * 更新後に再起動が必要かどうか。
 *   画面を開いたまま更新すると、画面 (HTML) は新しくなるが
 *   動いているサーバーは古いままになる。食い違いに気づけるよう画面に出す。
 */
let restartRequired = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * .env の設定状況。
 *   URL は画面に出す (確認のため)。
 *   ベーシック認証のユーザー名・パスワードは **返さない** (設定済みかどうかだけ)。
 */
function envStatus() {
  const envPath = path.join(root, '.env');
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const read = (key) => {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    const value = match ? match[1].trim() : '';
    return value === '' ? null : value;
  };
  const status = {};
  for (const [target, keys] of Object.entries(ENV_KEYS)) {
    const base = read(keys.base);
    status[target] = {
      configured: Boolean(base),
      baseUrl: base,
      applicationBaseUrl: read(keys.application),
      hasCredentials: Boolean(read(keys.user)),
    };
  }
  return status;
}

/** 画面から送られた設定を .env に保存する */
function saveEnv(target, body) {
  const keys = ENV_KEYS[target];
  if (!keys) return { ok: false, error: '不明な環境です' };

  const parsed = parseOrigin(String(body.baseUrl ?? '').trim());
  if (!parsed) return { ok: false, error: 'URL は https://example.jp の形式で入力してください' };

  const updates = { [keys.base]: parsed.origin };
  const applicationInput = String(body.applicationBaseUrl ?? '').trim();
  if (applicationInput !== '') {
    const application = parseOrigin(applicationInput);
    if (!application) return { ok: false, error: '申込サイトの URL の形式が正しくありません' };
    updates[keys.application] = application.origin;
  }
  // 空欄で送られた認証情報は「変更しない」(既存の値を消さない)
  const user = String(body.basicUser ?? '').trim();
  const pass = String(body.basicPass ?? '');
  if (user !== '') updates[keys.user] = user;
  if (pass !== '') updates[keys.pass] = pass;

  writeEnvValues(root, updates);
  return {
    ok: true,
    droppedPath: parsed.droppedPath,
    saved: parsed.origin,
  };
}

function historyList() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs
    .readdirSync(HISTORY_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 20)
    .map((name) => {
      const summary = readJson(path.join(HISTORY_DIR, name));
      if (!summary) return null;
      return {
        file: name,
        startedAt: summary.startedAt,
        environment: summary.environment,
        environmentLabel: summary.environmentLabel,
        tests: summary.tests,
        findings: summary.findings,
        gateFailed: summary.gateFailed,
      };
    })
    .filter(Boolean);
}

/**
 * チェックリスト表 (行 = 代理店 / 列 = 検査項目)。
 *
 * 計算はレポート側 (utils/checklist.ts) が行い、
 * その結果を qa-report.json の summary.checklist に書き出している。
 * 画面はそれをそのまま表示する。同じ計算を 2 か所に持つと、
 * レポートと画面で違う結果が出て「どちらが正しいのか」が分からなくなる。
 */
/** 備考。設定が壊れていても画面を落とさない */
function notesOrEmpty() {
  try {
    return buildNotes(root);
  } catch {
    return [];
  }
}

/**
 * 画面に渡す要約。
 *
 * レポートの summary には代理店 211 社の一覧 (agencyMeta) と
 * チェックリストが入っており、そのまま送ると 1 回で 90KB を超える。
 * 画面はこれを数秒ごとに取りに来るため、通信が詰まって
 * 「画面とつながっていません」と出ることがある。
 *
 * 画面が実際に使う項目だけに絞る。
 * 会社名と みらやく掲載可否はチェックリストの各行が持っているので、
 * 一覧を別に送る必要はない。
 */
function slimSummary(summary) {
  if (!summary) return null;
  return {
    generatedAt: summary.generatedAt,
    startedAt: summary.startedAt,
    environment: summary.environment,
    environmentLabel: summary.environmentLabel,
    baseUrl: summary.baseUrl,
    tests: summary.tests,
    findings: summary.findings,
    gateFailed: summary.gateFailed,
  };
}

export function checklistOf(report) {
  const checklist = report?.summary?.checklist;
  if (!checklist || !Array.isArray(checklist.columns) || !Array.isArray(checklist.tables)) {
    return { columns: [], tables: [], missingPatterns: [] };
  }
  return { missingPatterns: [], ...checklist };
}
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

/**
 * 検知結果を「同じ内容」でまとめる (画面に出す用)。
 *
 * PC と SP、複数の代理店で同じ問題が出ると同じ行が並ぶため、
 * 内容が同じものは 1 件にまとめ、端末と代理店を並べて示す。
 * 画面で対応を判断できるだけの情報 (期待・実際・再現URL) を持たせる。
 */
export function findingGroups(records, limit = 200) {
  const groups = new Map();
  for (const record of records) {
    for (const finding of record.findings ?? []) {
      const key = [finding.severity, finding.category, finding.title, finding.expected, finding.actual].join('|');
      let group = groups.get(key);
      if (!group) {
        group = {
          severity: finding.severity,
          category: finding.category,
          title: finding.title,
          expected: finding.expected ?? null,
          actual: finding.actual ?? null,
          detail: finding.detail ?? null,
          url: finding.url,
          devices: [],
          agencies: [],
          pages: [],
          count: 0,
        };
        groups.set(key, group);
      }
      group.count += 1;
      const push = (list, value) => {
        if (value && !list.includes(value)) list.push(value);
      };
      push(group.devices, finding.deviceId ?? record.deviceId);
      push(group.agencies, finding.agencyCode ?? record.agencyCode);
      push(group.pages, finding.pageName ?? finding.pageId ?? record.pageName);
    }
  }
  return [...groups.values()]
    .sort((a, b) => {
      const order = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
      return order !== 0 ? order : b.count - a.count;
    })
    .slice(0, limit);
}

function state() {
  const report = readJson(path.join(REPORT_DIR, 'qa-report.json'));
  return {
    running: Boolean(current),
    runningLabel: current?.label ?? null,
    progress: readJson(PROGRESS_PATH),
    summary: slimSummary(report?.summary),
    checklist: checklistOf(report),
    // 保留事項 / 後日確認 / 後日仕様変更。
    // 設定ファイルから直接作るので、検査を 1 回も実行していなくても出る
    notes: notesOrEmpty(),
    findings: report ? findingGroups(report.records ?? []) : [],
    log: logLines.slice(-40),
    targets: Object.entries(TARGETS).map(([key, value]) => ({ key, ...value })),
    // 実際に開く LP のパス (画面で URL をそのまま見せるため)
    lpPath: lpEntryPath(),
    sizes: Object.entries(SIZES).map(([key, value]) => ({ key, label: value.label })),
    restartRequired,
    env: envStatus(),
    history: historyList(),
    hasReport: fs.existsSync(path.join(REPORT_DIR, 'qa-report.html')),
  };
}

/** npm script を実行する。script 名は固定リストのみ */
function startRun(kind, key, size = 'min') {
  if (current) return { ok: false, error: 'すでに実行中です' };
  const entry = kind === 'test' ? TARGETS[key] : ACTIONS[key];
  if (!entry) return { ok: false, error: '不明な操作です' };
  const sizeEntry = SIZES[size];
  if (!sizeEntry) return { ok: false, error: '不明な件数の指定です' };

  logLines = [`[開始] ${entry.label}`];
  // 前回の進行状況を消す (古い結果が残って混乱しないように)
  fs.rmSync(PROGRESS_PATH, { force: true });

  const child = spawn('npm', ['run', entry.script], {
    cwd: root,
    // 件数の指定は環境変数で渡す (設定ファイルは書き換えない)
    env: { ...withBinPath(path.join(root, 'node_modules', '.bin')), ...(kind === 'test' ? sizeEntry.env : {}) },
    shell: process.platform === 'win32',
    // 「止める」で確実に停止させるため、子孫まとめて終了できるようにする
    // (npm だけを終了しても、その先の検査プロセスが残ってしまう)
    detached: process.platform !== 'win32',
  });
  current = { child, key, label: entry.label, startedAt: new Date().toISOString() };

  const append = (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      // 端末の色指定 (エスケープシーケンス) は画面では読めないため落とす
      const trimmed = line.replace(/\[[0-9;]*m/g, '').trimEnd();
      if (trimmed !== '') logLines.push(trimmed);
    }
    if (logLines.length > 400) logLines = logLines.slice(-400);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', (code) => {
    logLines.push(`[終了] ${entry.label} (終了コード ${code})`);
    // 更新後は古いサーバーが動き続けるため、開き直しが必要
    if (kind === 'action' && key === 'update' && code === 0) {
      restartRequired = true;
      logLines.push('[要再起動] 黒い画面を閉じて run-qa をもう一度開いてください');
    }
    current = null;
  });
  return { ok: true };
}

/**
 * 実行を止める。
 *   npm の下で検査プロセスが動くため、子孫までまとめて終了させる。
 *   npm だけを終了すると検査が動き続け、画面には「停止した」と出て食い違う。
 */
function stopRun() {
  if (!current) return { ok: false, error: '実行中の処理はありません' };
  const child = current.child;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // detached: true で起動しているためプロセスグループごと終了できる
      process.kill(-child.pid, 'SIGTERM');
      // 落ちない場合の保険 (5 秒後に強制終了)
      const pid = child.pid;
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // すでに終了している
        }
      }, 5000).unref();
    }
  } catch (error) {
    return { ok: false, error: `停止できませんでした: ${error instanceof Error ? error.message : String(error)}` };
  }
  logLines.push('[中止] 実行を止めました');
  return { ok: true };
}

/** reports/ 以下のファイルを返す (フォルダの外へは出さない) */
function serveReportFile(res, relative) {
  const normalized = path.normalize(path.join(REPORT_DIR, relative));
  if (!normalized.startsWith(REPORT_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  if (!fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) {
    res.writeHead(404, { 'content-type': MIME['.html'] });
    res.end('<p>まだレポートがありません。検査を実行してください。</p>');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(normalized).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(normalized).pipe(res);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    fs.createReadStream(UI_PATH).pipe(res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, state());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/run') {
    const result = startRun(
      url.searchParams.get('kind') ?? 'test',
      url.searchParams.get('key') ?? '',
      url.searchParams.get('size') ?? 'min',
    );
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/env') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      // 想定外に大きな送信は受け付けない
      if (raw.length > 10000) req.destroy();
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        sendJson(res, 400, { ok: false, error: '送信内容を読み取れませんでした' });
        return;
      }
      const result = saveEnv(String(body.target ?? ''), body);
      sendJson(res, result.ok ? 200 : 400, result);
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    const result = stopRun();
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/reports/')) {
    serveReportFile(res, decodeURIComponent(url.pathname.slice('/reports/'.length)));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

/**
 * 初回起動の準備。
 *   部品 (node_modules) が無ければ取得し、検査用ブラウザを確認する。
 *   ブラウザの確認に失敗しても画面は開く (通信エラーでも既に入っていれば動く)。
 */
function prepare() {
  const options = { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' };
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    process.stdout.write('\n  初回準備: 必要な部品をダウンロードします (5〜10分)\n\n');
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], options);
    if (install.status !== 0) {
      process.stdout.write('\n  [エラー] 部品のダウンロードに失敗しました。通信を確認してください。\n');
      process.exit(1);
    }
  }
  process.stdout.write('  検査用ブラウザを確認します...\n');
  const browsers = spawnSync('npx', ['playwright', 'install', 'chromium'], options);
  if (browsers.status !== 0) {
    process.stdout.write('  [警告] ブラウザの確認に失敗しました (通信エラーの可能性)。\n');
    process.stdout.write('         既に入っていればそのまま検査できます。\n');
  }
}

// テストから読み込む場合 (QA_UI_IMPORT=1) は準備も待ち受けも行わない
if (process.env.QA_UI_IMPORT !== '1') {
  prepare();
  server.listen(PORT, '127.0.0.1', () => {
    const address = `http://127.0.0.1:${PORT}`;
    process.stdout.write(`\n  検査ツールの画面を開きます: ${address}\n`);
    process.stdout.write('  この黒い画面は開いたままにしてください (閉じると画面も止まります)\n\n');
    if (process.env.QA_UI_NO_OPEN !== '1') {
      const opener =
        process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', address]]
          : process.platform === 'darwin'
            ? ['open', [address]]
            : ['xdg-open', [address]];
      spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
    }
  });
}
