/**
 * 表示差分の調査ツール (@discover)。
 *
 * 「どのセクションが代理店コードによって出る / 出ない のか」を、
 * 事前に data-testid を知らなくても洗い出す。
 *
 * 目的は 2 つ。
 *   1. 検査すべきセクションを特定する
 *      (推測で config に書くと、合格しているのに実は見ていない状態になる)
 *   2. 特定できたセレクタを config にそのまま貼れる形で出す
 *
 * 出力: reports/discovery/agency-section-diff.md / .json
 *
 * 通常のテスト実行では起動しない。npm run discover のときだけ実行する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { test } from '../qa-fixtures';
import { PROJECT_ROOT } from '../../utils/config';
import { writeHumanText } from '../../utils/text-file';
import { agencySpecs } from '../../utils/agency';
import { buildEntryUrl } from '../../utils/agency-entry';
import { capturePageSignatureStable, diffSignatures, toSelectorHint } from '../../utils/page-signature';
import type { PageSignature } from '../../utils/page-signature';
import type { AgencySpec } from '../../utils/types';

const OUTPUT_DIR = path.join(PROJECT_ROOT, 'reports', 'discovery');

/** パターンごとの代表を 1 件ずつ選ぶ (同じパターンを何度も開かない) */
function representatives(specs: AgencySpec[]): AgencySpec[] {
  const byProfile = new Map<string, AgencySpec>();
  for (const spec of specs) {
    const key = spec.profile ?? spec.code;
    if (!byProfile.has(key)) byProfile.set(key, spec);
  }
  return [...byProfile.values()];
}

function renderBlocks(title: string, blocks: ReturnType<typeof diffSignatures>['visibleOnlyInA']): string[] {
  if (blocks.length === 0) return [`- ${title}: なし`, ''];
  const lines = [`- ${title}: ${blocks.length} 件`, ''];
  lines.push('| セレクタ (config にそのまま書ける形) | 種類 | 表示サイズ | 表示テキストの先頭 |');
  lines.push('|---|---|---|---|');
  for (const block of blocks.slice(0, 30)) {
    const sample = block.textSample.replace(/\|/g, '\\|') || '(テキストなし)';
    // 画面上のどこを見れば確認できるかが分かるようにサイズも出す
    const size = `${block.width}x${block.height}`;
    lines.push(`| \`${toSelectorHint(block)}\` | ${block.keyKind} | ${size} | ${sample} |`);
  }
  if (blocks.length > 30) lines.push(`| ... 他 ${blocks.length - 30} 件 | | | |`);
  lines.push('');
  return lines;
}

function renderText(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [`- ${title}: なし`, ''];
  const out = [`- ${title}: ${lines.length} 行`, '', '```'];
  for (const line of lines.slice(0, 20)) out.push(line.slice(0, 160));
  if (lines.length > 20) out.push(`... 他 ${lines.length - 20} 行`);
  out.push('```', '');
  return out;
}

/**
 * 取得のたびに表示が変わった要素。
 * アニメーション・遅延読み込み・スライダーなど「まだ動いているもの」で、
 * 差分比較からは除外している。除外した事実を隠さないために出力する。
 */
