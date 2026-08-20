/**
 * ページ単位のエラー監視。
 *   - console.error / console.warn
 *   - pageerror (未捕捉例外)
 *   - 4xx / 5xx のネットワークレスポンス
 *   - リクエスト失敗 (画像を含む)
 * 計測タグ・外部ドメインは config/errors.yml の除外リストで除外できる。
 */
import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';
import { isSameOrigin, matchesAnyGlob, matchesAnyMessage } from './patterns';
import type { FindingInput, QaConfig } from './types';

export interface ConsoleEntry {
  level: string;
  text: string;
  url: string;
  location?: string;
  /** 同じ内容が何回出たか (同一メッセージが数千件出るサイトがあるため) */
  count: number;
}
export interface PageErrorEntry {
  message: string;
  stack?: string;
  url: string;
  count: number;
}
export interface NetworkEntry {
  url: string;
  status: number;
  method: string;
  resourceType: string;
  documentUrl: string;
}
export interface RequestFailureEntry {
  url: string;
  method: string;
  resourceType: string;
  failure: string;
  documentUrl: string;
}

/** ページに監視を仕掛け、記録した内容を Finding に変換する */
export class PageMonitor {
  readonly consoleEntries: ConsoleEntry[] = [];
  readonly pageErrors: PageErrorEntry[] = [];
  readonly networkErrors: NetworkEntry[] = [];
  readonly requestFailures: RequestFailureEntry[] = [];

  /** 安全装置で遮断した回数 (サイトの不具合ではないためまとめて 1 件にする) */
  private selfBlockedCount = 0;
  private detached = false;
  private readonly onConsole: (message: ConsoleMessage) => void;
  private readonly onPageError: (error: Error) => void;
  private readonly onResponse: (response: Response) => void;
  private readonly onRequestFailed: (request: Request) => void;

  constructor(
    private readonly page: Page,
    private readonly config: QaConfig,
  ) {
    const errorsConfig = config.errors;
    const baseUrl = config.environment.baseUrl;

    this.onConsole = (message) => {
      if (!errorsConfig.console.enabled) return;
      if (!errorsConfig.console.levels.includes(message.type())) return;
      const text = message.text();
      if (matchesAnyMessage(text, errorsConfig.console.ignoreMessages)) return;
      // このツールの安全装置で止めたリクエストは、サイトの不具合ではない。
      // 件数だけ数えて、あとでまとめて 1 件として記録する。
      if (this.isSelfBlocked(text)) {
        this.selfBlockedCount += 1;
        return;
      }
      const location = message.location();
      this.addConsoleEntry({
        level: message.type(),
        text,
        url: this.safeUrl(),
        location: location.url ? `${location.url}:${location.lineNumber}:${location.columnNumber}` : undefined,
        count: 1,
      });
    };

    this.onPageError = (error) => {
      if (!errorsConfig.pageError.enabled) return;
      const message = error.message ?? String(error);
      if (matchesAnyMessage(message, errorsConfig.pageError.ignoreMessages)) return;
      const existing = this.pageErrors.find((entry) => entry.message === message);
      if (existing) {
        existing.count += 1;
        return;
      }
      if (this.pageErrors.length >= this.maxDistinct) return;
      this.pageErrors.push({ message, stack: error.stack, url: this.safeUrl(), count: 1 });
    };

    this.onResponse = (response) => {
      if (!errorsConfig.network.enabled) return;
      const url = response.url();
      const status = response.status();
      if (!errorsConfig.network.failStatuses.includes(status)) return;
      if (this.isIgnoredUrl(url)) return;
      if (errorsConfig.network.ignoreThirdParty && !isSameOrigin(url, baseUrl)) return;
      const request = response.request();
      this.networkErrors.push({
        url,
        status,
        method: request.method(),
        resourceType: request.resourceType(),
        documentUrl: this.safeUrl(),
      });
    };

    this.onRequestFailed = (request) => {
      if (!errorsConfig.network.enabled) return;
      const url = request.url();
      if (this.isIgnoredUrl(url)) return;
      if (errorsConfig.network.ignoreThirdParty && !isSameOrigin(url, baseUrl)) return;
      const failureText = request.failure()?.errorText ?? 'unknown';
      // 画面遷移によって中断されたリクエストはサーバー異常ではないため除外する
      if (errorsConfig.network.ignoreAbortedRequests && /ERR_ABORTED/i.test(failureText)) return;
      // このツールの安全装置で止めたリクエスト (読み取り専用環境の送信遮断など)
      if (this.isSelfBlocked(failureText)) {
        this.selfBlockedCount += 1;
        return;
      }
      if (this.requestFailures.length >= this.maxDistinct) return;
      this.requestFailures.push({
        url,
        method: request.method(),
        resourceType: request.resourceType(),
        failure: failureText,
        documentUrl: this.safeUrl(),
      });
    };

    page.on('console', this.onConsole);
    page.on('pageerror', this.onPageError);
    page.on('response', this.onResponse);
    page.on('requestfailed', this.onRequestFailed);
  }

