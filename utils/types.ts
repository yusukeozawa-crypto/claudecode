/**
 * 設定ファイル (config/*.yml) と検査結果の型定義。
 * サイト固有の値は一切ここに書かず、すべて設定ファイル側で管理する。
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type FindingCategory =
  | 'agency-display'      // 代理店コードによる表示・非表示 (誤表示を含む)
  | 'agency-persistence'  // ページ遷移後のコード保持
  | 'agency-handoff'      // 申込画面への引き継ぎ
  | 'agency-redirect'     // 代理店ごとのリダイレクト仕様
  | 'redirect-mechanism'  // 仕様と異なる遷移方式 (警告)
  | 'security'            // open redirect / XSS / 情報漏えい
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
  /** 申込ドメイン (LP とは別ドメイン) */
  applicationBaseUrl: string;
  readOnly: boolean;
  startLocalServer?: boolean;
  httpCredentials?: { username: string; password: string } | null;
  /**
   * この環境で使う代理店設定ファイル名 (config/ 配下)。
   * 省略時は agency.yml / agencies.yml。
   * モックサイトと実サイトでは代理店コードもパラメータ名も異なるため、
   * 環境ごとに切り替えられるようにしている。
   */
  agencyFile?: string;
  agenciesFile?: string;
  /** この環境で検査するページ一覧のファイル名 (config/ 配下)。省略時は pages.yml */
  pagesFile?: string;
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
  /** トレース取得 (通信内容が含まれるため共有範囲に注意) */
  trace: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
  traceCi: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
  failOnSeverities: Severity[];
  /** 代理店の組み合わせ検証の上限 (代理店数の二乗で増えるため) */
  maxAgencyPairs?: number;
}

// ---------- config/agency.yml (共通の仕組み) ----------
export interface AgencyFile {
  paramName: string;
  /**
   * 代理店コードの保存先。
   * none = 保存しない実装 (URL のみで引き回す) / 保存方式が未確認。
   * この場合、保存値の検査は行わず「未検査」として記録する。
   */
  storage: { type: 'cookie' | 'localStorage' | 'both' | 'none'; key: string };
  selectors: Record<string, string>;
  application: {
    sessionApiPattern: string;
    /** 絶対に発生させてはならないリクエスト (申込完了・データ送信) */
    forbiddenRequestPatterns: string[];
    /** 押してはならない要素 */
    forbiddenTestIds: string[];
  };
  /** 代理店表示の描画完了をどう判定するか */
  readyIndicator: {
    type: 'attribute' | 'selector' | 'none';
    attribute?: string | null;
    value?: string | null;
    selector?: string | null;
    timeoutMs: number;
  };
  persistenceFlow: string[];
}

// ---------- config/agencies.yml (代理店ごとの個別仕様) ----------
export type RedirectMechanism = 'none' | 'http' | 'js' | 'meta-refresh' | 'spa' | 'unknown';

/** リダイレクト経路の記録結果 (utils/redirect.ts が生成する) */
export interface RedirectTrace {
  entryUrl: string;
  finalUrl: string;
  hops: Array<{ url: string; status: number | null; location: string | null; kind: 'http' | 'document' | 'history' }>;
  httpRedirectCount: number;
  documentRequestCount: number;
  historyChangeCount: number;
  metaRefreshTargets: string[];
  mechanism: RedirectMechanism;
  loopDetected: boolean;
}

export type HandoffMethod = 'query' | 'hidden' | 'post' | 'api' | 'server-session' | 'token' | 'none';

/** 申込ページ側で「正しい代理店として認識されている」ことの確認方法 */
export type RecognitionCheck =
  | { type: 'text'; testId: string; expected: string }
  | { type: 'hidden'; testId: string; expected: string }
  | { type: 'storage'; storageType: 'localStorage' | 'sessionStorage' | 'cookie'; key: string; expected: string }
  | { type: 'api'; urlPattern: string; field: string; expected: string };

export interface ApplicationStep {
  testId: string;
  expectedPath: string;
}

export interface AgencyApplicationSpec {
  /** null の場合は environments.yml の applicationBaseUrl のホストを使用する */
  expectedDomain: string | null;
  expectedPath: string;
  handoffMethod: HandoffMethod;
  handoffParam: string;
  expectedCode: string;
  recognition: RecognitionCheck[];
  steps: ApplicationStep[];
}

