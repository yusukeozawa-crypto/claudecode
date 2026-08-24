/**
 * 画面 (npm run ui) の「設定」タブから保存する上書き設定。
 *
 * なぜ別ファイルにするか:
 *   `npm run update` は .env / reports / screenshots 以外を新しい版で
 *   置き換える。config/agency.yml を画面から書き換える作りにすると、
 *   更新するたびに運用側の判断が消える。
 *   そこで上書き専用のファイル (config/overrides.yml) に保存し、
 *   更新時は残す (scripts/update.mjs の KEEP)。Git にも入れない。
 *
 * 適用する側は utils/overrides.ts (検査本体)。
 * 両方で同じキーを扱うため、キー名はここと utils/overrides.ts の
 * 2 か所にある。食い違うと「保存したのに効かない」になるため、
 * scripts/check-ui.mjs で一致を検査している。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** 文字列のリストとして扱うキー */
export const TEXT_LIST_KEYS = ['anshinPack', 'anshinPackNegations', 'excludeAgencyCodes'];
/** 文言 + 理由 のリストとして扱うキー */
export const PHRASE_LIST_KEYS = ['anshinPackAlwaysAllowed', 'anshinPackAlwaysForbidden'];
/** 画面から保存できるキー */
export const RULE_KEYS = [...TEXT_LIST_KEYS, ...PHRASE_LIST_KEYS];

/** 1 件あたりの文字数と件数の上限 (設定ファイルを壊さないための歯止め) */
const MAX_ITEMS = 60;
const MAX_TEXT = 200;
const MAX_REASON = 300;

export function overridesPath(root) {
  return path.join(root, 'config', 'overrides.yml');
}

/** 上書き設定を読む (無ければ空) */
export function readOverrides(root) {
  const file = overridesPath(root);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = parseYaml(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 壊れていても画面は動かす (上書きなしとして扱う)
    return {};
  }
}

/** 制御文字・改行を落として長さをそろえる (設定ファイルを壊さないため) */
function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 画面から送られた内容を検証する。
 *
 * 受け取るのは決めたキーだけ。知らないキーは黙って捨てる
 * (任意の設定を書き込める口にしないため)。
 */
export function validateRules(input) {
  if (input === null || typeof input !== 'object') {
    return { ok: false, error: '送信内容を読み取れませんでした' };
  }
  const value = {};
  for (const key of TEXT_LIST_KEYS) {
    if (!(key in input)) continue;
    if (!Array.isArray(input[key])) return { ok: false, error: `${key} は一覧で送ってください` };
    if (input[key].length > MAX_ITEMS) {
      return { ok: false, error: `${key} は ${MAX_ITEMS} 件までにしてください` };
    }
    const items = input[key].map((item) => clean(item, MAX_TEXT)).filter((item) => item !== '');
    value[key] = [...new Set(items)];
  }
  for (const key of PHRASE_LIST_KEYS) {
    if (!(key in input)) continue;
    if (!Array.isArray(input[key])) return { ok: false, error: `${key} は一覧で送ってください` };
    if (input[key].length > MAX_ITEMS) {
      return { ok: false, error: `${key} は ${MAX_ITEMS} 件までにしてください` };
    }
    const items = [];
    for (const entry of input[key]) {
      const text = clean(entry?.text, MAX_TEXT);
      if (text === '') continue;
      const reason = clean(entry?.reason, MAX_REASON);
      // 理由は必須にする。後から「なぜこの文言を登録したのか」を
      // 説明できないと、運用側の判断として使えない。
      if (reason === '') return { ok: false, error: `「${text}」の理由を書いてください` };
      items.push({ text, reason });
    }
    value[key] = items;
  }
  // 安心パックの語を空にすると、その検査が丸ごと止まる。
  // 「検査していない」ことに気づけないため止める。
  if (Array.isArray(value.anshinPack) && value.anshinPack.length === 0) {
    return { ok: false, error: '安心パックの語を空にはできません (検査が止まります)' };
  }
  return { ok: true, value };
}

/**
 * 上書き設定を保存する。
 *
 * 元の値と同じ内容は書かない (差分だけを残すため)。
 * 直前の内容は 1 つだけ .bak として残す (取り違えたときに戻せるように)。
 */
export function writeOverrides(root, value, base = {}) {
  const file = overridesPath(root);
  const current = readOverrides(root);
  const next = { ...current };
  const changed = [];
  const cleared = [];

  for (const key of RULE_KEYS) {
    if (!(key in value)) continue;
    const same = JSON.stringify(value[key]) === JSON.stringify(base[key] ?? []);
    if (same) {
      if (key in next) {
        delete next[key];
        cleared.push(key);
      }
      continue;
    }
    if (JSON.stringify(next[key]) !== JSON.stringify(value[key])) changed.push(key);
    next[key] = value[key];
  }

  const keys = RULE_KEYS.filter((key) => key in next);
  if (keys.length === 0) {
    // 上書きが無くなったらファイルごと消す (元の設定だけで動く状態に戻す)
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.bak`);
      fs.rmSync(file);
    }
    return { ok: true, changed, cleared, path: file, empty: true };
  }

  const body = {};
  for (const key of keys) body[key] = next[key];
  const text = [
    '# 画面 (npm run ui) の「設定」タブから保存された上書き設定。',
    '#',
    '#   元の設定 (config/agency.yml など) にこの内容を重ねて使う。',
    '#   ここに書いた項目だけが差し替わる (書いていない項目は元のまま)。',
    '#   npm run update でも消えない / Git には入らない。',
    '#',
    `#   最終更新: ${new Date().toISOString()}`,
    '',
    stringifyYaml(body, { lineWidth: 0 }),
  ].join('\n');

  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return { ok: true, changed, cleared, path: file, empty: false };
}
