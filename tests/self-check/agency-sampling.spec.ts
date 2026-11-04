/**
 * 代理店の抽選の自己検査 (@selfcheck)。
 *
 * 代理店が 200 件を超えるサイトでは全件を毎回検査できないため、
 * 挙動パターンごとに抽選する。
 *
 * この抽選には壊れやすい性質が 2 つある。
 *   1. テストは複数のワーカープロセスで実行される。
 *      プロセスごとに抽選し直すとテスト一覧が食い違い実行が壊れる。
 *      → 同じシードなら必ず同じ結果になること
 *   2. 毎回同じ代理店を選ぶと、残りに潜む問題を見逃し続ける。
 *      → シードが変われば選ばれる代理店も変わること
 */
import { test, expect } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { agencySpecs } from '../../utils/agency';
import type { AgenciesFile, AgencySpec, QaConfig } from '../../utils/types';

const baseConfig = loadConfig();

/** パターン付きの代理店を持つ設定を組み立てる (実際の設定は変更しない) */
function configWithAgencies(
  counts: Record<string, number>,
  scope: AgenciesFile['scope'],
): QaConfig {
  const template = baseConfig.agencies.agencies[0];
  const agencies: AgencySpec[] = [];
  for (const [profile, count] of Object.entries(counts)) {
    for (let index = 0; index < count; index += 1) {
      agencies.push({ ...template, code: `${profile}-${String(index).padStart(3, '0')}`, profile });
    }
  }
  return { ...baseConfig, agencies: { ...baseConfig.agencies, scope, agencies } };
}

/** シードを指定して抽選する */
function pick(config: QaConfig, seed: string, scopeEnv?: string): string[] {
  const previousSeed = process.env.QA_AGENCY_SEED;
  const previousScope = process.env.QA_AGENCY_SCOPE;
  process.env.QA_AGENCY_SEED = seed;
  if (scopeEnv === undefined) delete process.env.QA_AGENCY_SCOPE;
  else process.env.QA_AGENCY_SCOPE = scopeEnv;
  try {
    return agencySpecs(config).map((spec) => spec.code);
  } finally {
    if (previousSeed === undefined) delete process.env.QA_AGENCY_SEED;
    else process.env.QA_AGENCY_SEED = previousSeed;
    if (previousScope === undefined) delete process.env.QA_AGENCY_SCOPE;
    else process.env.QA_AGENCY_SCOPE = previousScope;
  }
}

const SCOPE = { mode: 'sample' as const, perProfile: 3, always: ['alpha-000', 'beta-000'] };
const COUNTS = { alpha: 1, beta: 50, gamma: 40, delta: 20 };

