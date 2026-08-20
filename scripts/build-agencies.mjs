#!/usr/bin/env node
/**
 * config/agencies.yml の生成 (npm run agencies:build)。
 *
 * 入力
 *   config/agency-master.tsv    … 代理店コードと属性 (どの代理店が何か)
 *   config/agency-profiles.yml  … 挙動パターンごとの期待結果
 * 出力
 *   config/agencies.yml
 *
 * 代理店が 200 件を超えるサイトでは、1 件ずつ期待結果を書くのは現実的でない。
 * このサイトの挙動は「みらやく掲載可否」と「カカクコムか否か」で決まるため、
 * パターン (プロファイル) を定義し、マスタの属性から割り当てる。
 *
 * 出力は常に全件。どれを実際に検査するかは実行時に抽選する
 * (毎回同じ代理店だけを検査すると、残りに潜む問題を見逃し続けるため)。
 * 抽選の設定は scope として agencies.yml に書き出し、
 * utils/agency.ts が実行時に使う。
 *
 *   --check    … 生成せず、現在の agencies.yml と一致するかだけ確認する (CI 用)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_DIR = path.join(root, 'config');
const MASTER_PATH = path.join(CONFIG_DIR, 'agency-master.tsv');
const PROFILES_PATH = path.join(CONFIG_DIR, 'agency-profiles.yml');
const OUTPUT_PATH = path.join(CONFIG_DIR, 'agencies.yml');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');

/** TSV の読み込み (# 始まりはコメント) */
function readMaster() {
  const text = fs.readFileSync(MASTER_PATH, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.startsWith('#'));
  if (lines.length === 0) throw new Error(`${MASTER_PATH} にデータがありません`);
  const header = lines[0].split('\t').map((cell) => cell.trim());
  const required = ['code', 'company', 'mirayaku'];
  for (const key of required) {
    if (!header.includes(key)) throw new Error(`${MASTER_PATH}: 列 ${key} がありません`);
  }
  const rows = [];
  const seen = new Set();
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = line.split('\t');
    const row = {};
    header.forEach((key, i) => {
      row[key] = (cells[i] ?? '').trim();
    });
    if (!row.code) throw new Error(`${MASTER_PATH}: ${index + 2} 行目の code が空です`);
    if (seen.has(row.code)) throw new Error(`${MASTER_PATH}: 代理店コードが重複しています: ${row.code}`);
    seen.add(row.code);
    rows.push(row);
  }
  return rows;
}

/** 割り当てルールの評価 (上から順に最初に一致したもの) */
function resolveProfileName(row, assign) {
  for (const rule of assign) {
    const match = rule.match ?? {};
    if (match.code !== undefined && match.code !== row.code) continue;
    if (match.codePrefix !== undefined && !row.code.startsWith(match.codePrefix)) continue;
    if (match.mirayaku !== undefined && match.mirayaku !== row.mirayaku) continue;
    if (match.companyContains !== undefined && !row.company.includes(match.companyContains)) continue;
    return rule.profile;
  }
  return null;
}

function buildAgency(row, profile) {
  const label = `${row.company} — ${profile.label}`;
  return {
    code: row.code,
    label,
    // 実行時の抽選でパターンごとに選ぶために保持する
    profile: row.profile,
    entryPath: profile.entryPath,
    expectedFinalPath: profile.expectedFinalPath,
    redirected: Boolean(profile.redirected),
    // null (未実測) は unknown として出力する。
    // unknown は「方式を問わず、実測値をレポートに記録する」の意味。
    redirectMechanism: profile.redirectMechanism ?? 'unknown',
    // null (未実測) は照合せず実測値を記録する。
    // 推測した回数で判定すると正常なサイトを不具合として報告してしまう。
    expectedRedirectCount:
      profile.expectedRedirectCount === null || profile.expectedRedirectCount === undefined
        ? null
        : Number(profile.expectedRedirectCount),
    expectedRedirectPaths: profile.expectedRedirectPaths ?? [],
    visibleSections: profile.visibleSections ?? [],
    hiddenSections: profile.hiddenSections ?? [],
    expectedTexts: profile.expectedTexts ?? {},
    expectedAssets: profile.expectedAssets ?? {},
    cta: profile.cta ?? null,
    application: profile.application ?? null,
  };
}

/**
 * 無効コード / コードなしの期待結果。
 * application は申込ドメインを設定してから使われる項目なので、
 * 未確定でも形だけ揃えておく (申込ドメイン未設定の間は検査自体が行われない)。
 */
function buildFallback(expectation) {
  return {
    entryPath: expectation.entryPath ?? '/lp/service/',
    expectedFinalPath: expectation.expectedFinalPath,
    redirected: Boolean(expectation.redirected),
    redirectMechanism: expectation.redirectMechanism ?? 'none',
    visibleSections: expectation.visibleSections ?? [],
    hiddenSections: expectation.hiddenSections ?? [],
    expectedTexts: expectation.expectedTexts ?? {},
    expectStored: Boolean(expectation.expectStored ?? false),
    application: expectation.application ?? {
      expectedDomain: null,
      expectedPath: '/',
      expectDefaultRoute: false,
      defaultRouteTestId: '',
      forbiddenTestIds: [],
    },
  };
}

