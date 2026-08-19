/**
 * 秘密情報のマスキング。
 *
 * 一時トークン・セッション ID・認証情報をレポートやログに出力しない。
 * FindingCollector が全ての検知結果に対してこの処理を適用する。
 */
import type { Finding, QaConfig } from './types';

const MASK = '***MASKED***';

/** URL のクエリパラメータのうち、秘密扱いの値をマスクする */
export function maskUrl(url: string, config: QaConfig): string {
  const maskParams = config.agencies.security.maskParamNames.map((name) => name.toLowerCase());
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (maskParams.some((name) => key.toLowerCase().includes(name))) {
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

  // key=value 形式 (URL / クエリ / ログ) のマスキング
  for (const name of security.maskParamNames) {
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
