#!/usr/bin/env node
/**
 * 生成済みレポートをローカルで閲覧する簡易サーバー。
 * スクリーンショットや差分画像も相対パスで参照できるよう reports/ を配信する。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'reports');
// ループバックのみで待ち受ける (レポートには対象サイトの URL や
// 抽出テキストが含まれるため、ネットワークに公開しない)
const HOST = process.env.QA_REPORT_HOST || '127.0.0.1';
const PORT = Number(process.env.QA_REPORT_PORT || 9323);

if (!fs.existsSync(path.join(ROOT, 'qa-report.html'))) {
  console.error('reports/qa-report.html が見つかりません。先に npm test を実行してください。');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.zip': 'application/zip',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    let requestPath;
    try {
      requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      // 不正なパーセントエンコーディング (/% など) でプロセスが落ちないようにする
      res.writeHead(400).end('Bad Request');
      return;
    }
    const relative = requestPath === '/' ? 'qa-report.html' : requestPath.replace(/^\/+/, '');
    const target = path.resolve(ROOT, relative);

    // ROOT + セパレータで比較する (reports-backup のような兄弟ディレクトリへの脱出を防ぐ)
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(target, (error, content) => {
      if (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' });
      res.end(content);
    });
  })
  .listen(PORT, HOST, () => {
    console.log(`QA レポート: http://127.0.0.1:${PORT}/`);
    console.log(`Playwright レポート: http://127.0.0.1:${PORT}/playwright-report/index.html`);
    console.log('終了するには Ctrl+C を押してください。');
  });