function main() {
  const master = readMaster();
  const profilesFile = parseYaml(fs.readFileSync(PROFILES_PATH, 'utf8'));
  const scope = profilesFile.scope ?? {};
  const assign = profilesFile.assign ?? [];
  const profiles = profilesFile.profiles ?? {};

  const excluded = new Set((scope.excludeMirayaku ?? []).map((value) => String(value)));
  const skipped = [];
  const assigned = [];

  for (const row of master) {
    if (excluded.has(row.mirayaku)) {
      skipped.push({ code: row.code, reason: `mirayaku=${row.mirayaku || '(空欄)'}` });
      continue;
    }
    const profileName = resolveProfileName(row, assign);
    if (!profileName) {
      skipped.push({ code: row.code, reason: '一致する割り当てルールがありません' });
      continue;
    }
    if (!profiles[profileName]) {
      throw new Error(`config/agency-profiles.yml: プロファイル ${profileName} が定義されていません (${row.code})`);
    }
    assigned.push({ ...row, profile: profileName });
  }

  const agencies = assigned.map((row) => buildAgency(row, profiles[row.profile]));

  const output = {
    // どれを実際に検査するかは実行時に抽選する (utils/agency.ts)
    scope: {
      mode: scope.mode ?? 'sample',
      perProfile: Number(scope.perProfile ?? 2),
      always: scope.always ?? [],
    },
    agencies,
    invalidCodes: profilesFile.invalidCodes ?? [],
    invalidExpectation: buildFallback(profilesFile.invalidExpectation ?? {}),
    noCodeExpectation: buildFallback(profilesFile.noCodeExpectation ?? {}),
    redirect: profilesFile.redirect,
    security: profilesFile.security,
  };

  const header = [
    '# ============================================================',
    '# 【自動生成ファイル】直接編集しないこと',
    '#',
    '#   生成元:',
    '#     config/agency-master.tsv    (代理店コードと属性)',
    '#     config/agency-profiles.yml  (挙動パターンごとの期待結果)',
    '#',
    '#   再生成: npm run agencies:build',
    '#',
    `#   全 ${agencies.length} 件 / マスタ ${master.length} 件`,
    '#',
    '#   実際に検査する代理店は実行ごとに抽選される (scope を参照)。',
    '#   毎回同じ代理店だけを検査すると、残りに潜む問題を見逃し続けるため。',
    '#   全件を検査する場合: npm run test:agency:all',
    '#   抽選を再現する場合: QA_AGENCY_SEED=<レポートに記録された値>',
    '# ============================================================',
    '',
  ].join('\n');

  // aliasDuplicateObjects: false … 同じ内容の空配列を &a1 / *a1 のような
  // エイリアスにまとめず、そのまま出力する (人が読める形にする)
  const yaml = header + stringifyYaml(output, { lineWidth: 0, aliasDuplicateObjects: false });

  if (checkOnly) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : '';
    if (current !== yaml) {
      console.error('config/agencies.yml が生成結果と一致しません。npm run agencies:build を実行してください。');
      process.exit(1);
    }
    console.log('config/agencies.yml は生成結果と一致しています。');
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, yaml, 'utf8');

  const byProfile = new Map();
  for (const row of assigned) byProfile.set(row.profile, (byProfile.get(row.profile) ?? 0) + 1);

  console.log(`config/agencies.yml を生成しました (${agencies.length} 件)`);
  console.log('');
  console.log('  パターンごとの件数:');
  for (const [name, count] of byProfile) console.log(`    ${name}: ${count}`);
  console.log('');
  console.log(`  マスタ総数    : ${master.length}`);
  console.log(`  検査対象      : ${assigned.length}`);
  console.log(`  検査対象外    : ${skipped.length}`);
  if (skipped.length > 0) {
    const shown = skipped.slice(0, 5).map((entry) => `${entry.code} (${entry.reason})`);
    console.log(`    ${shown.join(', ')}${skipped.length > 5 ? ` ...他 ${skipped.length - 5} 件` : ''}`);
  }
  console.log('');
  if ((scope.mode ?? 'sample') === 'sample') {
    const perProfile = Number(scope.perProfile ?? 2);
    const always = (scope.always ?? []).length;
    console.log(`  実行時の抽選  : パターンごと ${perProfile} 件 + 常時 ${always} 件 (実行ごとに変わる)`);
    console.log('                  全件を検査する場合: npm run test:agency:all');
  } else {
    console.log('  実行時の抽選  : なし (全件を検査する)');
  }
}

main();
