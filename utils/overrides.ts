/**
 * 画面から保存された上書き設定 (config/overrides.yml) を検査本体に反映する。
 *
 * 画面から config/agency.yml を直接書き換えない理由:
 *   `npm run update` は .env / reports / screenshots 以外を新しい版で
 *   置き換えるため、直接書き換えると更新のたびに運用側の判断が消える。
 *
 * 反映するのは決めたキーだけ (下の OVERRIDE_KEYS)。
 * 保存する側は scripts/lib/overrides.mjs。
 * キーが食い違うと「保存したのに効かない」になるため、
 * scripts/check-ui.mjs で両者の一覧が一致することを検査している。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgencyFile } from './types';

/** 画面から上書きできるキー (scripts/lib/overrides.mjs と同じ並び) */
export const OVERRIDE_KEYS = [
  'anshinPack',
  'anshinPackNegations',
  'excludeAgencyCodes',
  'anshinPackAlwaysAllowed',
  'anshinPackAlwaysForbidden',
] as const;

export interface OverridesFile {
  /** 安心パックの判定に使う語 */
  anshinPack?: string[];
  /** 否定表現 (安心パックなし = 付かない場合) */
  anshinPackNegations?: string[];
  /** 文字の大きさに関係なく許可する文言 */
  anshinPackAlwaysAllowed?: Array<{ text: string; reason?: string }>;
  /** 文字の大きさに関係なく違反とする文言 */
  anshinPackAlwaysForbidden?: Array<{ text: string; reason?: string }>;
  /** 検査対象から外す代理店コード */
  excludeAgencyCodes?: string[];
}

/** 上書き設定を読む (無ければ空。壊れていても検査は続ける) */
export function readOverrides(configDir: string): OverridesFile {
  const file = path.join(configDir, 'overrides.yml');
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = parseYaml(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as OverridesFile) : {};
  } catch {
    return {};
  }
}

/**
 * 代理店の設定に上書きを重ねる。
 *
 * 上書きは「書いてあるキーだけ差し替える」。
 * 空配列も指定として扱う (「否定表現を使わない」を選べるようにするため)。
 * 元の設定は書き換えず、新しいオブジェクトを返す
 * (どちらが元の値だったかを画面で出せるようにするため)。
 */
export function applyAgencyOverrides(agency: AgencyFile, overrides: OverridesFile): AgencyFile {
  // 元の設定に agencyNameTexts が無い場合は上書きする対象が無い
  if (!agency.agencyNameTexts) return agency;
  const texts = { ...agency.agencyNameTexts };
  let touched = false;

  if (Array.isArray(overrides.anshinPack)) {
    texts.anshinPack = overrides.anshinPack;
    touched = true;
  }
  if (Array.isArray(overrides.anshinPackNegations)) {
    texts.anshinPackNegations = overrides.anshinPackNegations;
    touched = true;
  }
  if (Array.isArray(overrides.anshinPackAlwaysAllowed)) {
    texts.anshinPackAlwaysAllowed = overrides.anshinPackAlwaysAllowed;
    touched = true;
  }
  if (Array.isArray(overrides.anshinPackAlwaysForbidden)) {
    texts.anshinPackAlwaysForbidden = overrides.anshinPackAlwaysForbidden;
    touched = true;
  }
  if (!touched) return agency;
  return { ...agency, agencyNameTexts: texts };
}

/** 画面から指定された「検査しない代理店コード」 */
export function overrideExcludedCodes(overrides: OverridesFile): string[] {
  return (overrides.excludeAgencyCodes ?? [])
    .map((code) => String(code).trim())
    .filter((code) => code !== '');
}
