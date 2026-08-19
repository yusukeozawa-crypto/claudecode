/**
 * AI による文章チェックの拡張ポイント。
 *
 * 現時点では AI API を呼び出さない (config/text-rules.yml の aiCheck.enabled = false)。
 * 後から実装を追加する場合は AiTextChecker を実装し registerAiTextChecker() で登録する。
 * テスト側のコードは変更不要。
 *
 * 実装例:
 *   registerAiTextChecker({
 *     name: 'my-provider',
 *     async review({ text, pageId }) {
 *       const apiKey = process.env[configuredApiKeyEnv];   // キーは環境変数から取得する
 *       // ... API 呼び出し ...
 *       return [{ severity: 'low', message: '...', excerpt: '...' }];
 *     },
 *   });
 */
import type { FindingInput, QaConfig, Severity } from './types';

export interface AiReviewRequest {
  text: string;
  pageId: string;
  pageName: string;
  url: string;
  /** config/text-rules.yml の canonical などを参照できるようにする */
  config: QaConfig;
}

export interface AiReviewComment {
  severity?: Severity;
  message: string;
  excerpt?: string;
  suggestion?: string;
}

export interface AiTextChecker {
  name: string;
  review(request: AiReviewRequest): Promise<AiReviewComment[]>;
}

const registry = new Map<string, AiTextChecker>();

export function registerAiTextChecker(checker: AiTextChecker): void {
  registry.set(checker.name, checker);
}

export function getAiTextChecker(name: string): AiTextChecker | undefined {
  return registry.get(name);
}

/** AI チェックが有効かどうか (未登録・無効・キー未設定なら false) */
export function isAiCheckAvailable(config: QaConfig): boolean {
  const aiCheck = config.text.aiCheck;
  if (!aiCheck.enabled) return false;
  if (!registry.has(aiCheck.provider)) return false;
  if (aiCheck.apiKeyEnv && !process.env[aiCheck.apiKeyEnv]) return false;
  return true;
}

/**
 * AI チェックを実行する。無効・未登録の場合は空配列を返すだけで、
 * テスト結果に影響しない。
 */
export async function runAiTextCheck(request: AiReviewRequest): Promise<FindingInput[]> {
  const { config } = request;
  if (!isAiCheckAvailable(config)) return [];

  const checker = registry.get(config.text.aiCheck.provider);
  if (!checker) return [];

  const text = request.text.slice(0, config.text.aiCheck.maxCharsPerPage);
  const comments = await checker.review({ ...request, text });

  return comments.map((comment) => ({
    category: 'text-rule',
    severity: comment.severity ?? 'low',
    title: `AI 指摘 (${checker.name}): ${comment.message}`,
    expected: comment.suggestion ?? '文章の確認',
    actual: comment.excerpt ?? comment.message,
    url: request.url,
    pageId: request.pageId,
    pageName: request.pageName,
  }));
}
