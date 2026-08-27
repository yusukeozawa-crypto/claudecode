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

/**
 * 検査項目の識別子。
 * ダッシュボードのチェックリスト (代理店 × 項目) を作るために使う。
 */
export type CheckId =
  | 'code-effective' // 代理店コードで表示が変わる (コードが効いているか)
  | 'redirect'      // 専用 LP へのリダイレクト
  | 'header-name'   // ヘッダーの代理店名
  | 'footer-name'   // フッターの「募集代理店：<会社名>」
  | 'anshin-pack'   // 「あんしんパック」の表示 / 非表示
  | 'code-applied'  // LP 側で代理店コードが付与されている
  | 'code-carry'    // 申込フォームでのコード保持
  | 'storage'       // 代理店コードの保存先 (Cookie / localStorage)
  | 'other-issues'; // 上の項目に入らない異常 (console エラー・404・表示崩れなど)

/** 1 件の不具合検知結果 */
export interface Finding {
  /** どの検査項目の結果か (チェックリスト表示用)。合否どちらでも入る */
  checkId?: CheckId;
  /**
   * チェックリストの表に出す値。
   *   observedValue … 実際にそうだったか ("あり" / "なし" / "Cookie" など)
   *   expectedValue … そうあるべきだった値。null = 正解が未確定 (赤にしない)
   * 合否 (severity) だけでは「あり/なし のどちらだったか」が表に出せない。
   */
  observedValue?: string;
  expectedValue?: string | null;
  /**
   * 表のセルで値の下に小さく併記する行。
   *   例) 「あり」の下に "littlefamily03" と "URL, Cookie" を出す。
   * 「あり」だけでは本当に見に行ったのか分からないため、
   * 何を見て判断したのかを人にも見えるようにする。
   * 未指定の場合は actual から自動で 1 行だけ取り出す。
   */
  observedDetail?: string[];
  /**
   * 端末をまたいで一致すべき値。
   *
   *   PC と SP は別々に実行されるため、1 つのテストの中から
   *   「もう片方の端末では何と書いてあったか」は見られない。
   *   ここに値を入れておくと、レポートを作る段階で端末間を見比べ、
   *   食い違っていれば報告する。
   *
   *   例) 申込ボタンの文言。PC「今すぐ申込む」/ SP「今すぐ申し込む」の
   *       ような表記ゆれは、端末を分けて見ている限り気づけない。
   */
  sameAcrossDevices?: { key: string; label: string; value: string };
  /**
   * 仕様どおりだったか。
   * 表の色 (白 / 赤) はこれで決める。
   * 見えた値をそのまま出す項目 (代理店名など) では
   * 値の一致では合否を決められないため、明示的に持つ。
   */
  checkOk?: boolean;
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
  /**
   * User-Agent の末尾に付ける印。
   * 計測タグを止めずに検査するため、このツールのアクセスは
   * 計測ツールの数字に混ざる。除外設定に使えるようにする。
   */
  userAgentSuffix?: string;
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
   * 代理店名の表示を検査する文言。{company} は会社名に置き換わる。
   * サイトの文言が変わったらここだけ直せばよい。
   */
  agencyNameTexts?: {
    header: string;
    footer: string;
    /** 代理店名が出ないはずの場合に、出ていないことを確認する文字列 */
    forbiddenWhenHidden: string;
    /** 「あんしんパック」の表記 (複数の書き方があれば列挙) */
    anshinPack: string[];
    /**
     * あんしんパックの判定から除外する表記。
     * 「安心パックなし」のように保険料の前提条件として注釈に出るものは
     * 商品の案内ではないため、判定前に文章から取り除く。
     */
    anshinPackIgnore?: string[];
    /**
     * 注釈の目印。
     * 安心パックは資格の問題で、注釈として小さく併記するのは可、
     * 訴求として出すのは不可。その区別に使う。
     */
    anshinPackAnnotationMarkers?: string[];
    /**
     * 否定表現。
     * 「安心パックなし」は「付かない場合」で訴求の正反対。
     * 保険料の前提条件として注釈に出るもので、資格の問題にはあたらない。
     */
    anshinPackNegations?: string[];
    /**
     * 文字の大きさに関係なく違反とする文言。
     *
     * 商品仕様・商品比較のテーブルのように、HTML の table ではなく
     * div で組まれている場所は構造から判定できない。
     * 実物を見て「掲載不可では出てはいけない」と判断したものを名指しで書く。
     * 端末で文字サイズが変わっても判定がぶれない。
     */
    anshinPackAlwaysForbidden?: Array<{ text: string; reason?: string }>;
    /**
     * 文字の大きさに関係なく許可する文言。
     *
     * 掲載不可 (×) の代理店でも出てよいと運用側が判断したもの
     * (「安心パックなしの場合」= 保険料の前提条件)。
     * 否定表現の判定でも許可されるが、判定の仕組みが変わっても
     * 許可され続けるように、運用側の判断として明示的に残す。
     * 端末で文字サイズが変わっても判定がぶれない。
     */
    anshinPackAlwaysAllowed?: Array<{ text: string; reason?: string }>;
    /**
     * 代理店名を読み取る場所。上から順に最初に見つかった要素を使う。
     * 見つからない場合はページ全体から探す (判定は甘くなる)。
     */
    /** ヘッダーの代理店名を出す端末 (既定は pc と sp の両方) */
    headerDevices?: string[];
    footerSelectors?: string[];
  };
  /**
   * 代理店コードの保存先。
   * none = 保存しない実装 (URL のみで引き回す) / 保存方式が未確認。
   * この場合、保存値の検査は行わず「未検査」として記録する。
   */
  storage: {
    /**
     * 代理店コードの保存先。
     *   cookie / localStorage … その 1 か所に保存されること
     *   either                … どちらか 1 か所にあればよい
     *   both                  … 両方に保存されること
     *   none                  … 保存値を根拠にした判定を行わない (保存先が未確定のとき)
     */
    type: 'cookie' | 'localStorage' | 'either' | 'both' | 'none';
    key: string;
    /**
     * 他社タグ (計測・A/B テスト) の保存キー。
     * これらは訪問 URL を記録しているだけで、URL に代理店コードが入っていると
     * 「サイトがコードを保持している」ように見えてしまう。
     * 部分一致で判定し、自社の保存とは分けて数える。
     */
    thirdPartyKeyPatterns?: string[];
  };
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
  /** 会社名 (レポート・画面の表示用。コードだけでは人が判断できない) */
  company?: string;
  /** みらいの約束 (みらやく) の掲載可否: ○ / × */
  mirayaku?: string;
  /** 挙動パターン名 (抽選のグループ分けに使う) */
  profile?: string;
  /**
   * サイト側で代理店コードとして認識されるか。
   * false = 受け取っても何もしない (支店コードなど)。
   * 保存・引き継ぎ・代理店表示のいずれも期待しない。
   * 省略時は true。
   */
  recognized?: boolean;
  /** 表に出すパターン名 (ダイレクト / カカクコム / みらやく○ など) */
  patternLabel?: string;
  /**
   * この期待結果が有効になる日 (YYYY-MM-DD)。
   * 支店コードのように「先のリリースで仕様が反映される」場合に持たせる。
   * 表にはこの日付を添えて出す (それまでの不一致は既知として扱う)。
   */
  effectiveFrom?: string | null;
  /**
   * 流入時 (URL にコードを付けて入ったとき) の着地パス。
   * 省略時は expectedFinalPath と同じ。
   * カカクコムは URL のコードでは飛ばないため両者が異なる。
   */
  entryFinalPath?: string;
  /**
   * 保存されたコードで再訪したときに最終ページへ着くか。
   * true の場合、表示の検査は再訪後のページで行う
   * (流入しただけでは代理店のページに着かない)。
   */
  landsAfterRevisit?: boolean;
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
  /**
   * 保存済みコードで再訪したときの遷移。
   *   mechanism / count は実測値を入れると、以降その変化を検知できる。
   *   null のままだと実測値を記録するだけで照合しない。
   */
  revisitRedirect?: {
    fromPath: string;
    toPath: string;
    mechanism?: RedirectMechanism | null;
    count?: number | null;
  } | null;
  visibleSections: string[];
  hiddenSections: string[];
  expectedTexts: Record<string, string>;
  /**
   * 代理店名の表示。
   *   shown  … ヘッダーとフッターに代理店名が出る
   *   hidden … 代理店名が出ない (自社コード・無効コード・コードなし)
   */
  agencyName?: 'shown' | 'hidden';
  /**
   * 「あんしんパック」の表示。
   *   present … 表示がある (みらやく掲載可)
   *   absent  … 表示が一切ない (みらやく掲載不可)
   *   ignore  … 検査しない (仕様が未確定)
   */
  anshinPack?: 'present' | 'absent' | 'ignore';
  /**
   * 「代理店コードの付与」を検査するか。
   *   専用 LP へのリダイレクト後はコードが URL から消えるため、
   *   代理店名の表示で判断できない代理店 (カカクコム) では
   *   コードが実際に付与されているかを別に確認する必要がある。
   *   方式 (URL / Cookie / localStorage / dataLayer など) は問わない。
   */
  codeApplied?: boolean;
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
  /** 代理店名の表示 (無効コード・コードなしでは hidden) */
  agencyName?: 'shown' | 'hidden';
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
  /**
   * チェックリストの並び順 (パターン名)。
   * 毎回同じ順で並んでいないと、前回の結果と見比べられない。
   */
  patternOrder?: string[];
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
  /** このツールの安全装置による遮断 (サイトの不具合ではない) */
  selfBlockedPatterns?: string[];
  /** 他社タグのスクリプト内部で起きたエラーの重大度 */
  thirdPartyScriptSeverity?: Severity;
  /** 同じ内容のエラーをまとめる上限 (種類の数) */
  maxDistinctMessages?: number;
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
  /**
   * 直後にこの語が続く場合は検出しない。
   * 例: 「時」→「とき」は形式名詞だけが対象なので「時間」「時期」を除く。
   */
  exceptWhenFollowedBy?: string[];
  /** 既定 (Low) 以外にする場合の重大度。ブランド・倫理に関わる語は Medium にする */
  severity?: Severity;
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
  prohibited: Array<{ pattern: string; reason: string; severity?: Severity }>;
  typoPatterns: Array<{
    wrong: string;
    correct: string;
    exceptWhenFollowedBy?: string[];
    severity?: Severity;
  }>;
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
/** 既知の不具合 1 件 (config/known-issues.yml) */
export interface KnownIssue {
  id: string;
  title: string;
  note?: string;
  /** 修正リリース日 (YYYY-MM-DD)。この日以降は既知扱いをやめる */
  fixedOn?: string;
  /** 対象の代理店コード (`*` が使える) */
  codes?: string[];
  /** 対象の検知種別。空なら種別を問わない */
  categories: FindingCategory[];
}

export interface KnownIssuesFile {
  knownIssues: KnownIssue[];
}

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
  /** 既知の不具合 (未設定でもよい) */
  knownIssues?: KnownIssuesFile;
}
