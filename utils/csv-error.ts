/**
 * CSV の書き出しに失敗した理由を、人が対処できる文にする。
 *
 * Node のエラー出力は 1 行目が「node:fs:2422」のような内部の場所で、
 * それをそのまま出しても何をすればよいか分からない (実際に起きた)。
 * 原因の行とエラーコードを拾い、対処が決まっているものは対処も書く。
 */

/** 対処が決まっているエラーコード */
const HINTS: Array<{ codes: string[]; hint: string }> = [
  {
    // Windows は開いているファイルを書き換えられない。
    // CSV を Excel で開いたまま検査すると必ずここに来る。
    codes: ['EBUSY', 'EPERM', 'EACCES'],
    hint: 'CSV を Excel で開いていると書き込めません。閉じてから「CSV に書き出す」を押してください',
  },
  { codes: ['ENOSPC'], hint: 'ディスクの空き容量が足りません' },
  { codes: ['EMFILE', 'ENFILE'], hint: '開いているファイルが多すぎます。ほかのアプリを閉じてから試してください' },
];

export function describeCsvError(stderr: string | null | undefined): string {
  const lines = String(stderr ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  // 原因が書かれている行を選ぶ。
  //   1. 「Error: ...」の行 (これが本当の理由)
  //   2. それが無ければ、内部の場所 (node:...) と枠線以外の最初の行
  const reason = lines.find((line) => /^[A-Za-z]*Error:/.test(line))
    ?? lines.find((line) => !line.startsWith('node:') && !/^\s*[\^~]+\s*$/.test(line))
    ?? '原因不明';

  const code = String(stderr ?? '').match(/\b(E[A-Z]{3,7})\b/)?.[1];
  const hint = HINTS.find((entry) => code !== undefined && entry.codes.includes(code))?.hint;

  return hint === undefined ? reason : `${reason} — ${hint}`;
}
