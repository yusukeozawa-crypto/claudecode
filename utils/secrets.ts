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

/** 文字列中の秘密情報をマスクする */
export function maskText(text: string | undefined, config: QaConfig): string | undefined {
  if (!text) return text;
  let masked = text;
  const security = config.agencies.security;

  // key=value 形式 (URL / クエリ / ログ) のマスキング。
  // 個人情報らしいキー (mail / tel など) も対象にする。
  // 値のパターン (電話番号など) は本文には適用しない
  // — 代理店の電話番号は期待値としてレポートに表示する必要があるため。
  for (const name of maskedParamNames(config)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    masked = masked.replace(new RegExp(`([?&"'\\s]|^)(${escaped}[\\w-]*)\\s*[=:]\\s*"?([^"'&\\s,}]+)"?`, 'gi'),
      (_match, prefix: string, key: string) => `${prefix}${key}=${MASK}`);
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