/** 代理店 1 件ぶんの期待結果 */
export interface AgencySpec {
  code: string;
  label: string;
  entryPath: string;
  expectedFinalPath: string;
  redirected: boolean;
  /** 挙動パターン名 (抽選のグループ分けに使う) */
  profile?: string;
  /**
   * サイト側で代理店コードとして認識されるか。
   * false = 受け取っても何もしない (支店コードなど)。
   * 保存・引き継ぎ・代理店表示のいずれも期待しない。
   * 省略時は true。
   */
  recognized?: boolean;
  redirectMechanism: RedirectMechanism;
  /**
   * 期待するリダイレクト回数。
   * null = まだ実測していない。回数の照合は行わず、実測値を記録する
   * (推測した回数で判定すると、正常なサイトを不具合として報告してしまう)。
   */
  expectedRedirectCount: number | null;
  expectedRedirectPaths: string[];
  /**
   * 再訪時のリダイレクト。
   *   コードを付けて入った後 (= 保存済みの状態) に fromPath を開くと
   *   toPath へリダイレクトされる、という挙動を検査する。
   *   null = 再訪してもリダイレクトされない (fromPath に留まる)。
   */
  revisitRedirect?: { fromPath: string; toPath: string } | null;
  visibleSections: string[];
  hiddenSections: string[];
  expectedTexts: Record<string, string>;
  expectedAssets: Record<string, string>;
  /**
   * 申込へ進む CTA。
   * null の場合は CTA が未確認であることを示し、CTA 起点の検査は行わない。
   */
  cta: { testId: string; expectedText?: string | null } | null;
  /**
   * 申込ページへの引き継ぎ仕様。
   * null の場合は申込導線の検査を行わない
   * (導入初期に申込側の仕様が未確定でも LP 側の検査を始められるようにする)。
   */
  application: AgencyApplicationSpec | null;
}

/**
 * 申込導線の検査対象となる代理店仕様。
 * application が null の代理店は検査対象から除外するため、
 * 申込関連の処理はこの型を受け取る (null チェックを各所に散らさない)。
 */
export type AgencySpecWithApplication = AgencySpec & {
  application: AgencyApplicationSpec;
  cta: NonNullable<AgencySpec['cta']>;
};

/** 無効コード / コードなしの期待結果 */
export interface FallbackExpectation {
  entryPath: string;
  expectedFinalPath: string;
  redirected: boolean;
  redirectMechanism: RedirectMechanism;
  visibleSections: string[];
  hiddenSections: string[];
  expectedTexts: Record<string, string>;
  expectStored: boolean;
  application: {
    expectedDomain?: string | null;
    expectedPath: string;
    expectDefaultRoute: boolean;
    defaultRouteTestId: string;
    forbiddenTestIds: string[];
  };
}

export interface AgencyScope {
  /** sample = パターンごとに抽選する / all = 全件を検査する */
  mode: 'sample' | 'all';
  /** パターンごとに抽選する件数 */
  perProfile: number;
  /** 抽選に関わらず必ず含める代理店コード */
  always: string[];
}

export interface AgenciesFile {
  /** 実行時の抽選設定 (省略時は全件) */
  scope?: AgencyScope;
  /**
   * 表示が異なるべきパターンの組み合わせ。
   * みらやくの表示差分はセクション・フッター・注釈など複数箇所に及び、
   * どこが変わるかを列挙しきれないため、
   * 「同じパターンなら一致」「異なるパターンなら相違」で検査する。
   */
  displayMustDiffer?: string[][];
  /** 表示比較から除外する鍵 (実行ごとに出入りする要素) */
  displayIgnoreKeys?: string[];
  /**
   * コードなしの表示と一致するはずのパターン名。
   * 支店コードのように「コードを付けても何も変わらない」ものを検査する。
   */
  sameAsNoCodeProfiles?: string[];
  agencies: AgencySpec[];
  invalidCodes: Array<{ code: string; label: string }>;
  invalidExpectation: FallbackExpectation;
  noCodeExpectation: FallbackExpectation;
  redirect: {
    maxRedirects: number;
    allowedQueryParams: string[];
    forbiddenQueryParamKeywords: string[];
    piiValuePatterns: string[];
  };
  security: {
    redirectParamNames: string[];
    externalProbeUrl: string;
    allowedRedirectOrigins: string[];
    xssPayloads: string[];
    maskParamNames: string[];
    maskValuePatterns: string[];
  };
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
  capture: { fullPage: boolean; outputDir: string; timeoutMs?: number };
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
  /** 実行環境側の一時的な通信断 (サイトの不具合ではない) */
  transientNetworkPatterns?: string[];
  network: {
    enabled: boolean;
    failStatuses: number[];
    ignoreUrlPatterns: string[];
    ignoreThirdParty: boolean;
    /** 画面遷移で中断されたリクエスト (net::ERR_ABORTED) を無視するか */
    ignoreAbortedRequests: boolean;
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
  agencies: AgenciesFile;
  pages: PagesFile;
  layout: LayoutFile;
  visual: VisualFile;
  errors: ErrorsFile;
  text: TextRulesFile;
}
