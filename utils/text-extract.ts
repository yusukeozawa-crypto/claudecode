/**
 * 表示テキストの抽出と保存 (JSON / CSV)。
 * 誤字脱字・表記揺れのチェックはこの抽出結果に対して行う。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PROJECT_ROOT } from './config';
import type { QaConfig } from './types';

export interface ExtractedBlock {
  /** 要素のタグ名 */
  tag: string;
  /** data-testid (あれば) */
  testId?: string;
  text: string;
}

export interface ExtractedText {
  pageId: string;
  pageName: string;
  url: string;
  deviceId: string;
  browserId: string;
  environment: string;
  extractedAt: string;
  title: string;
  /** ページ全体の可視テキスト */
  fullText: string;
  blocks: ExtractedBlock[];
}

/** 表示テキストを抽出する (除外セレクタ適用) */
export async function extractText(page: Page, config: QaConfig): Promise<{ title: string; fullText: string; blocks: ExtractedBlock[] }> {
  const excludeSelectors = config.text.extract.excludeSelectors.map((selector) =>
    selector.startsWith('css=') ? selector.slice(4) : selector,
  );

  return page.evaluate((exclude: string[]) => {
    const excluded = new Set<Element>();
    for (const selector of exclude) {
      try {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          excluded.add(element);
          for (const child of Array.from(element.querySelectorAll('*'))) excluded.add(child);
        }
      } catch {
        /* 不正なセレクタは無視する */
      }
    }

    const isExcluded = (element: Element): boolean => {
      let current: Element | null = element;
      while (current) {
        if (excluded.has(current)) return true;
        current = current.parentElement;
      }
      return false;
    };

    const blockTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'dt', 'dd', 'th', 'td', 'a', 'button', 'label', 'span', 'figcaption'];
    const blocks: Array<{ tag: string; testId?: string; text: string }> = [];
    const seen = new Set<string>();

    for (const element of Array.from(document.body.querySelectorAll(blockTags.join(',')))) {
      if (isExcluded(element)) continue;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // 直下のテキストのみを対象にし、入れ子による重複を避ける
      const ownText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!ownText) continue;
      const key = `${element.tagName}:${ownText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push({
        tag: element.tagName.toLowerCase(),
        testId: element.getAttribute('data-testid') ?? undefined,
        text: ownText,
      });
    }

    const fullText = (document.body.innerText ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');

    return { title: document.title, fullText, blocks };
  }, excludeSelectors);
}

/**
 * CSV セルの先頭が =, +, -, @ の場合、表計算ソフトが数式として解釈する。
 * 対象ページのテキストがそのまま数式になるのを防ぐ。
 */
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvEscape(value: string): string {
  return `"${neutralizeFormula(value).replace(/"/g, '""')}"`;
}

/** 抽出結果を JSON / CSV に保存する。戻り値は保存したファイルパス */
export function saveExtractedText(config: QaConfig, data: ExtractedText): string[] {
  if (!config.text.extract.enabled) return [];

  const outputDir = path.join(PROJECT_ROOT, config.text.extract.outputDir, config.environmentName);
  fs.mkdirSync(outputDir, { recursive: true });
  const baseName = `${data.pageId}__${data.browserId}-${data.deviceId}`;
  const saved: string[] = [];

  if (config.text.extract.formats.includes('json')) {
    const jsonPath = path.join(outputDir, `${baseName}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
    saved.push(jsonPath);
  }

  if (config.text.extract.formats.includes('csv')) {
    const csvPath = path.join(outputDir, `${baseName}.csv`);
    const header = 'pageId,pageName,url,deviceId,browserId,tag,testId,text';
    const rows = data.blocks.map((block) =>
      [
        data.pageId,
        data.pageName,
        data.url,
        data.deviceId,
        data.browserId,
        block.tag,
        block.testId ?? '',
        block.text,
      ]
        .map((value) => csvEscape(String(value)))
        .join(','),
    );
    fs.writeFileSync(csvPath, `${header}\n${rows.join('\n')}\n`, 'utf8');
    saved.push(csvPath);
  }

  return saved;
}
