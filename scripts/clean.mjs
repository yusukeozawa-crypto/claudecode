#!/usr/bin/env node
/** レポート・現在のスクリーンショットを削除する (基準画像は削除しない) */
import fs from 'node:fs';
import path from 'node:path';

const targets = ['reports', 'screenshots/current', 'screenshots/diff'];
for (const target of targets) {
  const absolute = path.resolve(process.cwd(), target);
  if (fs.existsSync(absolute)) {
    fs.rmSync(absolute, { recursive: true, force: true });
    console.log(`削除しました: ${target}`);
  }
}
console.log('基準画像 (screenshots/baseline) は保持されます。');