  /** 同じ内容のエラーをまとめる上限 (種類の数) */
  private get maxDistinct(): number {
    return this.config.errors.maxDistinctMessages ?? 50;
  }

  /**
   * このツールの安全装置による遮断か。
   *   読み取り専用環境では GET 以外を実行前に止めるため、
   *   ブラウザは「読み込み失敗」としてコンソールに出す。
   *   検査対象サイトの不具合ではないので、不具合として報告しない。
   */
  private isSelfBlocked(text: string): boolean {
    return matchesAnyMessage(text, this.config.errors.selfBlockedPatterns ?? []);
  }

  /** 同じ内容の console 出力はまとめる (件数だけ増やす) */
  private addConsoleEntry(entry: ConsoleEntry): void {
    const existing = this.consoleEntries.find(
      (candidate) => candidate.level === entry.level && candidate.text === entry.text && candidate.location === entry.location,
    );
    if (existing) {
      existing.count += 1;
      return;
    }
    if (this.consoleEntries.length >= this.maxDistinct) return;
    this.consoleEntries.push(entry);
  }

  /**
   * 他社タグ (計測・解析・広告) のスクリプトで起きたエラーか。
   *   エラーの発生元 URL が検査対象と別オリジンなら他社タグとみなす。
   *   自社サイトのコードではないため、Critical / High では報告しない。
   */
  private isThirdPartySource(source: string | undefined): boolean {
    if (!source) return false;
    const match = /(https?:\/\/[^\s)]+)/.exec(source);
    if (!match) return false;
    return !isSameOrigin(match[1], this.config.environment.baseUrl);
  }

  /** 同じ内容が複数回出た場合に件数を添える */
  private withCount(text: string, count: number): string {
    return count > 1 ? `${text} (同じ内容が ${count} 件)` : text;
  }

  private safeUrl(): string {
    try {
      return this.page.url();
    } catch {
      return this.config.environment.baseUrl;
    }
  }

  private isIgnoredUrl(url: string): boolean {
    return (
      matchesAnyGlob(url, this.config.errors.network.ignoreUrlPatterns) ||
      matchesAnyGlob(url, this.config.layout.images.ignoreUrlPatterns)
    );
  }

  /**
   * 実行環境側の一時的な通信断かどうか。
   *   Wi-Fi 切り替えや回線の瞬断で出るエラーは検査対象サイトの不具合ではないため、
   *   High ではなく Low として記録する (config/errors.yml の transientNetworkPatterns)。
   */
  private isTransientNetwork(text: string): boolean {
    return matchesAnyMessage(text, this.config.errors.transientNetworkPatterns ?? []);
  }

  /**
   * URL に含まれる代理店コードパラメータを読む。
   *   レポートの「代理店」列と「再現URL」がずれないようにするため、
   *   エラーが起きたページの URL から実際のコードを取り出す。
   *   パラメータが無い場合は undefined を返し、検査文脈のコードを使う。
   */
  private agencyCodeFromUrl(url: string): string | undefined {
    try {
      const value = new URL(url).searchParams.get(this.config.agency.paramName);
      return value && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.page.off('console', this.onConsole);
    this.page.off('pageerror', this.onPageError);
    this.page.off('response', this.onResponse);
    this.page.off('requestfailed', this.onRequestFailed);
  }

  /** これまでに記録した内容を消す (ページ単位で集計したい場合に使用) */
  reset(): void {
    this.consoleEntries.length = 0;
    this.pageErrors.length = 0;
    this.networkErrors.length = 0;
    this.requestFailures.length = 0;
  }

  get hasErrors(): boolean {
    return (
      this.consoleEntries.length > 0 ||
      this.pageErrors.length > 0 ||
      this.networkErrors.length > 0 ||
      this.requestFailures.length > 0
    );
  }

  /** 記録内容を Finding に変換する */
  toFindings(): FindingInput[] {
    const findings: FindingInput[] = [];

    for (const entry of this.pageErrors) {
      // 他社タグ (計測・解析・広告) の内部エラーは自社コードの不具合ではない
      const thirdParty = this.isThirdPartySource(entry.stack);
      findings.push({
        category: 'js-error',
        severity: thirdParty ? this.config.errors.thirdPartyScriptSeverity ?? 'low' : undefined,
        title: thirdParty
          ? '他社タグの中で JavaScript エラーが発生しました (自社コードではありません)'
          : 'JavaScript の未捕捉例外 (pageerror) が発生しました',
        expected: 'JavaScript エラーが発生しないこと',
        actual: this.withCount(entry.message, entry.count),
        url: entry.url,
        agencyCode: this.agencyCodeFromUrl(entry.url),
        detail: [
          entry.stack?.split('\n').slice(0, 5).join('\n'),
          thirdParty ? '発生元が検査対象と別ドメインのスクリプトです。タグの提供元に確認してください。' : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join('\n'),
      });
    }

    for (const entry of this.consoleEntries) {
      const transient = this.isTransientNetwork(entry.text);
      const thirdParty = !transient && this.isThirdPartySource(entry.location);
      const severity = transient ? 'low' : thirdParty ? this.config.errors.thirdPartyScriptSeverity ?? 'low' : undefined;
      findings.push({
        category: 'js-error',
        severity,
        title: transient
          ? '実行環境の通信が一時的に切れました (サイトの不具合ではありません)'
          : thirdParty
            ? `他社タグが ${entry.level} を出力しました (自社コードではありません)`
            : `コンソールに ${entry.level} が出力されました`,
        expected: transient
          ? '検査を実行した端末のネットワークが安定していること'
          : `console.${entry.level} が出力されないこと`,
        actual: this.withCount(entry.text, entry.count),
        url: entry.url,
        agencyCode: this.agencyCodeFromUrl(entry.url),
        detail: transient
          ? `${entry.location ?? ''} / 回線が復帰してから再実行してください`.trim()
          : thirdParty
            ? `${entry.location ?? ''} / 発生元が検査対象と別ドメインのスクリプトです`.trim()
            : entry.location,
      });
    }

    // 安全装置で遮断したリクエスト (サイトの不具合ではない) はまとめて 1 件にする。
    // 1 件ずつ報告すると数千件になり、本当の不具合が埋もれる。
    if (this.selfBlockedCount > 0) {
      findings.push({
        category: 'network-error',
        severity: 'low',
        title: '[安全装置] 送信リクエストを遮断しました (サイトの不具合ではありません)',
        expected: '読み取り専用の環境では送信を行わないこと',
        actual: `${this.selfBlockedCount} 件のリクエストを実行前に遮断しました`,
        url: this.safeUrl(),
        detail:
          '本番など読み取り専用の環境では、GET 以外のリクエスト (計測タグの送信など) を' +
          'このツールが止めています。ブラウザはこれを読み込み失敗として記録しますが、サイトの不具合ではありません。',
      });
    }

    for (const entry of this.networkErrors) {
      const isImage = entry.resourceType === 'image';
      findings.push({
        category: isImage ? 'image-error' : 'network-error',
        severity: isImage ? 'medium' : entry.status >= 500 ? 'high' : 'high',
        title: isImage
          ? `画像の取得に失敗しました (HTTP ${entry.status})`
          : `HTTP ${entry.status} のレスポンスを受信しました`,
        expected: 'HTTP 2xx / 3xx を返すこと',
        actual: `HTTP ${entry.status} ${entry.method} ${entry.url}`,
        url: entry.documentUrl,
        agencyCode: this.agencyCodeFromUrl(entry.documentUrl),
        detail: `resourceType=${entry.resourceType}`,
      });
    }

    for (const entry of this.requestFailures) {
      const isTimeout = /timedout|timeout/i.test(entry.failure);
      const isImage = entry.resourceType === 'image';
      const transient = this.isTransientNetwork(entry.failure);
      findings.push({
        category: transient ? 'network-error' : isTimeout ? 'timeout' : isImage ? 'image-error' : 'network-error',
        severity: transient ? 'low' : undefined,
        title: transient
          ? '実行環境の通信が一時的に切れました (サイトの不具合ではありません)'
          : isTimeout
            ? 'リクエストがタイムアウトしました'
            : 'リクエストが失敗しました',
        expected: transient
          ? '検査を実行した端末のネットワークが安定していること'
          : 'すべてのリクエストが正常に完了すること',
        actual: `${entry.failure} (${entry.method} ${entry.url})`,
        url: entry.documentUrl,
        agencyCode: this.agencyCodeFromUrl(entry.documentUrl),
        detail: transient
          ? `resourceType=${entry.resourceType} / 回線が復帰してから再実行してください`
          : `resourceType=${entry.resourceType}`,
      });
    }

    return findings;
  }
}
