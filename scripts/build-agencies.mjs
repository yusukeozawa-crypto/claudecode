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
  // handling (スプレッドシートの E 列「扱い」) は任意。
  // 「ダイレクト扱い」の代理店は自社コードと同じ挙動になるため、
  // 代理店名が出ないのが正しい。列が無い場合は空として扱う。
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

/**
 * 割り当てルールの評価 (上から順に最初に一致したもの)。
 *   { exclude: true } のルールに一致した場合は検査対象から外す。
 * 戻り値: { profile } / { exclude: true } / null (一致なし)
 */
function resolveAssignment(row, assign) {
  for (const rule of assign) {
    const match = rule.match ?? {};
    if (match.code !== undefined && match.code !== row.code) continue;
    if (match.codePrefix !== undefined && !row.code.startsWith(match.codePrefix)) continue;
    // 支店コード (末尾が brNN) のように前方一致では書けない条件を扱う
    if (match.codeMatches !== undefined && !new RegExp(match.codeMatches).test(row.code)) continue;
    if (match.mirayaku !== undefined && match.mirayaku !== row.mirayaku) continue;
    // スプレッドシートの「扱い」列 (ダイレクト扱い など)
    if (match.handling !== undefined && match.handling !== (row.handling ?? '')) continue;
    if (match.companyContains !== undefined && !row.company.includes(match.companyContains)) continue;
    if (rule.exclude) return { exclude: true, reason: rule.reason ?? '割り当てルールで除外' };
    if (!rule.profile) throw new Error(`config/agency-profiles.yml: assign に profile も exclude もありません (${row.code})`);
    return { profile: rule.profile };
  }
  return null;
}

function buildAgency(row, profile) {
  const label = `${row.company} — ${profile.label}`;
  return {
    code: row.code,
    label,
    // レポートと画面に「どの会社か」「みらいの約束の掲載可否」を出すために持つ
    // (コードだけでは人が判断できない)
    company: row.company,
    mirayaku: row.mirayaku,
    // 実行時の抽選でパターンごとに選ぶために保持する
    profile: row.profile,
    // サイト側でコードとして扱われないパターン (支店コードなど) は
    // 保存・引き継ぎ・代理店表示のいずれも期待しない
    recognized: profile.recognized !== false,
    // 再訪時のリダイレクト (保存済みコードによる遷移)。null = 起きない
    revisitRedirect: profile.revisitRedirect ?? null,
    // 表に出すパターン名 (ダイレクト / カカクコム / みらやく○ など)
    patternLabel: profile.patternLabel ?? profile.label,
    // この期待結果が有効になる日 (支店コードの仕様反映日など)。null = 今から有効
    effectiveFrom: profile.effectiveFrom ? String(profile.effectiveFrom) : null,
    entryPath: profile.entryPath,
    expectedFinalPath: profile.expectedFinalPath,
    // 流入時 (URL にコードを付けて入ったとき) の着地。
    // 省略時は expectedFinalPath と同じ
    entryFinalPath: profile.entryFinalPath ?? profile.expectedFinalPath,
    redirected: Boolean(profile.redirected),
    // 保存されたコードで再訪したときに最終ページへ着く (流入だけでは着かない)
    landsAfterRevisit: profile.landsAfterRevisit === true,
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
    // 表示ルール (代理店名の表示 / あんしんパックの有無)。
    // 文言そのものは agency.yml の agencyNameTexts が持つ
    agencyName: profile.agencyName ?? 'shown',
    anshinPack: profile.anshinPack ?? 'ignore',
    // 代理店コードが付与されているかを別に確認するパターン
    // (リダイレクト後はコードが URL から消えるため)
    codeApplied: profile.codeApplied === true,
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
    // 代理店名の表示 (無効コード・コードなしでは hidden)
    agencyName: expectation.agencyName ?? 'hidden',
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
      skipped.push({
        code: row.code,
        company: row.company,
        reason: `みらやく掲載可否が「${row.mirayaku || '(空欄)'}」のため期待結果を決められない`,
      });
      continue;
    }
    const assignment = resolveAssignment(row, assign);
    if (!assignment) {
      skipped.push({ code: row.code, company: row.company, reason: '一致する割り当てルールがありません' });
      continue;
    }
    if (assignment.exclude) {
      skipped.push({ code: row.code, company: row.company, reason: assignment.reason });
      continue;
    }
    const profileName = assignment.profile;
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
    displayMustDiffer: profilesFile.displayMustDiffer ?? [],
    displayIgnoreKeys: profilesFile.displayIgnoreKeys ?? [],
    sameAsNoCodeProfiles: profilesFile.sameAsNoCodeProfiles ?? [],
    agencies,
    // 検査対象外にした代理店。画面の備考欄がここから自動で一覧を作る
    // (手で書き写すと必ず古くなるため)
    excludedAgencies: skipped,
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
