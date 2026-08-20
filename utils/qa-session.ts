/**
 * 1 テスト分の検査セッション。
 * ページ遷移・各種検査・検知結果の集約をまとめて扱う。
 */
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { FindingCollector, type FindingContext } from './findings';
import { checkPageLinks } from './links';
import { runLayoutChecks } from './layout';
import { PageMonitor } from './monitors';
import { captureFullPage, compareWithBaseline } from './screenshots';
import { extractText, saveExtractedText } from './text-extract';
import { detectTextIssues, textIssuesToFindings } from './text-rules';
import { runAiTextCheck } from './ai-text-checker';
import { sleep } from './throttle';
import { pageUrl } from './config';
import { maskText, maskUrl } from './secrets';
import type { FindingInput, PageConfig, QaConfig } from './types';

export interface GotoOptions {
  /** 付与する代理店コード (null ならパラメータなし) */
  agencyCode?: string | null;
  /** ページ定義 (レポートの文脈に使用) */
  page?: PageConfig;
  /** 直接 URL を指定する場合 */
  url?: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
}

export class QaSession {
  readonly findings: FindingCollector;
  readonly monitor: PageMonitor;

  constructor(
    readonly config: QaConfig,
    readonly page: Page,
    readonly request: APIRequestContext,
    readonly testInfo: TestInfo,
    context: FindingContext,
  ) {
    this.findings = new FindingCollector(config, context);
    this.monitor = new PageMonitor(page, config);
  }

  get isReadOnly(): boolean {
    return this.config.environment.readOnly;
  }

  /**
   * ページへ遷移する。
   *   - リクエスト間隔を空ける (config/runtime.yml)
   *   - タイムアウト・リダイレクトループを Finding として記録する
   */
  async goto(options: GotoOptions): Promise<boolean> {
    const { page: pageConfig, agencyCode = null } = options;
    const params = agencyCode ? { [this.config.agency.paramName]: agencyCode } : undefined;
    const target =
      options.url ??
      (pageConfig ? pageUrl(this.config, pageConfig.path, params) : this.config.environment.baseUrl);

    this.findings.setContext({
      pageId: pageConfig?.id,
      pageName: pageConfig?.name,
      agencyCode: agencyCode ?? 'none',
      url: target,
    });

    const delay = this.config.runtime.throttle.navigationDelayMs;
    if (delay > 0) await sleep(delay);

    const startedAt = Date.now();
    try {
      const response = await this.page.goto(target, {
        waitUntil: options.waitUntil ?? 'load',
        timeout: this.config.runtime.timeouts.navigation,
      });
      const elapsed = Date.now() - startedAt;

      if (elapsed > this.config.errors.timeout.pageLoadWarnMs) {
        this.findings.add({
          category: 'timeout',
          severity: 'medium',
          title: 'ページの読み込みに時間がかかっています',
          expected: `${this.config.errors.timeout.pageLoadWarnMs}ms 以内に読み込まれること`,
          actual: `${elapsed}ms`,
          url: target,
        });
      }

      const status = response?.status();
      if (status !== undefined && status >= 400) {
        this.findings.add({
          category: 'network-error',
          severity: 'high',
          title: `ページが HTTP ${status} を返しました`,
          expected: 'HTTP 2xx を返すこと',
          actual: `HTTP ${status}`,
          url: target,
        });
        return false;
      }

      // 現在の URL に更新 (リダイレクト後の URL を記録する)
      this.findings.setContext({ url: this.page.url() });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRedirectLoop = /ERR_TOO_MANY_REDIRECTS|too many redirects/i.test(message);
      const isTimeout = /Timeout|timed out/i.test(message);
      this.findings.add({
        category: isRedirectLoop ? 'redirect-loop' : isTimeout ? 'timeout' : 'network-error',
        // 重大度はカテゴリ既定値に従う (リダイレクトループは Critical)
        severity: isRedirectLoop ? undefined : 'high',
        title: isRedirectLoop
          ? 'リダイレクトループによりページを表示できません'
          : isTimeout
            ? 'ページ読み込みがタイムアウトしました'
            : 'ページを表示できません',
        expected: 'ページが正常に表示されること',
        actual: message.split('\n')[0],
        url: target,
      });
      return false;
    }
  }

