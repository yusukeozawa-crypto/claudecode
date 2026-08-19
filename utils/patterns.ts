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
