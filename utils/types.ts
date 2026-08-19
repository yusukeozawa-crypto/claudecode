/**
 * 設定ファイル (config/*.yml) と検査結果の型定義。
 * サイト固有の値は一切ここに書かず、すべて設定ファイル側で管理する。
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type FindingCategory =
  | 'agency-display'      // 代理店コードによる表示・非表示
  | 'agency-persistence'  // ページ遷移後のコード保持
  | 'agency-handoff'      // 申込画面への引き継ぎ
  | 'layout'              // 表示崩れ
  | 'horizontal-scroll'   // 横スクロール
  | 'broken-link'         // リンク切れ
  | 'image-error'         // 画像読み込みエラー
  | 'js-error'            // JavaScript エラー
  | 'network-error'       // 4xx / 5xx
  | 'timeout'             // タイムアウト
  | 'redirect-loop'       // リダイレクトループ
  | 'visual-diff'         // 画像差分
  | 'text-rule'           // 誤字脱字・表記揺れ
  | 'config';             // 設定不備

/** 1 件の不具合検知結果 */
export interface Finding {
  severity: Severity;
  category: FindingCategory;
  /** 何を検査したか */
  title: string;
  /** 期待結果 */
  expected?: string;
  /** 実際の結果 */
  actual?: string;
  /** 再現に使用した URL */
  url: string;
  pageId?: string;
  pageName?: string;
  deviceId?: string;
  browserId?: string;
  /** 検査時に使用した代理店コード ('none' = コードなし) */
  agencyCode?: string;
  /** レポートから参照するスクリーンショット (reports/ からの相対パス) */
  screenshots?: string[];
  /** 補足情報 */
  detail?: string;
}

/**
 * Finding の入力形。severity を省略するとカテゴリごとの既定値
 * (utils/findings.ts の DEFAULT_SEVERITY) が使われ、url を省略すると
 * 現在の検査対象 URL が使われる。
 */
export type FindingInput = Omit<Finding, 'severity' | 'url'> & {
  severity?: Severity;
  url?: string;
};

/** レポート出力用に 1 テスト分の結果をまとめたもの */
export interface QaRecord {
  testId: string;
  testTitle: string;
  suite: string;
  environment: string;
  environmentLabel: string;
  baseUrl: string;
  browserId: string;
  deviceId: string;
  deviceLabel: string;
  pageId?: string;
  pageName?: string;
  agencyCode?: string;
  url?: string;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  durationMs: number;
  startedAt: string;
  findings: Finding[];
  /** 検査そのものが失敗した場合のエラーメッセージ */
  errorMessage?: string;
  attachedScreenshots?: string[];
}

// ---------- config/environments.yml ----------
export interface EnvironmentConfig {
  label: string;
  baseUrl: string;
  readOnly: boolean;
  startLocalServer?: boolean;
  httpCredentials?: { username: string; password: string } | null;
}
export interface EnvironmentsFile {
  defaultEnvironment: string;
  environments: Record<string, EnvironmentConfig>;
}

// ---------- config/devices.yml ----------
export type BrowserId = 'chromium' | 'firefox' | 'webkit';
export interface BrowserConfig {
  id: BrowserId;
  enabled: boolean;
}
export interface DeviceConfig {
  id: string;
  label: string;
  viewport: { width: number; height: number };
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
}
export interface DevicesFile {
  browsers: BrowserConfig[];
  devices: DeviceConfig[];
}

// ---------- config/runtime.yml ----------
export interface RuntimeFile {
  workers: number;
  workersCi: number;
  retries: number;
  retriesCi: number;
  timeouts: { test: number; navigation: number; action: number; expect: number };
  throttle: {
    navigationDelayMs: number;
    linkCheckDelayMs: number;
    linkCheckConcurrency: number;
  };
  failOnSeverities: Severity[];
}

// ---------- config/agency.yml ----------
export interface AgencyCodeSpec {
  code: string;
  valid: boolean;
  label: string;
  expectedName?: string;
  expectedContact?: string;
}
export interface AgencyExpectation {
  visible: string[];
  hidden: string[];
  texts: Record<string, string>;
}
export interface AgencyFile {
  paramName: string;
  storage: { type: 'cookie' | 'localStorage' | 'both'; key: string };
  selectors: Record<string, string>;
  codes: AgencyCodeSpec[];
  expectations: {
    none: AgencyExpectation;
    valid: AgencyExpectation;
    invalid: AgencyExpectation;
  };
  application: {
    targetPageId: string;
    expectParamInUrl: boolean;
    hiddenField?: { testId: string; name?: string | null } | null;
    requests: Array<{ urlPattern: string; field: string; skipWhenReadOnly?: boolean }>;
  };
  persistenceFlow: string[];
}

