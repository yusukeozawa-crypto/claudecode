/**
 * 秘密情報・個人情報のマスキング。
 *
 * 一時トークン・セッション ID・認証情報に加え、URL に付加された個人情報
 * (メールアドレス・電話番号など) をレポートやログに出力しない。
 * 「URL に個人情報が含まれている」ことは検知結果として報告するが、
 * その値自体はレポートへ出力しない (レポートは CI の Artifact になるため)。
 *
 * FindingCollector が全ての検知結果に対してこの処理を適用する。
 */
import type { Finding, QaConfig } from './types';

const MASK = '***MASKED***';

/** マスク対象のパラメータ名 (秘密情報 + 個人情報らしいキー) */
function maskedParamNames(config: QaConfig): string[] {
  return [
    ...config.agencies.security.maskParamNames,
    ...config.agencies.redirect.forbiddenQueryParamKeywords,
  ].map((name) => name.toLowerCase());
}

/** 値そのものが個人情報に見える場合に使用するパターン */
function piiValuePatterns(config: QaConfig): string[] {
  return config.agencies.redirect.piiValuePatterns;
}

/**
 * URL のクエリパラメータのうち、秘密扱い・個人情報らしい値をマスクする。
 * キー名での判定に加え、値のパターン (メールアドレス等) でも判定する。
 */
export function maskUrl(url: string, config: QaConfig): string {
  const maskParams = maskedParamNames(config);
  const valuePatterns = piiValuePatterns(config);
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const [key, value] of Array.from(parsed.searchParams.entries())) {
      const byKey = maskParams.some((name) => key.toLowerCase().includes(name));
      const byValue = valuePatterns.some((pattern) => {
        try {
          return new RegExp(pattern).test(value);
        } catch {
          return false;
        }
      });
      if (byKey || byValue) {
        parsed.searchParams.set(key, MASK);
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/**
 * 文字列中の秘密情報・個人情報をマスクする。
 *
 * 対象の形は 2 通り:
 *   - クエリ形式  : `?handoff_token=xxx` / `&mail=xxx`
 *   - JSON/ログ形式: `"handoff_token": "xxx"` / `token=xxx`
 *
 * 区切り文字と前後のクォートは保持する。壊すと添付した証跡が
 * JSON として解析できなくなり、証跡の意味が失われるため。
 *
 * 秘密情報 (トークン・セッション) はどの形式でもマスクするが、
 * 個人情報らしいキー (mail / tel / name など) はクエリ形式のみを対象にする。
 * JSON のキー名 ("name" など) まで潰すと、調査結果 (hidden 項目名の一覧など) が
 * 読めなくなるため。
 */
export function maskText(text: string | undefined, config: QaConfig): string | undefined {
  if (!text) return text;
  let masked = text;
  const security = config.agencies.security;

  const replaceKeyValue = (input: string, name: string, prefixClass: string): string => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // prefix / キー / 区切り / 開始クォート / 値 / 終了クォート を個別に捕捉する
    const pattern = new RegExp(
      `(${prefixClass})(${escaped}[\\w-]*)("?\\s*[=:]\\s*)("?)([^"'&\\s,}\\]]+)("?)`,
      'gi',
    );
    return input.replace(
      pattern,
      (_match, prefix: string, key: string, separator: string, openQuote: string, _value: string, closeQuote: string) =>
        `${prefix}${key}${separator}${openQuote}${MASK}${closeQuote}`,
    );
  };

  // 秘密情報: クエリ形式・JSON/ログ形式のどちらもマスクする
  for (const name of security.maskParamNames) {
    masked = replaceKeyValue(masked, name, '[?&"\'\\s]|^');
  }

  // 個人情報らしいキー: クエリ形式 (?key= / &key=) のみを対象にする
  for (const name of config.agencies.redirect.forbiddenQueryParamKeywords) {
    masked = replaceKeyValue(masked, name, '[?&]');
  }

  // パターンによるマスキング (JWT / 長い 16 進文字列など)
  for (const pattern of security.maskValuePatterns) {
    try {
      masked = masked.replace(new RegExp(pattern, 'g'), MASK);
    } catch {
      /* 不正な正規表現は無視する */
    }
  }

  return masked;
}

/** 検知結果 1 件をマスクする */
export function maskFinding(finding: Finding, config: QaConfig): Finding {
  return {
    ...finding,
    title: maskText(finding.title, config) ?? finding.title,
    expected: maskText(finding.expected, config),
    actual: maskText(finding.actual, config),
    detail: maskText(finding.detail, config),
    url: maskUrl(finding.url, config),
  };
}

/** マスキングされているかの検査 (テスト用) */
export function containsUnmaskedSecret(text: string, secret: string): boolean {
  return secret.length > 8 && text.includes(secret);
}
