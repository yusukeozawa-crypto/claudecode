/**
 * 代理店コードに関する共通処理。
 *
 * 代理店コードの「有無」ではなく、config/agencies.yml に定義された
 * 代理店ごとの期待結果 (表示セクション・代理店名・電話番号・バナー・CTA) を検証する。
 */
import type { BrowserContext, Page } from '@playwright/test';
import { pageUrl, resolveSelector } from './config';
import type {
  AgencySpec, CheckId, FallbackExpectation, FindingInput, QaConfig,
} from './types';

// ---------------------------------------------------------------------------
// 設定の参照
// ---------------------------------------------------------------------------

/**
 * 抽選の種 (シード)。
 *
 * テストは複数のワーカープロセスに分かれて実行される。
 * プロセスごとに抽選し直すとテストの一覧が食い違って実行が壊れるため、
 * 1 回の実行の中では必ず同じ値を共有する必要がある。
 * playwright.config.ts (ワーカー起動前に読み込まれる) が
 * QA_AGENCY_SEED を設定し、ワーカーは環境変数として受け継ぐ。
 *
 * レポートにも記録されるので、同じ組み合わせを再現したいときは
 * QA_AGENCY_SEED にその値を指定する。
 */
export function agencySeed(): string {
  return process.env.QA_AGENCY_SEED ?? 'fixed';
}

/** 文字列から 32bit の初期値を作る */
function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** シード付き乱数 (mulberry32) — 同じシードなら必ず同じ結果になる */
function createRandom(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** シード付きシャッフル (Fisher-Yates) */
function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

/**
 * 検査対象の代理店。
 *
 * 代理店が 200 件を超えるサイトでは全件を毎回検査するのは現実的でないため、
 * 挙動パターンごとに抽選する。毎回同じ代理店を選ぶと、
 * 残りに潜む問題を見逃し続けることになるので実行ごとに変える。
 *
 *   QA_AGENCY_SCOPE=all   … 抽選せず全件を検査する
 *   QA_AGENCY_SEED=<値>   … 過去の実行と同じ組み合わせを再現する
 */
/**
 * パターンごとの検査件数を決める。
 *
 * QA_AGENCY_PER_PROFILE で実行ごとに変えられる。
 * 導入時は最小 (1) で動作確認し、問題がなくなってから増やす運用のため。
 * 設定ファイルを書き換えずに切り替えられる必要がある。
 */
export function resolvePerProfile(configured: number): number {
  const requested = process.env.QA_AGENCY_PER_PROFILE?.trim();
  if (requested === undefined || requested === '') return Math.max(0, Number(configured));
  const value = Number(requested);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`QA_AGENCY_PER_PROFILE には 1 以上の整数を指定してください (指定値: ${requested})`);
  }
  return value;
}

export function agencySpecs(config: QaConfig): AgencySpec[] {
  const all = config.agencies.agencies;
  const scope = config.agencies.scope;
  const requested = process.env.QA_AGENCY_SCOPE?.trim();

  if (requested === 'all' || !scope || scope.mode === 'all') return all;
  if (requested && requested !== 'sample') {
    throw new Error(`QA_AGENCY_SCOPE には sample か all を指定してください (指定値: ${requested})`);
  }

  const perProfile = resolvePerProfile(scope.perProfile ?? 2);
  const always = new Set(scope.always ?? []);
  const random = createRandom(agencySeed());

  // パターンごとにまとめる (profile が無い場合は 1 つのグループとして扱う)
  const groups = new Map<string, AgencySpec[]>();
  for (const spec of all) {
    const key = spec.profile ?? '(未分類)';
    const list = groups.get(key);
    if (list) list.push(spec);
    else groups.set(key, [spec]);
  }

  const picked = new Set<string>(
    // always は「その代理店がマスタに存在する場合のみ」含める
    all.filter((spec) => always.has(spec.code)).map((spec) => spec.code),
  );
  // グループの処理順もシードに従って固定する (Map の挿入順に依存させない)
  for (const key of shuffle([...groups.keys()], random)) {
    const members = groups.get(key) ?? [];
    // always で既に選ばれている分は抽選枠を消費したものとして数える
    const alreadyPicked = members.filter((spec) => picked.has(spec.code)).length;
    const remaining = perProfile - alreadyPicked;
    if (remaining <= 0) continue;
    for (const spec of shuffle(members, random).slice(0, remaining)) picked.add(spec.code);
  }

  // 出力順はマスタの並び順を保つ (レポートが読みやすい)
  return all.filter((spec) => picked.has(spec.code));
}