// ---------- config/pages.yml ----------
export type PageCheck = 'layout' | 'errors' | 'links' | 'visual' | 'text';
export interface PageConfig {
  id: string;
  name: string;
  path: string;
  agencyAware?: boolean;
  checks: PageCheck[];
  requiredTestIds?: string[];
  primaryTestIds?: string[];
}
export interface PagesFile {
  source: 'config' | 'sitemap';
  sitemap: {
    path: string;
    maxPages: number;
    includePatterns: string[];
    excludePatterns: string[];
    defaults: { agencyAware: boolean; checks: PageCheck[] };
  };
  pages: PageConfig[];
}

// ---------- config/layout.yml ----------
export interface LayoutFile {
  horizontalScroll: { enabled: boolean; tolerancePx: number };
  viewportOverflow: { enabled: boolean; tolerancePx: number; ignoreTestIds: string[] };
  overlap: { enabled: boolean; maxOverlapRatio: number; ignoreTestIds: string[] };
  images: { enabled: boolean; scrollThroughPage: boolean; ignoreUrlPatterns: string[] };
  emptyScreen: {
    enabled: boolean;
    minVisibleTextLength: number;
    maxElementHeightRatio: number;
  };
}

// ---------- config/visual.yml ----------
export interface VisualFile {
  enabled: boolean;
  capture: { fullPage: boolean; outputDir: string };
  compare: {
    threshold: number;
    maxDiffPixelRatio: number | null;
    maxDiffPixels: number | null;
    animations: 'disabled' | 'allow';
    caret: 'hide' | 'initial';
    stabilizeDelayMs: number;
  };
  mask: string[];
  maskColor: string;
}

// ---------- config/errors.yml ----------
export interface ErrorsFile {
  console: { enabled: boolean; levels: string[]; ignoreMessages: string[] };
  pageError: { enabled: boolean; ignoreMessages: string[] };
  network: {
    enabled: boolean;
    failStatuses: number[];
    ignoreUrlPatterns: string[];
    ignoreThirdParty: boolean;
  };
  links: {
    enabled: boolean;
    scope: 'internal' | 'all';
    externalMethod: 'HEAD' | 'GET';
    ignoreUrlPatterns: string[];
    maxLinksPerPage: number;
    maxRedirects: number;
  };
  timeout: { pageLoadWarnMs: number };
}

// ---------- config/text-rules.yml ----------
export interface UnifyRule {
  id: string;
  preferred: string | null;
  variants: string[];
  detectOnly?: boolean;
  note?: string;
}
export interface TextRulesFile {
  extract: {
    enabled: boolean;
    outputDir: string;
    formats: Array<'json' | 'csv'>;
    excludeSelectors: string[];
  };
  canonical: {
    companyName: string;
    productNames: string[];
    aliases: Record<string, string>;
  };
  unifyRules: UnifyRule[];
  insuranceTerms: Array<{ preferred: string; variants: string[] }>;
  prohibited: Array<{ pattern: string; reason: string }>;
  typoPatterns: Array<{ wrong: string; correct: string; exceptWhenFollowedBy?: string[] }>;
  excludeWords: string[];
  formatting: {
    detectDoubleSpace: boolean;
    detectFullWidthAlphaNum: boolean;
    detectTrailingPunctuationMix: boolean;
  };
  aiCheck: {
    enabled: boolean;
    provider: string;
    apiKeyEnv: string;
    maxCharsPerPage: number;
  };
}

/** 全設定をまとめたもの */
export interface QaConfig {
  environmentName: string;
  environment: EnvironmentConfig;
  environments: EnvironmentsFile;
  devices: DevicesFile;
  runtime: RuntimeFile;
  agency: AgencyFile;
  pages: PagesFile;
  layout: LayoutFile;
  visual: VisualFile;
  errors: ErrorsFile;
  text: TextRulesFile;
}
