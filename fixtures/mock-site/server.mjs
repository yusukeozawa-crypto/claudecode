#!/usr/bin/env node
/**
 * モックサイト用の静的サーバー。
 * QA ツールの動作確認 (local 環境) 専用で、検査対象サイトの挙動を模している。
 *   - 静的ファイル配信
 *   - 404 / 500 / リダイレクトループの再現 (検出ロジックの自己検査用)
 *   - /api/application は申込 API のモック
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_SITE_PORT || 4173);
const HOST = process.env.MOCK_SITE_HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // --- 申込 API のモック (代理店コードの引き継ぎ検証用) ---
  if (pathname === '/api/application') {
    const body = req.method === 'POST' ? await readBody(req) : '';
    res.writeHead(200, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify({ ok: true, received: body.slice(0, 500) }));
    return;
  }

  // --- 検出ロジックの自己検査用エンドポイント ---
  if (pathname === '/server-error') {
    res.writeHead(500, { 'content-type': MIME['.html'] });
    res.end('<h1>500 Internal Server Error</h1>');
    return;
  }
  if (pathname === '/redirect-loop-a') {
    res.writeHead(302, { location: '/redirect-loop-b' });
    res.end();
    return;
  }
  if (pathname === '/redirect-loop-b') {
    res.writeHead(302, { location: '/redirect-loop-a' });
    res.end();
    return;
  }

  // --- 静的ファイル配信 ---
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(ROOT, relative);
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(target);
    const filePath = stat.isDirectory() ? path.join(target, 'index.html') : target;
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': MIME['.html'] });
    res.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>404</title></head><body><h1>404 Not Found</h1></body></html>');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`mock site listening on http://${HOST}:${PORT}`);
});
