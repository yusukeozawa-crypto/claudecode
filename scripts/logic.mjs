#!/usr/bin/env node
/**
 * 判定ロジックの説明を Markdown に書き出す (npm run logic)。
 *
 *   npm run logic
 *   npm run logic -- --env=local
 *
 * 出力: reports/export/logic.md
 *
 * 中身は config/ から自動生成する。人に渡す・AI に読ませるときは
 * このファイルを渡す (手で書いた説明は必ず実際の判定とずれるため)。
 * ブラウザ画面の「ロジック」タブと同じ内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLogic, logicMarkdown } from './lib/logic.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envArg = process.argv.slice(2).find((arg) => arg.startsWith('--env='));
const environment = envArg ? envArg.slice('--env='.length) : null;

const logic = buildLogic(root, { environment });
const outDir = path.join(root, 'reports', 'export');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'logic.md');
fs.writeFileSync(outPath, `${logicMarkdown(logic)}\n`, 'utf8');

console.log('');
console.log('================ ロジックの説明を書き出しました ================');
console.log(`出力    : ${path.relative(root, outPath)}`);
console.log(`環境    : ${environment ?? '実サイト用の設定 (config/*.yml)'}`);
console.log(`見出し  : ${logic.tabs.map((tab) => tab.label).join(' / ')}`);
console.log('そのまま共有できます (設定を変えたら再実行してください)');
console.log('===============================================================');
