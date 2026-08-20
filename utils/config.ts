/**
 * config/*.yml の読み込み・環境変数展開・検証。
 * 読み込み結果はプロセス内でキャッシュする。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  AgenciesFile, AgencyFile, DevicesFile, EnvironmentsFile, ErrorsFile, LayoutFile,
  PagesFile, QaConfig, RuntimeFile, TextRulesFile, VisualFile,
} from './types';

export const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');

/** .env を読み込む (依存パッケージを増やさない簡易実装) */
function loadDotEnv(): void {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** 文字列中の ${VAR} を環境変数で置換する。未定義の場合は空文字にする。 */
function interpolate<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name: string) => process.env[name] ?? '') as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolate(v);
    return out as unknown as T;
  }
  return value;
}

function readYaml<T>(fileName: string): T {
  const filePath = path.join(CONFIG_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`設定ファイルが見つかりません: config/${fileName}`);
  }
  const parsed = parseYaml(fs.readFileSync(filePath, 'utf8')) as T;
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`設定ファイルの形式が不正です: config/${fileName}`);
  }
  return interpolate(parsed);
}

/**
 * Basic 認証情報を正規化する。
 *
 * config/environments.yml には ${STAGING_BASIC_USER} のような参照だけを書き、
 * 値は .env / GitHub Secrets から渡す。未設定の環境変数は空文字に展開されるため、
 * 「認証なし」と「空文字の認証情報」を区別して null に落とす
 * (空文字のまま渡すと Playwright が空の Authorization を送ってしまう)。
 */
export function normalizeHttpCredentials(
  credentials: { username: string; password: string } | null | undefined,
): { username: string; password: string } | null {
  const username = credentials?.username?.trim();
  const password = credentials?.password?.trim();
  if (!username || !password) return null;
  return { username, password };
}

let cached: QaConfig | null = null;

export function loadConfig(): QaConfig {
  if (cached) return cached;
  loadDotEnv();

  const environments = readYaml<EnvironmentsFile>('environments.yml');
  const environmentName = process.env.QA_ENV?.trim() || environments.defaultEnvironment;
  const environment = environments.environments[environmentName];

  if (!environment) {
    throw new Error(
      `未定義の環境です: QA_ENV=${environmentName}. 利用可能: ${Object.keys(environments.environments).join(', ')}`,
    );
  }
  if (!environment.baseUrl) {
    throw new Error(
      `環境「${environmentName}」の baseUrl が空です。config/environments.yml の参照先環境変数 (.env / GitHub Secrets) を設定してください。`,
    );
  }
  // 末尾スラッシュを正規化
  environment.baseUrl = environment.baseUrl.replace(/\/+$/, '');
  environment.applicationBaseUrl = (environment.applicationBaseUrl ?? '').replace(/\/+$/, '');
  environment.httpCredentials = normalizeHttpCredentials(environment.httpCredentials);

  const config: QaConfig = {
    environmentName,
    environment,
    environments,
    devices: readYaml<DevicesFile>('devices.yml'),
    runtime: readYaml<RuntimeFile>('runtime.yml'),
    agency: readYaml<AgencyFile>(environment.agencyFile ?? 'agency.yml'),
    agencies: readYaml<AgenciesFile>(environment.agenciesFile ?? 'agencies.yml'),
    pages: readYaml<PagesFile>(environment.pagesFile ?? 'pages.yml'),
    layout: readYaml<LayoutFile>('layout.yml'),
    visual: readYaml<VisualFile>('visual.yml'),
    errors: readYaml<ErrorsFile>('errors.yml'),
    text: readYaml<TextRulesFile>('text-rules.yml'),
  };

  validateConfig(config);
  cached = config;
  return config;
}

/**
 * 設定の妥当性を検証する。不備があれば内容を列挙して例外を投げる。
 * 運用者が編集する頻度が高いため、どこが問題かを明示する
 * (テストから検証できるよう export している)。
 */
