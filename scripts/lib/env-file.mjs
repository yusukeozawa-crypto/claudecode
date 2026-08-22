/**
 * .env の読み書き (対話ランチャーとブラウザ UI の共通処理)。
 *
 * .env は Git 管理外で、対象サイトの URL と認証情報が入る。
 * 同じキーが複数行あると「どちらが効くのか」が分からなくなるため、
 * 書き換えたキーの重複行は残さない。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * .env を読む。
 *
 *   同じキーが複数行あるときは **後に書いた行** を採用する。
 *   検査本体 (utils/config.ts の parseEnvLines) と同じ規則にすること。
 *   規則が違うと、検査は新しい値で動いているのに画面には古い値
 *   (または「未設定」) が出る。実際に、.env.example の空行が残ったまま
 *   末尾に追記された環境で、検査は動いているのに画面が「未設定」と
 *   表示していた。
 *
 *   戻り値: { values, duplicates } — duplicates は 2 行以上あったキー名。
 */
export function readEnvValues(root) {
  const envPath = path.join(root, '.env');
  const values = {};
  const seen = new Set();
  const duplicates = new Set();
  if (!fs.existsSync(envPath)) return { values, duplicates: [] };
  const text = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
    values[key] = value;
  }
  return { values, duplicates: [...duplicates] };
}

/** 指定フォルダの .env を更新する (無ければ .env.example を土台にする) */
export function writeEnvValues(root, updates) {
  const envPath = path.join(root, '.env');
  const examplePath = path.join(root, '.env.example');

  let lines;
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  } else if (fs.existsSync(examplePath)) {
    lines = fs.readFileSync(examplePath, 'utf8').split(/\r?\n/);
  } else {
    lines = [];
  }

  const remaining = new Map(Object.entries(updates));
  const written = new Set();
  const rewritten = [];
  for (const line of lines) {
    const match = /^(\s*)([A-Z0-9_]+)\s*=/.exec(line);
    if (!match) {
      rewritten.push(line);
      continue;
    }
    const key = match[2];
    if (remaining.has(key)) {
      rewritten.push(`${key}=${remaining.get(key)}`);
      remaining.delete(key);
      written.add(key);
      continue;
    }
    if (written.has(key)) continue;
    rewritten.push(line);
  }

  for (const [key, value] of remaining) rewritten.push(`${key}=${value}`);
  fs.writeFileSync(envPath, `${rewritten.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

/**
 * 入力された URL からドメイン部分 (オリジン) だけを取り出す。
 * .env に入れるのはドメインまで。検査するページのパスは
 * config/pages.yml が持つため、パスまで入れると二重になる。
 */
export function parseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return {
    origin: url.origin,
    droppedPath: url.pathname !== '/' && url.pathname !== '' ? url.pathname : null,
    droppedQuery: url.search !== '' ? url.search : null,
  };
}