  /** 監視で記録したエラーを Finding に反映する */
  collectMonitorFindings(): void {
    this.findings.addAll(this.monitor.toFindings());
    this.monitor.reset();
  }

  /** 表示崩れの検査 */
  async checkLayout(pageConfig: PageConfig): Promise<void> {
    const findings = await runLayoutChecks(this.page, this.config, {
      primaryTestIds: pageConfig.primaryTestIds,
      requiredTestIds: pageConfig.requiredTestIds,
    });
    this.findings.addAll(findings);
  }

  /** リンク切れの検査 */
  async checkLinks(): Promise<number> {
    const { findings, checked } = await checkPageLinks(this.page, this.request, this.config);
    this.findings.addAll(findings);
    return checked;
  }

  /** フルページスクリーンショットの保存 (レポートにも添付する) */
  async captureScreenshot(pageId: string, suffix?: string): Promise<string> {
    const context = this.findings.currentContext;
    const filePath = await captureFullPage(this.page, this.config, {
      pageId,
      browserId: context.browserId,
      deviceId: context.deviceId,
      suffix,
    });
    await this.testInfo.attach(`screenshot-${pageId}${suffix ? `-${suffix}` : ''}`, {
      path: filePath,
      contentType: 'image/png',
    });
    return filePath;
  }

  /** 基準画像との比較 */
  async compareScreenshot(pageConfig: PageConfig): Promise<void> {
    const findings = await compareWithBaseline(this.page, this.config, this.testInfo, {
      pageId: pageConfig.id,
      pageName: pageConfig.name,
    });
    this.findings.addAll(findings);
  }

  /** 表示テキストの抽出・保存とルールベースの検査 */
  async auditText(pageConfig: PageConfig): Promise<string> {
    const context = this.findings.currentContext;
    const extracted = await extractText(this.page, this.config);

    saveExtractedText(this.config, {
      pageId: pageConfig.id,
      pageName: pageConfig.name,
      // 抽出結果は reports/text 配下に保存され Artifact にも載るため、
      // URL に含まれるトークン・個人情報をマスクする
      url: maskUrl(this.page.url(), this.config),
      deviceId: context.deviceId,
      browserId: context.browserId,
      environment: this.config.environmentName,
      extractedAt: new Date().toISOString(),
      title: extracted.title,
      fullText: extracted.fullText,
      blocks: extracted.blocks,
    });

    const issues = detectTextIssues(extracted.fullText, this.config.text);
    this.findings.addAll(
      textIssuesToFindings(issues, {
        url: this.page.url(),
        pageId: pageConfig.id,
        pageName: pageConfig.name,
      }),
    );

    // AI チェック (既定では無効。実装が登録されている場合のみ実行される)
    const aiFindings = await runAiTextCheck({
      text: extracted.fullText,
      pageId: pageConfig.id,
      pageName: pageConfig.name,
      url: this.page.url(),
      config: this.config,
    });
    this.findings.addAll(aiFindings);

    return extracted.fullText;
  }

  /** ページ定義の checks に従って一括検査する */
  async runConfiguredChecks(pageConfig: PageConfig): Promise<void> {
    if (pageConfig.checks.includes('layout')) await this.checkLayout(pageConfig);
    if (pageConfig.checks.includes('links')) await this.checkLinks();
    if (pageConfig.checks.includes('text')) await this.auditText(pageConfig);
    if (pageConfig.checks.includes('errors')) this.collectMonitorFindings();
  }

  /**
   * 証跡 (リダイレクト経路など) を JSON としてレポートに添付する。
   * 経路上の URL には一時トークンや個人情報が含まれ得るため、
   * 出力前にマスキングする (レポートは CI の Artifact として共有される)。
   */
  async attachJson(name: string, payload: unknown): Promise<void> {
    const serialized = JSON.stringify(payload, null, 2);
    await this.testInfo.attach(name, {
      body: maskText(serialized, this.config) ?? serialized,
      contentType: 'application/json',
    });
  }

  add(finding: FindingInput): void {
    this.findings.add(finding);
  }

  addAll(findings: FindingInput[]): void {
    this.findings.addAll(findings);
  }
}
