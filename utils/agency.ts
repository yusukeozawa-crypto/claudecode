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
  const body = await page
    .evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' '))
    .catch(() => '');

  const findings: FindingInput[] = [];
  const company = spec.company ?? '';
  const fill = (template: string): string => template.replaceAll('{company}', company);

  const pass = (checkId: CheckId, title: string, actual: string): FindingInput => ({
    checkId,
    category: 'agency-display',
    severity: 'low',
    title: `[確認OK] ${label}: ${title}`,
    expected: title,
    actual,
    url: page.url(),
  });
  const fail = (checkId: CheckId, title: string, expected: string, actual: string): FindingInput => ({
    checkId,
    category: 'agency-display',
    severity: 'critical',
    title: `${label}: ${title}`,
    expected,
    actual,
    url: page.url(),
  });

  // ---- 代理店名 (ヘッダー / フッター) ----
  if (spec.agencyName === 'shown' && company !== '') {
    const header = fill(texts.header);
    const footer = fill(texts.footer);
    findings.push(
      body.includes(header)
        ? pass('header-name', 'ヘッダーに代理店名が表示されている', `「${header}」を確認`)
        : fail('header-name', 'ヘッダーに代理店名が表示されていません', `「${header}」が表示されること`, '表示されていません'),
    );
    findings.push(
      body.includes(footer)
        ? pass('footer-name', 'フッターに代理店名が表示されている', `「${footer}」を確認`)
        : fail('footer-name', 'フッターに代理店名が表示されていません', `「${footer}」が表示されること`, '表示されていません'),
    );
  } else if (spec.agencyName === 'hidden') {
    // 判定はページ全体の表示テキストで行うため、ヘッダーとフッターの
    // 両方について「出ていない」ことを確認できている。
    // 片方だけ結果を残すと、表で「もう片方は未検査」に見えてしまう。
    const forbidden = texts.forbiddenWhenHidden;
    const shown = body.includes(forbidden);
    for (const checkId of ['header-name', 'footer-name'] as CheckId[]) {
      findings.push(
        shown
          ? fail(
              checkId,
              '代理店名が表示されています',
              `「${forbidden}」が表示されないこと`,
              `「${forbidden}」が表示されています`,
            )
          : pass(checkId, '代理店名が表示されない', `「${forbidden}」が無いことを確認`),
      );
    }
  }

  // ---- あんしんパック ----
  const mode = spec.anshinPack ?? 'ignore';
  if (mode !== 'ignore') {
    const variants = texts.anshinPack ?? [];
    const found = variants.filter((variant) => body.includes(variant));
    if (mode === 'present') {
      findings.push(
        found.length > 0
          ? pass('anshin-pack', '「あんしんパック」の表示がある', `「${found.join('」「')}」を確認`)
          : fail(
              'anshin-pack',
              '「あんしんパック」の表示がありません',
              `${variants.join(' / ')} のいずれかが表示されること`,
              '表示されていません',
            ),
      );
    } else {
      findings.push(
        found.length === 0
          ? pass('anshin-pack', '「あんしんパック」の表示が一切ない', `${variants.join(' / ')} が無いことを確認`)
          : fail(
              'anshin-pack',
              '「あんしんパック」が表示されています (みらやく掲載不可)',
              `${variants.join(' / ')} が表示されないこと`,
              `「${found.join('」「')}」が表示されています`,
            ),
      );
    }
  }

  return findings;
}
