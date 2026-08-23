/**
 * 検査したときサイトで「何が動いていたか」を記録する。
 *
 * このツールの目的は、Zoho の A/B テストや GTM による差し替えが
 * 入った**いまの状態**で表示とコードが正しいかを見ることにある。
 * ところが結果だけを残すと、次の 2 つを区別できない。
 *   ・A/B テストの A を引いて合格した
 *   ・B を引いて合格した
 * どちらを見たのか分からないままでは「異常なし」を信用できない。
 *
 * そこで、判定はせずに次を記録する (正解が未確定なので赤にしない)。
 *   ・読み込まれた他社ドメイン (計測タグ・A/B テストの配信元)
 *   ・A/B テストのバリアントを示す値 (Cookie / localStorage のキーと値)
 *   ・GTM の dataLayer に入っている実験名
 */
import type { Page } from '@playwright/test';
import type { FindingInput, QaConfig } from './types';

/** バリアントを示す値として拾うキーの形 */
const VARIANT_KEY_PATTERNS = [
  /^zps/i, // Zoho PageSense
  /^zab/i, // Zoho PageSense (A/B テスト)
  /pagesense/i,
  /^_gaexp/i, // Google Optimize 系
  /experiment/i,
  /variant/i,
  /abtest/i,
];

function isVariantKey(key: string): boolean {
  return VARIANT_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export interface RuntimeObservation {
  /** 読み込まれた他社ドメイン */
  thirdPartyHosts: string[];
  /** A/B テストのバリアントを示しそうな Cookie / 保存領域の値 */
  variantValues: string[];
  /** GTM の dataLayer に入っていた実験名らしきもの */
  dataLayerHints: string[];
}

/**
 * ページで動いていたものを観測する。
 * hosts は呼び出し側 (PageMonitor) が集めたリクエスト先を渡す。
 */
export async function observeRuntime(
  page: Page,
  config: QaConfig,
  requestHosts: string[],
): Promise<RuntimeObservation> {
  const ownHosts = [config.environment.baseUrl, config.environment.applicationBaseUrl]
    .filter((value) => value !== '')
    .map((value) => {
      try {
        return new URL(value).host;
      } catch {
        return '';
      }
    })
    .filter((value) => value !== '');

  const thirdPartyHosts = [...new Set(requestHosts.filter((host) => !ownHosts.includes(host)))].sort();

  const fromStorage = await page
    .evaluate(() => {
      const read = (store: Storage | null): Array<[string, string]> => {
        if (!store) return [];
        const entries: Array<[string, string]> = [];
        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index);
          if (key === null) continue;
          entries.push([key, store.getItem(key) ?? '']);
        }
        return entries;
      };
      const cookies = document.cookie
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .map((part) => {
          const eq = part.indexOf('=');
          return eq < 0 ? ([part, ''] as [string, string]) : ([part.slice(0, eq), part.slice(eq + 1)] as [string, string]);
        });
      // dataLayer から実験名らしきものを拾う
      const layer = (window as unknown as { dataLayer?: unknown[] }).dataLayer;
      const dataLayerHints: string[] = [];
      if (Array.isArray(layer)) {
        for (const entry of layer.slice(0, 200)) {
          const text = (() => {
            try {
              return JSON.stringify(entry);
            } catch {
              return '';
            }
          })();
          if (/experiment|variant|abtest|pagesense/i.test(text)) dataLayerHints.push(text.slice(0, 200));
        }
      }
      return {
        cookies,
        local: read(window.localStorage),
        session: read(window.sessionStorage),
        dataLayerHints: [...new Set(dataLayerHints)].slice(0, 10),
      };
    })
    .catch(() => ({ cookies: [], local: [], session: [], dataLayerHints: [] as string[] }));

  const collect = (entries: Array<[string, string]>, where: string): string[] =>
    entries
      .filter(([key]) => isVariantKey(key))
      // 値が長いものは切る (レポートが読めなくなる)
      .map(([key, value]) => `${where} ${key}=${value.slice(0, 60)}`);

  const variantValues = [
    ...collect(fromStorage.cookies, 'Cookie'),
    ...collect(fromStorage.local, 'localStorage'),
    ...collect(fromStorage.session, 'sessionStorage'),
  ].sort();

  return { thirdPartyHosts, variantValues, dataLayerHints: fromStorage.dataLayerHints };
}

/**
 * 観測結果を「記録」として返す (合否は付けない)。
 *
 * 正解が未確定なので赤にはしない。
 * 「何が動いている状態で検査したのか」を後から読めるようにするためのもの。
 */
export function describeRuntime(observation: RuntimeObservation, label: string, url: string): FindingInput[] {
  const parts: string[] = [];
  if (observation.thirdPartyHosts.length > 0) {
    parts.push(`他社ドメイン: ${observation.thirdPartyHosts.join(', ')}`);
  }
  parts.push(
    observation.variantValues.length > 0
      ? `A/Bテストの値: ${observation.variantValues.join(' / ')}`
      : 'A/Bテストの値: 見つかりませんでした',
  );
  if (observation.dataLayerHints.length > 0) {
    parts.push(`dataLayer: ${observation.dataLayerHints.join(' / ')}`);
  }

  return [
    {
      category: 'agency-display',
      severity: 'low',
      title: `[記録] ${label}: 検査したときサイトで動いていたもの`,
      expected: '何が動いている状態で検査したのかを記録する (合否は判定しない)',
      actual: parts.join(' | '),
      url,
      detail:
        'A/B テストはバリアントごとに表示が変わる。どちらを見たのか分からないままでは「異常なし」を信用できないため、' +
        '毎回この記録を残している。バリアントを示す値の名前が分かれば、config で判定に使えるようになる。',
    },
  ];
}
