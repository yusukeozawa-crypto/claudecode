/**
 * URL / メッセージの除外パターン照合。
 * 外部パッケージを追加せずに glob と正規表現の両方を扱える最小実装。
 */

const GLOBSTAR_TOKEN = '__QA_GLOBSTAR__';

/** glob パターンを正規表現に変換する ("**" は階層を跨ぐ、"*" は 1 階層内) */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .split('**')
    .join(GLOBSTAR_TOKEN)
    .replace(/\*/g, '[^/]*')
    .split(GLOBSTAR_TOKEN)
    .join('.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

/** URL がいずれかの glob パターンに一致するか */
export function matchesAnyGlob(value: string, patterns: string[] = []): boolean {
  return patterns.some((pattern) => {
    try {
      return globToRegExp(pattern).test(value);
    } catch {
      return false;
    }
  });
}

/**
 * メッセージがいずれかの除外パターンに一致するか。
 *   "foo"        -> 部分一致
 *   "/^foo.*$/i" -> 正規表現 (スラッシュで囲む)
 */
export function matchesAnyMessage(message: string, patterns: string[] = []): boolean {
  return patterns.some((pattern) => {
    const regexMatch = /^\/(.*)\/([gimsuy]*)$/.exec(pattern);
    if (regexMatch) {
      try {
        return new RegExp(regexMatch[1], regexMatch[2]).test(message);
      } catch {
        return false;
      }
    }
    return message.includes(pattern);
  });
}

/** 同一オリジンかどうか (相対 URL は同一オリジンとみなす) */
export function isSameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url, baseUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * 代理店コードが「そのコード単体で」現れているか。
 *
 * 単純な部分一致では、支店コード littlefamily03br35 の中の
 * littlefamily03 を「親コードが混入している」と数えてしまう。
 * これで本番の申込フォームに対して Critical の誤報を出した
 * (実測では littlefamily03br35 が 8 か所、親コード単体は 0 か所)。
 *
 * 代理店コードは英数字なので、前後が英数字でないことを条件にする。
 * 逆向きの見逃しも同時に防げる:
 *   親コードの検査でページに支店コードしか無いとき、
 *   部分一致では「親コードが引き継がれている」と誤って合格にしていた。
 */
export function containsCodeStandalone(haystack: string, code: string): boolean {
  if (haystack === '' || code === '') return false;
  const isCodeChar = (char: string | undefined): boolean => char !== undefined && /[0-9a-z]/i.test(char);
  for (let from = 0; from <= haystack.length - code.length; ) {
    const index = haystack.indexOf(code, from);
    if (index === -1) return false;
    if (!isCodeChar(haystack[index - 1]) && !isCodeChar(haystack[index + code.length])) return true;
    from = index + 1;
  }
  return false;
}

/** 複数の文字列のどれかにコードが単体で現れているか */
export function anyContainsCodeStandalone(values: Array<string | null | undefined>, code: string): boolean {
  return values.some((value) => typeof value === 'string' && containsCodeStandalone(value, code));
}
