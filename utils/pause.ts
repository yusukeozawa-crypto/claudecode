/**
 * 検査の一時停止と再開。
 *
 * 「プロセスを凍らせる」方式は採らない。
 *   ブラウザを止めている間もページ側の待ち時間は進むため、再開した瞬間に
 *   タイムアウトが大量発火し、正常なサイトが不具合として並ぶ。
 *   スリープで実際に起きた壊れ方と同じになる。
 *
 * 代わりに「これから始めるテストを飛ばして、きれいに終わらせる」方式にする。
 *   - 一時停止 … 合図のファイルを置く。各テストは開始時にそれを見て飛ばす
 *   - 再開     … 終わらなかった代理店コードだけを次の実行で指定する
 *                 (QA_AGENCY_ONLY と同じ仕組み)
 *
 * 合図をファイルで持つ理由:
 *   検査は複数のワーカープロセスで動く。環境変数では実行中に伝えられない。
 *   パソコンを閉じても残るため、翌日でも再開できる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config';

export const PAUSE_FLAG_PATH = path.join(PROJECT_ROOT, 'reports', 'pause.flag');

/** 一時停止が指示されているか */
export function isPaused(): boolean {
  try {
    return fs.existsSync(PAUSE_FLAG_PATH);
  } catch {
    // 判定できない場合は止めない (検査を続けるほうが安全)
    return false;
  }
}

/** 一時停止を指示する */
export function requestPause(): void {
  fs.mkdirSync(path.dirname(PAUSE_FLAG_PATH), { recursive: true });
  fs.writeFileSync(PAUSE_FLAG_PATH, new Date().toISOString(), 'utf8');
}

/** 一時停止の指示を取り消す (次の実行を始めるときに必ず呼ぶ) */
export function clearPause(): void {
  fs.rmSync(PAUSE_FLAG_PATH, { force: true });
}

/**
 * テストの名前から代理店コードを取り出す。
 *
 * 飛ばしたテストには検知結果が付かないため、名前から判断するしかない。
 * 支店コード (littlefamily03br05) は親コード (littlefamily03) を
 * 含むため、**長いコードを優先**して照合する。
 */
export function codeFromTitle(title: string, codes: string[]): string | null {
  let found: string | null = null;
  for (const code of codes) {
    if (!title.includes(code)) continue;
    if (found === null || code.length > found.length) found = code;
  }
  return found;
}