export function findAgencySpec(config: QaConfig, code: string): AgencySpec | undefined {
  return config.agencies.agencies.find((agency) => agency.code === code);
}

export function invalidCodes(config: QaConfig): Array<{ code: string; label: string }> {
  return config.agencies.invalidCodes ?? [];
}

/** 代理店コード付きの URL を組み立てる */
export function urlWithCode(config: QaConfig, path: string, code: string | null): string {
  return code
    ? pageUrl(config, path, { [config.agency.paramName]: code })
    : pageUrl(config, path);
}

/** 共通セレクタ (agency.yml の selectors) を解決する */
export function agencySelector(config: QaConfig, key: string): string {
  return resolveSelector(config.agency.selectors[key] ?? key);
}

// ---------------------------------------------------------------------------
// 保存値 (Cookie / localStorage)
// ---------------------------------------------------------------------------

export interface StoredAgencyCode {
  cookie: string | null;
  localStorage: string | null;
}

/** Cookie / localStorage に保存された代理店コードを読み取る (値はログに出さない) */
export async function readStoredCode(page: Page, config: QaConfig): Promise<StoredAgencyCode> {
  const key = config.agency.storage.key;
  const cookies = await page.context().cookies();
  const cookie = cookies.find((entry) => entry.name === key)?.value ?? null;
  const fromLocalStorage = await page
    .evaluate((storageKey: string) => {
      try {
        return window.localStorage.getItem(storageKey);
      } catch {
        return null;
      }
    }, key)
    .catch(() => null);
  return { cookie: cookie ? decodeURIComponent(cookie) : null, localStorage: fromLocalStorage };
}

/**
 * 代理店の組み合わせ (流入し直しの検証) を列挙する。
 *
 * 全組み合わせは代理店数の二乗になるため、
 * config/runtime.yml の maxAgencyPairs で上限を設ける。
 * 上限内では「隣接する組み合わせ」を優先して選ぶ
 * (先頭の代理店だけが繰り返し使われるのを避け、
 *  どの代理店も少なくとも 1 回は前後に現れるようにする)。
 */
