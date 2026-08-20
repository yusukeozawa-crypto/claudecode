/**
 * .env の読み書き (対話ランチャーとブラウザ UI の共通処理)。
 *
 * .env は Git 管理外で、対象サイトの URL と認証情報が入る。
 * 同じキーが複数行あると「どちらが効くのか」が分からなくなるため、
 * 書き換えたキーの重複行は残さない。
 */
import fs from 'node:fs';
import path from 'node:path';

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
