/**
 * 設定検証の自己検査 (@selfcheck)。
 *
 * 運用者は config/agencies.yml を頻繁に編集する。
 * 「設定に不備があれば実行前に明示的なエラーになる」ことを検証する
 * (気づかないまま検査が素通りするのを防ぐ)。
 */
import { test, expect } from '../qa-fixtures';
import { loadConfig, resolveSelector, validateConfig } from '../../utils/config';
import type { QaConfig } from '../../utils/types';

const config = loadConfig();

/** 設定を壊したコピーを作る (元の設定は変更しない) */
function broken(mutate: (draft: QaConfig) => void): QaConfig {
  const draft = JSON.parse(JSON.stringify(config)) as QaConfig;
  mutate(draft);
  return draft;
}

function expectError(draft: QaConfig, expectedFragment: string): void {
  let message = '';
  try {
    validateConfig(draft);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message, `エラーになること (期待する語: ${expectedFragment})`).not.toBe('');
  expect(message, 'どこが問題か分かるメッセージであること').toContain(expectedFragment);
}

test.describe('設定検証の自己検査 @selfcheck', () => {
  test('正しい設定では検証を通る', async () => {
    expect(() => validateConfig(config), '同梱の設定は妥当であること').not.toThrow();
  });

  test('代理店コードの重複を検出する', async () => {
    expectError(
      broken((draft) => {
        draft.agencies.agencies.push({ ...draft.agencies.agencies[0] });
      }),
      '重複',
    );
  });

  test('リダイレクト設定の矛盾を検出する', async () => {
    // redirected: true なのに遷移先が流入 URL と同じ
    expectError(
      broken((draft) => {
        const agency = draft.agencies.agencies.find((entry) => entry.redirected)!;
        agency.expectedFinalPath = agency.entryPath;
      }),
      'redirected: true',
    );

    // redirected: false なのに遷移先が流入 URL と異なる
    expectError(
      broken((draft) => {
        const agency = draft.agencies.agencies.find((entry) => !entry.redirected)!;
        agency.expectedFinalPath = '/other/';
      }),
      'redirected: false',
    );
  });

  test('申込側の認識確認方法が空の場合を検出する', async () => {
    // URL にコードが載っているだけで合格にしないため、1 つ以上必須
    expectError(
      broken((draft) => {
        draft.agencies.agencies[0].application.recognition = [];
      }),
      'recognition',
    );
  });

  test('表示・非表示セクションの重複を検出する', async () => {
    expectError(
      broken((draft) => {
        const agency = draft.agencies.agencies[0];
        agency.hiddenSections = [...agency.hiddenSections, agency.visibleSections[0]];
      }),
      '重複',
    );
  });

  test('有効コードと無効コードの二重定義を検出する', async () => {
    expectError(
      broken((draft) => {
        draft.agencies.invalidCodes.push({ code: draft.agencies.agencies[0].code, label: '誤って追加' });
      }),
      'invalidCodes',
    );
  });

  test('申込ドメインの未設定を検出する', async () => {
    expectError(
      broken((draft) => {
        draft.environment.applicationBaseUrl = '';
      }),
      'applicationBaseUrl',
    );
  });

  test('存在しないページ id の参照を検出する', async () => {
    expectError(
      broken((draft) => {
        draft.agency.persistenceFlow = ['no-such-page'];
      }),
      'no-such-page',
    );
  });

  test('有効なブラウザが無い場合を検出する', async () => {
    expectError(
      broken((draft) => {
        draft.devices.browsers = draft.devices.browsers.map((browser) => ({ ...browser, enabled: false }));
      }),
      'ブラウザ',
    );
  });
});

test.describe('セレクタ解決の自己検査 @selfcheck', () => {
  test('data-testid を既定とし、css= / text= の指定も使える', async () => {
    expect(resolveSelector('agency-name'), '既定は data-testid').toBe('[data-testid="agency-name"]');
    expect(resolveSelector('css=.agency-box'), 'css= は任意セレクタ').toBe('.agency-box');
    expect(resolveSelector('text=お申し込み'), 'text= はそのまま渡す').toBe('text=お申し込み');
    expect(resolveSelector('xpath=//div'), 'xpath= はそのまま渡す').toBe('xpath=//div');
  });
});