function renderUnstable(signature: PageSignature): string[] {
  const keys = signature.unstableKeys ?? [];
  const textLines = signature.unstableTextLines ?? [];
  if (keys.length === 0 && textLines.length === 0) return [];
  const out = ['- 表示が安定しなかったため比較から除外したもの:', ''];
  if (keys.length > 0) out.push(`  - 要素: ${keys.slice(0, 10).map((key) => `\`${key}\``).join(', ')}${keys.length > 10 ? ` ...他 ${keys.length - 10} 件` : ''}`);
  if (textLines.length > 0) out.push(`  - テキスト: ${textLines.length} 行`);
  out.push('', '  (アニメーション・遅延読み込み・スライダーの可能性があります)', '');
  return out;
}

test.describe('表示差分の調査 @discover', () => {
  test.skip(
    !process.env.QA_DISCOVER,
    'npm run discover で実行してください (通常のテスト実行では起動しません)',
  );

  test('代理店コードによる表示差分を洗い出す', async ({ qa, page }, testInfo) => {
    test.slow();
    const config = qa.config;
    const specs = representatives(agencySpecs(config));
    const entryPath = specs[0]?.entryPath ?? '/';

    // 基準はコードなし (通常の LP)
    const baselineUrl = buildEntryUrl(config, entryPath, null);
    if (!(await qa.goto({ url: baselineUrl }))) {
      test.skip(true, `基準ページを開けませんでした: ${baselineUrl}`);
      return;
    }
    const baseline = await capturePageSignatureStable(page);
    if (!baseline) {
      test.skip(true, `基準ページの取得に失敗しました (遷移が終わりません): ${baselineUrl}`);
      return;
    }

    const captured: Array<{ spec: AgencySpec; signature: PageSignature }> = [];
    for (const spec of specs) {
      const url = buildEntryUrl(config, spec.entryPath, spec.code);
      if (!(await qa.goto({ url, agencyCode: spec.code }))) continue;
      const signature = await capturePageSignatureStable(page);
      if (!signature) {
        console.log(`  ${spec.code}: 遷移が終わらないため取得できませんでした`);
        continue;
      }
      captured.push({ spec, signature });
    }

    const lines: string[] = [
      '# 代理店コードによる表示差分',
      '',
      `- 実行日時: ${new Date().toLocaleString('ja-JP')}`,
      `- 対象環境: ${config.environment.label} (${config.environmentName})`,
      `- 基準: コードなし \`${baselineUrl}\``,
      '',
      '「表示されているか」で比較している (非表示で DOM に残す実装があるため)。',
      'ここに出たセレクタを `config/agency-profiles.yml` の',
      '`visibleSections` / `hiddenSections` に設定すると、以降は表示崩れを検知できる。',
      '',
    ];

    for (const { spec, signature } of captured) {
      const diff = diffSignatures(baseline, signature);
      lines.push('---', '', `## ${spec.code} (${spec.label})`, '');
      lines.push(`- 最終 URL: \`${signature.url}\``, '');
      lines.push(...renderBlocks('コードなしでは出ないが、このコードでは出るブロック', diff.visibleOnlyInB));
      lines.push(...renderBlocks('コードなしでは出るが、このコードでは出ないブロック', diff.visibleOnlyInA));
      lines.push(...renderText('このコードだけに出るテキスト', diff.textOnlyInB));
      lines.push(...renderText('このコードでは消えるテキスト', diff.textOnlyInA));
      lines.push(...renderUnstable(signature));
    }

    // パターン同士の比較 (みらやく ○ と × の違いを直接見る)
    if (captured.length >= 2) {
      lines.push('---', '', '## パターン同士の比較', '');
      for (let index = 0; index + 1 < captured.length; index += 1) {
        const left = captured[index];
        const right = captured[index + 1];
        const diff = diffSignatures(left.signature, right.signature);
        lines.push(`### ${left.spec.code} と ${right.spec.code} の違い`, '');
        lines.push(`- ${left.spec.label} / ${right.spec.label}`, '');
        lines.push(...renderBlocks(`${left.spec.code} だけに出るブロック`, diff.visibleOnlyInA));
        lines.push(...renderBlocks(`${right.spec.code} だけに出るブロック`, diff.visibleOnlyInB));
      }
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const markdownPath = path.join(OUTPUT_DIR, 'agency-section-diff.md');
    const jsonPath = path.join(OUTPUT_DIR, 'agency-section-diff.json');
    // Windows で `type` / メモ帳が Shift-JIS と誤認して文字化けするため BOM を付ける
    writeHumanText(markdownPath, `${lines.join('\n')}\n`);
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          baseline: { url: baselineUrl, signature: baseline },
          agencies: captured.map(({ spec, signature }) => ({
            code: spec.code,
            profile: spec.profile ?? null,
            label: spec.label,
            signature,
            diffFromBaseline: diffSignatures(baseline, signature),
          })),
        },
        null,
        2,
      ),
      'utf8',
    );

    await testInfo.attach('agency-section-diff.md', { path: markdownPath, contentType: 'text/markdown' });
    console.log('');
    console.log(`表示差分を出力しました: ${path.relative(PROJECT_ROOT, markdownPath)}`);
    console.log(`  比較した代理店: ${captured.map(({ spec }) => spec.code).join(', ')}`);
  });
});