test.describe('代理店の抽選の自己検査 @selfcheck', () => {
  test('同じシードなら必ず同じ結果になる (ワーカー間で食い違わない)', async () => {
    const config = configWithAgencies(COUNTS, SCOPE);
    const first = pick(config, 'seed-1');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(pick(config, 'seed-1'), `${attempt + 1} 回目も同じ結果になること`).toEqual(first);
    }
  });

  test('シードが変わると選ばれる代理店が変わる (毎回同じものだけを見ない)', async () => {
    const config = configWithAgencies(COUNTS, SCOPE);
    const results = ['s1', 's2', 's3', 's4', 's5'].map((seed) => pick(config, seed).join(','));
    expect(new Set(results).size, '5 種類のシードで少なくとも 2 通りの結果になること').toBeGreaterThan(1);

    // 抽選対象の代理店が実際に入れ替わっていること
    const rotating = results.map((joined) =>
      joined.split(',').filter((code) => !SCOPE.always.includes(code)).join(','),
    );
    expect(new Set(rotating).size, '固定枠以外が入れ替わること').toBeGreaterThan(1);
  });

  test('パターンごとの件数と固定枠が守られる', async () => {
    const config = configWithAgencies(COUNTS, SCOPE);
    const picked = pick(config, 'seed-fixed');

    for (const code of SCOPE.always) {
      expect(picked, `固定枠 ${code} が必ず含まれること`).toContain(code);
    }
    for (const profile of Object.keys(COUNTS)) {
      const count = picked.filter((code) => code.startsWith(`${profile}-`)).length;
      const available = COUNTS[profile as keyof typeof COUNTS];
      expect(count, `${profile} は perProfile を超えないこと`).toBeLessThanOrEqual(SCOPE.perProfile);
      expect(count, `${profile} は 1 件以上選ばれること`).toBe(Math.min(SCOPE.perProfile, available));
    }
    expect(new Set(picked).size, '同じ代理店を重複して選ばないこと').toBe(picked.length);
  });

  test('出力順はマスタの並び順を保つ (レポートが読みやすい)', async () => {
    const config = configWithAgencies(COUNTS, SCOPE);
    const picked = pick(config, 'seed-order');
    const order = new Map(config.agencies.agencies.map((spec, index) => [spec.code, index]));
    const indices = picked.map((code) => order.get(code) ?? -1);
    expect(indices, 'マスタ順に並んでいること').toEqual([...indices].sort((a, b) => a - b));
  });

  test('QA_AGENCY_SCOPE=all で全件が対象になる', async () => {
    const config = configWithAgencies(COUNTS, SCOPE);
    const total = Object.values(COUNTS).reduce((sum, count) => sum + count, 0);
    expect(pick(config, 'seed-all', 'all').length, '抽選せず全件になること').toBe(total);
    expect(
      pick(config, 'seed-all', 'sample').length,
      'sample を明示した場合は抽選されること',
    ).toBeLessThan(total);
  });

  test('scope が無い設定では全件が対象になる (モックサイト等)', async () => {
    const config = configWithAgencies(COUNTS, undefined);
    const total = Object.values(COUNTS).reduce((sum, count) => sum + count, 0);
    expect(pick(config, 'seed-none').length, 'scope 未設定なら全件になること').toBe(total);
  });

  test('QA_AGENCY_SCOPE に不正な値を指定するとエラーになる (黙って全件にしない)', async () => {
    const config = configWithAgencies(COUNTS, SCOPE);
    expect(() => pick(config, 'seed-bad', 'sanple')).toThrow(/QA_AGENCY_SCOPE/);
  });

  test('存在しないコードを always に書いても落ちない', async () => {
    const config = configWithAgencies(COUNTS, {
      mode: 'sample',
      perProfile: 2,
      always: ['alpha-000', 'NO-SUCH-CODE'],
    });
    const picked = pick(config, 'seed-missing');
    expect(picked, '存在するコードは選ばれること').toContain('alpha-000');
    expect(picked, '存在しないコードは含まれないこと').not.toContain('NO-SUCH-CODE');
  });
  test('コードを名指しすると、そのコードだけを検査する', async () => {
    // 1 社だけ・数社だけをすぐ確かめたい場面のための指定。
    // 抽選・常時検査・画面からの除外より優先する
    // (名指しした人の意図が一番はっきりしているため)。
    const config = configWithAgencies(COUNTS, SCOPE);
    const only = (value: string): string[] => {
      const previous = process.env.QA_AGENCY_ONLY;
      process.env.QA_AGENCY_ONLY = value;
      try {
        return agencySpecs(config).map((spec) => spec.code);
      } finally {
        if (previous === undefined) delete process.env.QA_AGENCY_ONLY;
        else process.env.QA_AGENCY_ONLY = previous;
      }
    };

    expect(only('alpha-000'), '1 社だけ指定できること').toEqual(['alpha-000']);
    expect(only('alpha-000,beta-001'), 'カンマ区切りで複数指定できること').toEqual(['alpha-000', 'beta-001']);
    expect(only(' alpha-000 beta-001 '), '空白区切りでも指定できること').toEqual(['alpha-000', 'beta-001']);
    // Excel の列をそのまま貼ると改行区切りになる (タブや空行が混ざることもある)
    expect(
      only('alpha-000\r\nbeta-001\r\n\r\n'),
      '改行区切り (Excel からの貼り付け) でも指定できること',
    ).toEqual(['alpha-000', 'beta-001']);
    expect(only('alpha-000\tbeta-001'), 'タブ区切りでも指定できること').toEqual(['alpha-000', 'beta-001']);
    expect(only('alpha-000\nalpha-000'), '同じコードを並べても 1 件として扱うこと').toEqual(['alpha-000']);
    expect(only('ALPHA-000'), '大文字小文字を区別しないこと').toEqual(['alpha-000']);
    expect(only('beta-001,alpha-000'), '出力順はマスタの並び順にすること').toEqual(['alpha-000', 'beta-001']);

    // 検査対象にないコードは、黙って 0 件にせずエラーにする。
    // 0 件で終わると「異常なし」に見えてしまう。
    expect(() => only('NO-SUCH-CODE')).toThrow(/QA_AGENCY_ONLY/);
    expect(() => only('alpha-000,NO-SUCH-CODE')).toThrow(/NO-SUCH-CODE/);

    // 指定が無ければこれまでどおり抽選する
    expect(only('').length, '指定が空なら抽選に戻ること').toBeLessThan(
      Object.values(COUNTS).reduce((sum, count) => sum + count, 0),
    );
  });
});
