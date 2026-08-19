/**
 * マスキングの網羅確認 (@selfcheck)。
 * 形式ごとに「秘密情報が消えること」と「壊れないこと」を検証する。
 */
import { test, expect } from '../qa-fixtures';
import { loadConfig } from '../../utils/config';
import { maskText, maskUrl } from '../../utils/secrets';

const config = loadConfig();
const TOKEN = 'c2VjcmV0LXRva2VuLXZhbHVlLTEyMzQ1Njc4OTA';

test.describe('マスキングの形式別確認 @selfcheck', () => {
  test.skip(config.environmentName !== 'local', 'local 環境でのみ実行します');

  test('クエリ形式の秘密情報・個人情報がマスクされる', async () => {
    const cases = [
      `${config.environment.applicationBaseUrl}/entry/?handoff_token=${TOKEN}`,
      `${config.environment.baseUrl}/lp/?agency_code=X001&mail=someone@example.com`,
      `${config.environment.baseUrl}/lp/?tel=090-1234-5678`,
    ];
    for (const value of cases) {
      const masked = maskText(value, config) ?? '';
      expect(masked, `秘密情報が残らないこと: ${value}`).not.toContain(TOKEN);
      expect(masked, '個人情報が残らないこと').not.toContain('someone@example.com');
      expect(masked, '個人情報が残らないこと').not.toContain('090-1234-5678');
    }
  });

  test('JSON 形式でマスクしても JSON として解析できる', async () => {
    const payload = {
      handoff_token: TOKEN,
      agency_code: 'X001',
      hops: [{ url: `${config.environment.applicationBaseUrl}/entry/?handoff_token=${TOKEN}`, status: 200 }],
      // 調査ツールが出力する hidden 項目名 (マスクされてはいけない)
      hiddenFields: [{ name: config.agency.paramName, hasValue: true }],
    };
    const serialized = JSON.stringify(payload, null, 2);
    const masked = maskText(serialized, config) ?? '';

    expect(masked, 'トークンが残らないこと').not.toContain(TOKEN);
    expect(() => JSON.parse(masked), 'JSON として解析できること').not.toThrow();

    const parsed = JSON.parse(masked) as typeof payload;
    expect(parsed.agency_code, '代理店コードは保持されること').toBe('X001');
    expect(parsed.hops[0].status, '構造が保持されること').toBe(200);
    expect(
      parsed.hiddenFields[0].name,
      'JSON のキー名 (name) は潰さないこと — 調査結果が読めなくなるため',
    ).toBe(config.agency.paramName);
  });

  test('maskUrl はキー名と値のパターンの双方で判定する', async () => {
    const base = `${config.environment.baseUrl}/lp/?${config.agency.paramName}=X001`;
    expect(maskUrl(`${base}&handoff_token=${TOKEN}`, config)).not.toContain(TOKEN);
    expect(maskUrl(`${base}&mail=a@example.com`, config)).not.toContain('a@example.com');
    // キー名が無害でも値が個人情報なら判定する
    expect(maskUrl(`${base}&ref=a@example.com`, config)).not.toContain('a@example.com');
    // 代理店コードは残る
    expect(maskUrl(`${base}&handoff_token=${TOKEN}`, config)).toContain(`${config.agency.paramName}=X001`);
    // URL として壊れない
    expect(() => new URL(maskUrl(`${base}&handoff_token=${TOKEN}`, config))).not.toThrow();
  });
});
