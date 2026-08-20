/**
 * 人が読むテキストファイルの書き出し。
 *
 * Windows の PowerShell (`type`) や メモ帳、Excel は
 * BOM の無い UTF-8 を Shift-JIS として解釈するため、日本語が文字化けする。
 * BOM を付けると UTF-8 として認識される。
 *
 * 機械が読むファイル (JSON / YAML) には付けない。
 * BOM があると解析に失敗する処理系があるため。
 */
import fs from 'node:fs';

const BOM = '﻿';

/** BOM 付き UTF-8 で書き出す (人が読むファイル用) */
export function writeHumanText(filePath: string, content: string): void {
  const body = content.startsWith(BOM) ? content : `${BOM}${content}`;
  fs.writeFileSync(filePath, body, 'utf8');
}

/** BOM を除いた内容 (読み込み時に使う) */
export function stripBom(content: string): string {
  return content.startsWith(BOM) ? content.slice(1) : content;
}