export function agencyPairs(
  specs: AgencySpec[],
  config: QaConfig,
): Array<{ first: AgencySpec; second: AgencySpec }> {
  const limit = config.runtime.maxAgencyPairs ?? 30;
  if (limit <= 0 || specs.length < 2) return [];

  const pairs: Array<{ first: AgencySpec; second: AgencySpec }> = [];
  const seen = new Set<string>();
  const push = (first: AgencySpec, second: AgencySpec): void => {
    if (pairs.length >= limit || first.code === second.code) return;
    const key = `${first.code}->${second.code}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ first, second });
  };

  // 1) 互いに重ならない隣接ペアから選ぶ。
  //    (0,1) (2,3) (4,5) ... の順に取ると、1 ペアあたり 2 代理店を
  //    新しく網羅できるため、上限が代理店数より小さい場合でも
  //    登場する代理店が最大になる。
  for (const offset of [0, 1]) {
    for (let index = offset; index + 1 < specs.length && pairs.length < limit; index += 2) {
      push(specs[index], specs[index + 1]);
    }
  }
  // 2) 上限に余裕があれば距離を広げて組み合わせを増やす
  for (let distance = 1; distance < specs.length && pairs.length < limit; distance += 1) {
    for (let index = 0; index < specs.length && pairs.length < limit; index += 1) {
      push(specs[index], specs[(index + distance) % specs.length]);
    }
  }
  return pairs;
}

/** 保存先設定に応じた「保持されているコード」 */
export function effectiveStoredCode(stored: StoredAgencyCode, config: QaConfig): string | null {
  switch (config.agency.storage.type) {
    case 'cookie':
      return stored.cookie;
    case 'localStorage':
      return stored.localStorage;
    case 'none':
      return null;
    default:
      return stored.cookie ?? stored.localStorage;
  }
}

/**
 * この代理店コードが保存されるべきか。
 * サイト側で認識されないコード (支店コードなど) は保存されないのが正しい。
 */
export function expectedStoredCode(spec: { code: string; recognized?: boolean }): string | null {
  return spec.recognized === false ? null : spec.code;
}

/** 保存値の検査を行う設定か (none は行わない) */
export function storageChecksEnabled(config: QaConfig): boolean {
  return config.agency.storage.type !== 'none';
}

export function storageLabel(config: QaConfig): string {
  const { type, key } = config.agency.storage;
  if (type === 'none') return '保存先なし (URL のみで引き回す設定)';
  const typeLabel = type === 'both' ? 'Cookie / localStorage' : type === 'cookie' ? 'Cookie' : 'localStorage';
  return `${typeLabel} (キー: ${key})`;
}

/** Cookie と localStorage の代理店コードを削除する */
export async function clearStoredCode(context: BrowserContext, page: Page, config: QaConfig): Promise<void> {
  await context.clearCookies();
  await page
    .evaluate((storageKey: string) => {
      try {
        window.localStorage.removeItem(storageKey);
        window.sessionStorage.removeItem(storageKey);
      } catch {
        /* storage が使えない環境では何もしない */
      }
    }, config.agency.storage.key)
    .catch(() => undefined);
}

/** 保存された代理店コードの検証 */
export function verifyStoredCode(
  stored: StoredAgencyCode,
  config: QaConfig,
  expectedCode: string | null,
  context: { url: string; label: string },
): FindingInput[] {
  const findings: FindingInput[] = [];
  // storage.type: none は「保存しない実装 / 保存方式が未確認」の明示。
  // 保存値を根拠に合否を判定しない (URL のみで引き回すサイトを誤検知しない)。
  if (!storageChecksEnabled(config)) {
    return findings;
  }
  const actual = effectiveStoredCode(stored, config);

  if (expectedCode === null) {
    if (actual !== null) {
      findings.push({
        category: 'agency-persistence',
        title: `${context.label}: 代理店コードが保存されないはずですが保存されています`,
        expected: `${storageLabel(config)} に代理店コードが保存されていないこと`,
        actual: `保存値あり (コード: ${actual})`,
        url: context.url,
      });
    }
    return findings;
  }

  if (actual !== expectedCode) {
    findings.push({
      category: 'agency-persistence',
      title: `${context.label}: 保存された代理店コードが期待と一致しません`,
      expected: `${storageLabel(config)} = ${expectedCode}`,
      actual: actual === null ? '保存値なし (コード欠落)' : `保存値 = ${actual}`,
      url: context.url,
    });
  }

  if (config.agency.storage.type === 'both' && stored.cookie !== null && stored.localStorage !== null) {
    if (stored.cookie !== stored.localStorage) {
      findings.push({
        category: 'agency-persistence',
        severity: 'critical',
        title: `${context.label}: Cookie と localStorage の代理店コードが一致しません`,
        expected: 'Cookie と localStorage が同一の代理店コードであること',
        actual: `Cookie=${stored.cookie} / localStorage=${stored.localStorage}`,
        url: context.url,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 表示・非表示セクション
// ---------------------------------------------------------------------------

export interface SectionExpectation {
  visibleSections: string[];
  hiddenSections: string[];
}

/** セクションの表示・非表示を検証する (表示すべきものが出ない / 隠すべきものが出るは Critical) */
export async function verifySections(
  page: Page,
  expectation: SectionExpectation,
  label: string,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const url = page.url();

  for (const section of expectation.visibleSections) {
    const selector = resolveSelector(section);
    const locator = page.locator(selector).first();
    const exists = (await locator.count()) > 0;
    const visible = exists && (await locator.isVisible());
    if (!visible) {
      findings.push({
        category: 'agency-display',
        title: `${label}: 表示すべきセクションが表示されていません: ${section}`,
        expected: `${selector} が表示されること`,
        actual: exists ? '要素が非表示です' : '要素が存在しません',
        url,
      });
    }
  }

  for (const section of expectation.hiddenSections) {
    const selector = resolveSelector(section);
    const locator = page.locator(selector).first();
    const exists = (await locator.count()) > 0;
    if (exists && (await locator.isVisible())) {
      findings.push({
        category: 'agency-display',
        title: `${label}: 非表示にすべきセクションが表示されています: ${section}`,
        expected: `${selector} が非表示であること`,
        actual: '要素が表示されています',
        url,
      });
    }
  }

  return findings;
}

/** 代理店名・電話番号などの表示文言を検証する */
export async function verifyTexts(
  page: Page,
  expectedTexts: Record<string, string>,
  label: string,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const url = page.url();

  for (const [testIdValue, expectedText] of Object.entries(expectedTexts ?? {})) {
    const selector = resolveSelector(testIdValue);
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      findings.push({
        category: 'agency-display',
        title: `${label}: 表示文言の対象要素が存在しません: ${testIdValue}`,
        expected: `${selector} に「${expectedText}」が表示されること`,
        actual: '要素が存在しません',
        url,
      });
      continue;
    }
    const actualText = ((await locator.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    if (!actualText.includes(expectedText)) {
      findings.push({
        category: 'agency-display',
        title: `${label}: 表示内容が期待と異なります (代理店の誤表示): ${testIdValue}`,
        expected: expectedText,
        actual: actualText || '(空)',
        url,
      });
    }
  }

  return findings;
}

/** バナー・ロゴを検証する */
export async function verifyAssets(
  page: Page,
  expectedAssets: Record<string, string>,
  label: string,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const url = page.url();

  for (const [testIdValue, expectedSrc] of Object.entries(expectedAssets ?? {})) {
    const selector = resolveSelector(testIdValue);
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      findings.push({
        category: 'agency-display',
        title: `${label}: バナー/ロゴの要素が存在しません: ${testIdValue}`,
        expected: `${selector} に ${expectedSrc} が表示されること`,
        actual: '要素が存在しません',
        url,
      });
      continue;
    }
    if (!(await locator.isVisible())) {
      findings.push({
        category: 'agency-display',
        title: `${label}: バナー/ロゴが表示されていません: ${testIdValue}`,
        expected: `${selector} が表示されること`,
        actual: '要素が非表示です',
        url,
      });
      continue;
    }
    const actualSrc = (await locator.getAttribute('src')) ?? '';
    if (!actualSrc.includes(expectedSrc)) {
      findings.push({
        category: 'agency-display',
        title: `${label}: 別の代理店のバナー/ロゴが表示されています: ${testIdValue}`,
        expected: `src に ${expectedSrc} を含むこと`,
        actual: actualSrc || '(src なし)',
        url,
      });
    }
    // 画像そのものが読み込めているか
    const naturalWidth = await locator.evaluate((element) =>
      element instanceof HTMLImageElement ? element.naturalWidth : -1,
    );
    if (naturalWidth === 0) {
      findings.push({
        category: 'image-error',
        severity: 'medium',
        title: `${label}: バナー/ロゴを読み込めていません: ${testIdValue}`,
        expected: 'naturalWidth > 0',
        actual: `naturalWidth=0 (${actualSrc})`,
        url,
      });
    }
  }

  return findings;
}

/** CTA の文言を検証する (遷移先は utils/handoff.ts で検証する) */
export async function verifyCtaText(
  page: Page,
  spec: AgencySpec,
  label: string,
): Promise<FindingInput[]> {
  if (!spec.cta?.expectedText) return [];
  const selector = resolveSelector(spec.cta.testId);
  const locator = page.locator(selector).first();
  const url = page.url();

  if ((await locator.count()) === 0) {
    return [
      {
        category: 'agency-handoff',
        title: `${label}: CTA が存在しません: ${spec.cta.testId}`,
        expected: `${selector} が存在すること`,
        actual: '要素が存在しません',
        url,
      },
    ];
  }
  const actualText = ((await locator.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  if (!actualText.includes(spec.cta.expectedText)) {
    return [
      {
        category: 'agency-display',
        title: `${label}: CTA の文言が期待と異なります`,
        expected: spec.cta.expectedText,
        actual: actualText || '(空)',
        url,
      },
    ];
  }
  return [];
}

/**
 * 他の代理店の情報が表示されていないことを検証する。
 * 「別代理店の名称・電話番号が表示された」「無効コードで他代理店の情報が表示された」を検出する。
 */
export async function verifyNoOtherAgencyInfo(
  page: Page,
  config: QaConfig,
  ownCode: string | null,
  label: string,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const url = page.url();
  const bodyText = ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ');
  const ownValues = ownCode
    ? Object.values(findAgencySpec(config, ownCode)?.expectedTexts ?? {})
    : [];

  for (const other of agencySpecs(config)) {
    if (ownCode && other.code === ownCode) continue;
    for (const [key, value] of Object.entries(other.expectedTexts ?? {})) {
      if (!value) continue;
      // 自代理店の表示値に含まれる文字列は対象外にする。
      // 例: 自「ABC保険サービス」/ 他「ABC保険」のとき、
      // 部分一致だけで判定すると常に誤検知になる。
      if (ownValues.some((own) => own === value || own.includes(value))) continue;
      if (bodyText.includes(value)) {
        findings.push({
          category: 'agency-display',
          title: `${label}: 別の代理店の情報が表示されています (${other.code} の ${key})`,
          expected: ownCode
            ? `${ownCode} の情報のみが表示されること`
            : '代理店情報が表示されないこと',
          actual: `「${value}」がページ内に表示されています`,
          url,
        });
      }
    }
  }

  return findings;
}

/** 無効コード / コードなしの共通検証 */
export async function verifyFallback(
  page: Page,
  config: QaConfig,
  expectation: FallbackExpectation,
  label: string,
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  findings.push(...(await verifySections(page, expectation, label)));
  findings.push(...(await verifyTexts(page, expectation.expectedTexts ?? {}, label)));
  // 無効コード・コードなしで代理店名が出ていないこと
  findings.push(...(await verifyDisplayRules(page, config, { agencyName: expectation.agencyName }, label)));
  findings.push(...(await verifyNoOtherAgencyInfo(page, config, null, label)));
  return findings;
}

/** 文言テンプレートの {company} を会社名に置き換える */
function fillTemplate(template: string, company: string): string {
  return template.replaceAll('{company}', company);
}

/**
 * 代理店コードの保存先を調べる。
 *
 * 設定 (storage.type) に頼らず、Cookie と localStorage / sessionStorage を
 * **全部見て**、コードの値が入っている場所を探す。
 * キー名が分からなくても分かるように、値で探す。
 *
 * どちらが正解かは未確定なので合否判定はしない (expectedValue: null)。
 * 表に「Cookie」「LS」「両方」「なし」を出して実態を見えるようにする。
 */
export async function observeStorageLocation(
  page: Page,
  code: string,
  label: string,
): Promise<FindingInput[]> {
  const cookies = await page.context().cookies().catch(() => []);
  const cookieHit = cookies.filter((cookie) => cookie.value.includes(code)).map((cookie) => cookie.name);

  const webStorage = await page
    .evaluate((target: string) => {
      const hits: { local: string[]; session: string[] } = { local: [], session: [] };
      const scan = (storage: Storage | null): string[] => {
        const keys: string[] = [];
        if (!storage) return keys;
        try {
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (!key) continue;
            const value = storage.getItem(key) ?? '';
            if (key.includes(target) || value.includes(target)) keys.push(key);
          }
        } catch {
          /* storage が使えない場合は空 */
        }
        return keys;
      };
      hits.local = scan(window.localStorage);
      hits.session = scan(window.sessionStorage);
      return hits;
    }, code)
    .catch(() => ({ local: [] as string[], session: [] as string[] }));

  const places: string[] = [];
  if (cookieHit.length > 0) places.push('Cookie');
  if (webStorage.local.length > 0) places.push('LS');
  if (webStorage.session.length > 0) places.push('SS');

  const detail = [
    cookieHit.length > 0 ? `Cookie: ${cookieHit.join(', ')}` : '',
    webStorage.local.length > 0 ? `localStorage: ${webStorage.local.join(', ')}` : '',
    webStorage.session.length > 0 ? `sessionStorage: ${webStorage.session.join(', ')}` : '',
  ]
    .filter((part) => part !== '')
    .join(' / ');

  return [
    {
      checkId: 'storage',
      // 正解が未確定なので合否は判定しない (表では色を付けない)
      checkOk: true,
      observedValue: places.length === 0 ? 'なし' : places.join('+'),
      // どこに保存するのが正しいかは未確定。赤にはしない
      expectedValue: null,
      category: 'agency-persistence',
      severity: 'low',
      title: `[確認OK] ${label}: 代理店コードの保存先`,
      expected: '保存先を記録する (正解が未確定のため合否は判定しない)',
      actual: places.length === 0 ? '保存されていません' : detail,
      url: page.url(),
      agencyCode: code,
    },
  ];
}

/**
 * 代理店コードによる表示ルールを検査する。
 *
 * このサイトで代理店コードによって変わるのは次の 3 点だけ。
 * いずれもセレクタ (data-testid) を知らなくても文言で判定できる。
 *   - ヘッダーに代理店名が出る
 *   - フッターに「募集代理店：<会社名>」が出る
 *   - みらやく掲載不可の代理店は「あんしんパック」の記載が一切ない
 *
 * 合否どちらの場合も checkId 付きの結果を返す。
 * ダッシュボードの「代理店 × 検査項目」の表を作るために必要。
 */
export async function verifyDisplayRules(
  page: Page,
  config: QaConfig,
  spec: { company?: string; agencyName?: 'shown' | 'hidden'; anshinPack?: 'present' | 'absent' | 'ignore' },
  label: string,
): Promise<FindingInput[]> {
  const texts = config.agency.agencyNameTexts;
  if (!texts) return [];

  // 表示されているテキストで判定する (DOM に残っていても非表示なら「無い」)
  const rawBody = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const body = rawBody.replace(/\s+/g, ' ');

  /**
   * 実際に表示されている代理店名を読み取る。
   *
   * 期待した名前と見比べるのではなく、**出ている名前をそのまま出す**。
   * マスタ (スプレッドシート) の会社名は社内の管理名になっている場合があり
   * (例「Sasuke（募集人8）」)、見比べると正常なサイトを不具合として報告する。
   * サイトの表示が正しいので、出ている名前を表に載せて人が見て判断する。
   *
   * 名前はフッターの「募集代理店：<会社名>」から取り、
   * ヘッダーにはその名前が出ているかを見る (同じ会社名が入るため)。
   */
  const footerPrefix = texts.footer.split('{company}')[0];
  const displayed = await page
    .evaluate(
      ({ prefix, headerSelectors, footerSelectors }: {
        prefix: string;
        headerSelectors: string[];
        footerSelectors: string[];
      }) => {
        const pick = (selectors: string[]): HTMLElement | null => {
          for (const selector of selectors) {
            try {
              const element = document.querySelector(selector);
              if (element instanceof HTMLElement) return element;
            } catch {
              /* セレクタが不正な場合は次へ */
            }
          }
          return null;
        };
        const whole = document.body?.innerText ?? '';
        const footerElement = pick(footerSelectors);
        const headerElement = pick(headerSelectors);
        // 「募集代理店：」の直後から行末までを会社名とみなす
        const nameFrom = (text: string): string => {
          if (prefix === '') return '';
          const index = text.indexOf(prefix);
          if (index < 0) return '';
          return text.slice(index + prefix.length).split('\n')[0].trim().slice(0, 60);
        };
        return {
          name: nameFrom(footerElement?.innerText ?? whole),
          headerText: headerElement?.innerText ?? '',
          foundHeaderElement: Boolean(headerElement),
          foundFooterElement: Boolean(footerElement),
        };
      },
      {
        prefix: footerPrefix,
        headerSelectors: texts.headerSelectors ?? ['header'],
        footerSelectors: texts.footerSelectors ?? ['footer'],
      },
    )
    .catch(() => ({ name: '', headerText: '', foundHeaderElement: false, foundFooterElement: false }));

  // ヘッダーに出ている代理店名。
  //   ヘッダーの要素が見つからない場合はページ全体で見る (判定は甘くなる)。
  const headerName =
    displayed.name !== '' &&
    (displayed.foundHeaderElement ? displayed.headerText.includes(displayed.name) : body.includes(displayed.name))
      ? displayed.name
      : '';
  const footerName = displayed.name;
  const locateHint = displayed.foundHeaderElement
    ? undefined
    : 'ヘッダーの要素が見つからなかったため、ページ全体から探しました ' +
      '(config/agency.yml の agencyNameTexts.headerSelectors に実サイトの指定を足すと精度が上がります)。';

  const findings: FindingInput[] = [];

  // observedValue / expectedValue はチェックリストの表に「あり / なし」を
  // そのまま出すために持たせる。合否だけでは どちらだったか が表に出せない。
  const pass = (checkId: CheckId, title: string, actual: string, value: 'あり' | 'なし'): FindingInput => ({
    checkId,
    checkOk: true,
    observedValue: value,
    expectedValue: value,
    category: 'agency-display',
    severity: 'low',
    title: `[確認OK] ${label}: ${title}`,
    expected: title,
    actual,
    url: page.url(),
  });
  const fail = (
    checkId: CheckId,
    title: string,
    expected: string,
    actual: string,
    value: 'あり' | 'なし',
  ): FindingInput => ({
    checkId,
    checkOk: false,
    // 期待とは逆の値が見えた、ということ
    observedValue: value,
    expectedValue: value === 'あり' ? 'なし' : 'あり',
    category: 'agency-display',
    severity: 'critical',
    title: `${label}: ${title}`,
    expected,
    actual,
    url: page.url(),
  });

  // ---- 代理店名 (ヘッダー / フッター) ----
  //
  //   表に出すのは「表示されている会社名」そのもの。出ていなければ「なし」。
  //   色は次で決める (値の一致では決めない)。
  //     出るべきなのに「なし」          … 赤
  //     出てはいけないのに出ている      … 赤
  //     それ以外 (仕様どおり)          … 白
  if (spec.agencyName === 'shown' || spec.agencyName === 'hidden') {
    const shouldShow = spec.agencyName === 'shown';
    const entries: Array<{ checkId: CheckId; where: string; name: string }> = [
      { checkId: 'header-name', where: 'ヘッダー', name: headerName },
      { checkId: 'footer-name', where: 'フッター', name: footerName },
    ];

    for (const entry of entries) {
      const shown = entry.name !== '';
      const ok = shown === shouldShow;
      const value = shown ? entry.name : 'なし';
      findings.push({
        checkId: entry.checkId,
        checkOk: ok,
        // 表にはこの値がそのまま出る
        observedValue: value,
        expectedValue: shouldShow ? '代理店名が出ること' : 'なし',
        category: 'agency-display',
        severity: ok ? 'low' : 'critical',
        title: ok
          ? `[確認OK] ${label}: ${entry.where}の代理店名`
          : shouldShow
            ? `${label}: ${entry.where}に代理店名が表示されていません`
            : `${label}: ${entry.where}に代理店名が表示されています`,
        expected: shouldShow ? `${entry.where}に代理店名が表示されること` : `${entry.where}に代理店名が表示されないこと`,
        actual: shown ? `「${entry.name}」が表示されています` : '表示されていません',
        url: page.url(),
        detail: entry.checkId === 'header-name' ? locateHint : undefined,
      });
    }
  }

  // ---- あんしんパック ----
  const mode = spec.anshinPack ?? 'ignore';
  if (mode !== 'ignore') {
    const variants = texts.anshinPack ?? [];

    // 判定の前に「安心パックなし」のような表記を取り除く。
    //   これは保険料の前提条件として注釈に出るもので、商品の案内ではない。
    //   「安心パックなし」の「安心パック」を数えると、
    //   みらやく掲載不可の代理店が毎回 Critical になる (実サイトで発生)。
    //   取り除いた件数は結果に併記し、黙って無視はしない。
    const ignored: string[] = [];
    let judged = body;
    for (const phrase of texts.anshinPackIgnore ?? []) {
      if (phrase === '') continue;
      const count = judged.split(phrase).length - 1;
      if (count > 0) {
        ignored.push(`${phrase} × ${count}`);
        judged = judged.split(phrase).join('');
      }
    }
    const excluded = ignored.length > 0 ? ` (注釈として除外: ${ignored.join(', ')})` : '';

    const found = variants.filter((variant) => judged.includes(variant));
    if (mode === 'present') {
      findings.push(
        found.length > 0
          ? pass('anshin-pack', '「あんしんパック」の表示がある', `「${found.join('」「')}」を確認${excluded}`, 'あり')
          : fail(
              'anshin-pack',
              '「あんしんパック」の表示がありません',
              `${variants.join(' / ')} のいずれかが表示されること`,
              `表示されていません${excluded}`,
              'なし',
            ),
      );
    } else {
      findings.push(
        found.length === 0
          ? pass('anshin-pack', '「あんしんパック」の表示が一切ない', `${variants.join(' / ')} が無いことを確認${excluded}`, 'なし')
          : fail(
              'anshin-pack',
              '「あんしんパック」が表示されています (みらやく掲載不可)',
              `${variants.join(' / ')} が表示されないこと`,
              `「${found.join('」「')}」が表示されています${excluded}`,
              'あり',
            ),
      );
    }
  }

  return findings;
}