export function validateConfig(config: QaConfig): void {
  const problems: string[] = [];

  if (!config.devices.browsers.some((b) => b.enabled)) {
    problems.push('config/devices.yml: 有効なブラウザが 1 つもありません');
  }
  if (config.devices.devices.length === 0) {
    problems.push('config/devices.yml: devices が空です');
  }
  if (config.pages.source === 'config' && (config.pages.pages ?? []).length === 0) {
    problems.push('config/pages.yml: pages が空です');
  }
  if (!config.agency.paramName) {
    problems.push('config/agency.yml: paramName が未設定です');
  }
  const indicator = config.agency.readyIndicator;
  if (indicator) {
    if (!['attribute', 'selector', 'none'].includes(indicator.type)) {
      problems.push(`config/agency.yml: readyIndicator.type が不正です: ${indicator.type}`);
    }
    if (indicator.type === 'selector' && !indicator.selector) {
      problems.push('config/agency.yml: readyIndicator.type が selector ですが selector が未設定です');
    }
    if (indicator.type === 'attribute' && !indicator.attribute) {
      problems.push('config/agency.yml: readyIndicator.type が attribute ですが attribute が未設定です');
    }
  }
  const agencies = config.agencies.agencies ?? [];
  // 申込導線を検査する代理店が 1 件でもあれば申込ドメインが必要になる。
  // 申込側の仕様が未確定な導入初期は application: null にでき、
  // その場合は申込ドメインの設定も不要とする (LP 側の検査だけ先に始められる)。
  const needsApplicationDomain = agencies.some((agency) => agency.application);
  if (needsApplicationDomain && !config.environment.applicationBaseUrl) {
    problems.push(
      `config/environments.yml: 環境「${config.environmentName}」の applicationBaseUrl が空です (申込ドメインを設定してください)`,
    );
  }
  if (agencies.length === 0) {
    problems.push('config/agencies.yml: agencies が空です');
  }
  const seenCodes = new Set<string>();
  for (const agency of agencies) {
    if (seenCodes.has(agency.code)) problems.push(`config/agencies.yml: 代理店コードが重複しています: ${agency.code}`);
    seenCodes.add(agency.code);
    if (!agency.entryPath) problems.push(`config/agencies.yml: ${agency.code} の entryPath が未設定です`);
    if (!agency.expectedFinalPath) problems.push(`config/agencies.yml: ${agency.code} の expectedFinalPath が未設定です`);
    if (agency.redirected && agency.expectedFinalPath === agency.entryPath) {
      problems.push(`config/agencies.yml: ${agency.code} は redirected: true ですが expectedFinalPath が entryPath と同一です`);
    }
    if (!agency.redirected && agency.expectedFinalPath !== agency.entryPath) {
      problems.push(`config/agencies.yml: ${agency.code} は redirected: false ですが expectedFinalPath が entryPath と異なります`);
    }
    // application: null は「申込導線を検査しない」の明示。
    // 設定されている場合は中身が揃っていることを要求する
    // (中途半端な設定で素通りさせない)。
    if (agency.application) {
      if (!agency.application.expectedPath) {
        problems.push(`config/agencies.yml: ${agency.code} の application.expectedPath が未設定です`);
      }
      if (!agency.application.expectedCode) {
        problems.push(`config/agencies.yml: ${agency.code} の application.expectedCode が未設定です`);
      }
      if ((agency.application.recognition ?? []).length === 0) {
        problems.push(
          `config/agencies.yml: ${agency.code} の application.recognition が空です (URL だけで合格にしないため 1 つ以上必要)`,
        );
      }
    }
    const overlap = agency.visibleSections.filter((section) => agency.hiddenSections.includes(section));
    if (overlap.length > 0) {
      problems.push(`config/agencies.yml: ${agency.code} の visibleSections と hiddenSections が重複しています: ${overlap.join(', ')}`);
    }
  }
  for (const invalid of config.agencies.invalidCodes ?? []) {
    if (seenCodes.has(invalid.code)) {
      problems.push(`config/agencies.yml: ${invalid.code} が agencies と invalidCodes の両方に定義されています`);
    }
  }
  // source: sitemap のときは pages が空でもよいため null ガードする
  const pageIds = new Set((config.pages.pages ?? []).map((p) => p.id));
  if (config.pages.source === 'config') {
    for (const id of config.agency.persistenceFlow) {
      if (!pageIds.has(id)) problems.push(`config/agency.yml: persistenceFlow の未知のページ id: ${id}`);
    }

  }
  if (problems.length > 0) {
    throw new Error(`設定に不備があります:\n - ${problems.join('\n - ')}`);
  }
}

/** 有効なブラウザ ID の一覧 */
export function enabledBrowsers(config: QaConfig): string[] {
  return config.devices.browsers.filter((b) => b.enabled).map((b) => b.id);
}

/** CI 実行かどうか */
export function isCi(): boolean {
  return Boolean(process.env.CI);
}

/**
 * 設定値のセレクタ表記を CSS セレクタに解決する。
 *   "agency-name"          -> [data-testid="agency-name"]
 *   "css=.foo"             -> .foo
 *   "text=申し込み"         -> Playwright の text エンジンをそのまま使用
 */
export function resolveSelector(value: string): string {
  if (value.startsWith('css=')) return value.slice(4);
  if (value.startsWith('text=') || value.startsWith('xpath=')) return value;
  return `[data-testid="${value}"]`;
}

/** agency.yml の selectors キー名 or data-testid を CSS セレクタに解決する */
export function resolveAgencySelector(config: QaConfig, key: string): string {
  const mapped = config.agency.selectors[key];
  return resolveSelector(mapped ?? key);
}

/** data-testid を CSS セレクタにする */
export function testId(value: string): string {
  return resolveSelector(value);
}

/** 申込ドメインの絶対 URL を組み立てる */
export function applicationUrl(config: QaConfig, applicationPath: string): string {
  return new URL(applicationPath, `${config.environment.applicationBaseUrl}/`).toString();
}

/** 代理店仕様の申込先ホスト (未指定なら環境の申込ドメイン) */
export function expectedApplicationHost(config: QaConfig, expectedDomain: string | null | undefined): string {
  if (expectedDomain) return expectedDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return new URL(config.environment.applicationBaseUrl).host;
}

/** ページの絶対 URL を組み立てる */
export function pageUrl(config: QaConfig, pagePath: string, params?: Record<string, string>): string {
  const url = new URL(pagePath, `${config.environment.baseUrl}/`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return url.toString();
}
