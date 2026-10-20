/**
 * 設定検証の自己検査 (@selfcheck)。
 *
 * 運用者は config/agencies.yml を頻繁に編集する。
 * 「設定に不備があれば実行前に明示的なエラーになる」ことを検証する
 * (気づかないまま検査が素通りするのを防ぐ)。
 */
import { test, expect } from '../qa-fixtures';
import { applyProductionSafetyLock, loadConfig, parseEnvLines, resolveSelector, sitesOf, validateConfig } from '../../utils/config';
import { isForbiddenRequest } from '../../utils/handoff';
import { buildEntryUrl, waitForFinalLanding } from '../../utils/agency-entry';
import { applyAgencyOverrides, overrideExcludedCodes } from '../../utils/overrides';
import type { EnvironmentConfig, EnvironmentsFile, QaConfig } from '../../utils/types';

const config = loadConfig();

/** 設定を壊したコピーを作る (元の設定は変更しない) */
function broken(mutate: (draft: QaConfig) => void): QaConfig {
  const draft = JSON.parse(JSON.stringify(config)) as QaConfig;
  mutate(draft);
  return draft;
}

/**
 * 検証用の申込仕様。
 *
 * 実サイトの設定では application が null (申込導線の検査をしない) のこともある。
 * 「設定に不備があれば検出できる」ことの検証は、
 * 読み込んだ設定の中身に依存させず、ここで組み立てた値で行う。
 */
function withApplication(draft: QaConfig): QaConfig {
  const agency = draft.agencies.agencies[0];
  agency.application = {
    expectedDomain: null,
    expectedPath: '/entry/',
    handoffMethod: 'query',
    handoffParam: 'agency_code',
    expectedCode: agency.code,
    recognition: [{ type: 'hidden', testId: 'application-agency-code', expected: agency.code }],
    steps: [],
  };
  if (!draft.environment.applicationBaseUrl) {
    draft.environment.applicationBaseUrl = 'https://application.example.test';
  }
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

  test('流入では飛ばず再訪で飛ぶ代理店の設定を通す (カカクコム)', async () => {
    // カカクコムは URL のコードでは専用 LP へ飛ばず、
    // 保存されたコードで再訪したときに飛ぶ。そのため
    //   entryFinalPath      … 流入時の着地 (通常 LP)
    //   expectedFinalPath   … 最終的な表示ページ (専用 LP)
    // が別になる。
    //
    // ここを expectedFinalPath だけで照合していたため、
    // 正しい設定を「不備」として弾き、実サイトの検査が
    // 起動すらできなくなっていた。
    expect(() =>
      validateConfig(
        broken((draft) => {
          draft.agencies.agencies = [
            {
              ...draft.agencies.agencies[0],
              code: 'revisit-case',
              entryPath: '/lp/service/',
              entryFinalPath: '/lp/service/',
              expectedFinalPath: '/lp/service-premium/',
              redirected: false,
              landsAfterRevisit: true,
            },
          ];
        }),
      ),
    ).not.toThrow();
  });

  test('再訪で飛ぶはずなのに行き先が同じ設定を検出する', async () => {
    expectError(
      broken((draft) => {
        draft.agencies.agencies = [
          {
            ...draft.agencies.agencies[0],
            code: 'revisit-same',
            entryPath: '/lp/service/',
            entryFinalPath: '/lp/service/',
            expectedFinalPath: '/lp/service/',
            redirected: false,
            landsAfterRevisit: true,
          },
        ];
      }),
      '再訪後の着地',
    );
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
        // 実サイトの設定では application が null のこともあるため、
        // 検証用の申込仕様を用意してから recognition を空にする
        withApplication(draft);
        const application = draft.agencies.agencies[0].application;
        if (application) application.recognition = [];
      }),
      'recognition',
    );
  });

  test('申込導線を検査しない設定 (application: null) は許容する', async () => {
    // 申込側の仕様が未確定な導入初期に、LP 側の検査だけ先に始められるようにする
    const draft = broken((d) => {
      for (const agency of d.agencies.agencies) agency.application = null;
      d.environment.applicationBaseUrl = '';
    });
    expect(() => validateConfig(draft), 'application: null なら申込ドメインも不要').not.toThrow();
  });


  test('表示・非表示セクションの重複を検出する', async () => {
    expectError(
      broken((draft) => {
        // 実サイトの設定ではセクションが未設定 (空) のこともあるため、
        // 検証用の値をここで用意する
        const agency = draft.agencies.agencies[0];
        agency.visibleSections = ['section-a', 'section-b'];
        agency.hiddenSections = ['section-c', 'section-a'];
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

  test('申込導線を検査する設定なのに申込ドメインが無い場合を検出する', async () => {
    expectError(
      broken((draft) => {
        withApplication(draft);
        draft.environment.applicationBaseUrl = '';
      }),
      'applicationBaseUrl',
    );
  });

  test('.env に同じキーが複数行あるとき後の行を採用する', async () => {
    // 追記で設定を上書きするのは自然な操作。
    // 先の行を優先すると「追記したのに効かない」ことになる
    // (空の行が残っていると値のある行が無視される)。
    const lines = [
      '# コメント行',
      'STAGING_BASE_URL=https://first.example.test',
      'PRODUCTION_BASE_URL=',
      'STAGING_BASE_URL=https://last.example.test',
      'PRODUCTION_BASE_URL=https://prod.example.test',
    ];
    expect(parseEnvLines(lines.join('\n')), '後の行が採用されること').toMatchObject({
      STAGING_BASE_URL: 'https://last.example.test',
      PRODUCTION_BASE_URL: 'https://prod.example.test',
    });

    expect(
      parseEnvLines('\uFEFFSTAGING_BASE_URL=https://bom.example.test'),
      'BOM 付きでも最初のキーが壊れないこと',
    ).toMatchObject({ STAGING_BASE_URL: 'https://bom.example.test' });

    expect(
      parseEnvLines('STAGING_BASIC_PASS="quoted value"'),
      '前後の引用符は取り除くこと',
    ).toMatchObject({ STAGING_BASIC_PASS: 'quoted value' });
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

test.describe('安全装置の自己検査 @selfcheck', () => {
  // モックサイトの申込ドメイン (/entry/ など) を使うため local 環境でのみ実行する。
  // 実サイトに対して実行すると、存在しない URL を開こうとして失敗する。
  test.skip(config.environmentName !== 'local', 'モックサイトを使用するため local 環境でのみ実行します');

  test('申込完了・データ送信のリクエストが遮断される', async ({ page, qaConfig }) => {
    // route ハンドラを 2 つに分けていた頃は、読み取り専用環境で
    // この遮断が機能していなかった。単一ハンドラ化の回帰防止。
    const completeUrl = new URL('/entry/complete', `${qaConfig.environment.applicationBaseUrl}/`).toString();
    const normalUrl = new URL('/entry/', `${qaConfig.environment.applicationBaseUrl}/`).toString();

    expect(isForbiddenRequest(completeUrl, qaConfig), '申込完了 URL は禁止対象').toBe(true);
    expect(isForbiddenRequest(normalUrl, qaConfig), '通常の申込画面は禁止対象ではない').toBe(false);

    // 通常の申込画面は開ける (過剰遮断でないこと)
    const response = await page.goto(normalUrl);
    expect(response?.ok(), '通常の申込画面は開けること').toBe(true);

    // 申込完了 URL は遮断され、ページを開けないこと
    // (遮断により遷移が中断されるため、この検証は最後に行う)
    const error = await page.goto(completeUrl).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error, '申込完了 URL への遷移が遮断されること').not.toBeNull();
    expect(
      String(error),
      'クライアント側で遮断されたことが分かること',
    ).toMatch(/BLOCKED|blockedbyclient|ERR_BLOCKED/i);
  });
});

test.describe('描画完了判定の自己検査 @selfcheck', () => {
  test('readyIndicator の設定不備を検出する', async () => {
    expectError(
      broken((draft) => {
        draft.agency.readyIndicator = { type: 'selector', selector: null, timeoutMs: 5000 };
      }),
      'selector が未設定',
    );
    expectError(
      broken((draft) => {
        draft.agency.readyIndicator = { type: 'attribute', attribute: null, timeoutMs: 5000 };
      }),
      'attribute が未設定',
    );
    expectError(
      broken((draft) => {
        draft.agency.readyIndicator = {
          type: 'unknown' as 'none',
          timeoutMs: 5000,
        };
      }),
      'readyIndicator.type が不正',
    );
  });

  // ------------------------------------------------------------------
  // 画面 (設定タブ) から保存した上書きが検査に効くか
  //
  //   保存できるのに検査に効かない、という壊れ方が一番気づきにくい
  //   (画面上は「変更あり」と出るのに、判定は前のまま)。
  // ------------------------------------------------------------------
  test('画面から保存した上書きが検査の設定に反映される', async ({ qa }) => {
    const base = qa.config.agency;
    const original = base.agencyNameTexts?.anshinPack ?? [];

    // 書いてあるキーだけ差し替わること
    const applied = applyAgencyOverrides(base, {
      anshinPack: ['安心パック'],
      anshinPackAlwaysAllowed: [{ text: '安心パックなしの場合', reason: '前提条件' }],
    });
    expect(applied.agencyNameTexts?.anshinPack, '語が差し替わること').toEqual(['安心パック']);
    expect(
      applied.agencyNameTexts?.anshinPackAlwaysAllowed?.[0].text,
      '許可文言が差し替わること',
    ).toBe('安心パックなしの場合');
    expect(
      applied.agencyNameTexts?.anshinPackAnnotationMarkers,
      '書いていない項目は元のままであること',
    ).toEqual(base.agencyNameTexts?.anshinPackAnnotationMarkers);
    expect(base.agencyNameTexts?.anshinPack, '元の設定を書き換えないこと').toEqual(original);

    // 空配列も「指定」として扱う (否定表現を使わない設定を選べるように)
    const cleared = applyAgencyOverrides(base, { anshinPackNegations: [] });
    expect(cleared.agencyNameTexts?.anshinPackNegations, '空も指定として扱うこと').toEqual([]);

    // 上書きが無ければ元のまま
    expect(applyAgencyOverrides(base, {}), '指定が無ければそのまま返すこと').toBe(base);

    // 検査しない代理店コード
    expect(
      overrideExcludedCodes({ excludeAgencyCodes: [' littlefamily99 ', '', 'A0010'] }),
      '前後の空白を落として空を捨てること',
    ).toEqual(['littlefamily99', 'A0010']);
    expect(overrideExcludedCodes({}), '指定が無ければ空であること').toEqual([]);
  });

  test('条件が現れない場合に記録される (実サイトでの設定漏れを検知する)', async ({ qa, page }) => {
    // 実サイトにモック用の条件が無い状況を再現する
    const original = qa.config.agency.readyIndicator;
    qa.config.agency.readyIndicator = {
      type: 'attribute',
      attribute: 'data-not-exist-anywhere',
      value: '1',
      timeoutMs: 300,
    };

    try {
      await page.goto(`${qa.config.environment.baseUrl}/lp/`);
      const ready = await waitForFinalLanding(page, qa.config, null);
      expect(ready, '条件が現れなければ false を返すこと').toBe(false);

      // 設定が合っていれば true を返す
      qa.config.agency.readyIndicator = original;
      expect(await waitForFinalLanding(page, qa.config, null), '条件が合えば true').toBe(true);
    } finally {
      qa.config.agency.readyIndicator = original;
    }
  });
  test('本番と同じホストを指す環境は読み取り専用として扱う (設定の取り違えの歯止め)', async () => {
    // 画面から URL を保存するとき、環境の選択を間違えると
    // 「送信をブロックしない環境 (ステージング) で本番サイトを開く」状態になる。
    // 実際にステージングの URL が本番を指している状態が発生した。
    const make = (stagingBase: string, corpBase?: string): EnvironmentsFile => ({
      defaultEnvironment: 'staging',
      environments: {
        staging: {
          label: 'ステージング',
          baseUrl: stagingBase,
          applicationBaseUrl: 'https://days.example-stg.com',
          readOnly: false,
          ...(corpBase === undefined ? {} : { sites: { corp: { label: 'コーポ', baseUrl: corpBase } } }),
        } as EnvironmentConfig,
        production: {
          label: '本番',
          baseUrl: 'https://lp.example.com',
          applicationBaseUrl: 'https://days.example.com',
          readOnly: true,
          sites: { corp: { label: 'コーポ', baseUrl: 'https://www.example.com' } },
        } as EnvironmentConfig,
      },
    });

    // 正しい設定: そのまま (読み取り専用にしない)
    const safe = make('https://lp.example-stg.com');
    applyProductionSafetyLock('staging', safe.environments.staging, safe);
    expect(safe.environments.staging.readOnly, '別のホストなら設定どおり動くこと').toBe(false);

    // baseUrl が本番を指している
    const wrong = make('https://lp.example.com');
    applyProductionSafetyLock('staging', wrong.environments.staging, wrong);
    expect(
      wrong.environments.staging.readOnly,
      '本番と同じホストなら読み取り専用にすること',
    ).toBe(true);

    // サイトの 1 つだけが本番を指している場合も止める
    const partly = make('https://lp.example-stg.com', 'https://www.example.com');
    applyProductionSafetyLock('staging', partly.environments.staging, partly);
    expect(
      partly.environments.staging.readOnly,
      'サイトの 1 つでも本番を指していれば読み取り専用にすること',
    ).toBe(true);
  });

  test('環境は複数のサイトを持てる (LP とコーポレートで同じ代理店コードを検査する)', async () => {
    const sites = sitesOf(config);
    expect(sites.length, '少なくとも 1 サイトはあること').toBeGreaterThan(0);
    for (const site of sites) {
      expect(site.id, 'サイトに id があること').toBeTruthy();
      expect(site.baseUrl, `${site.id} の URL があること`).toMatch(/^https?:\/\//);
      expect(site.baseUrl.endsWith('/'), '末尾スラッシュは落とすこと').toBe(false);
    }

    // URL が未設定のサイト (環境変数が空) は対象から外す。
    // コーポレートを登録していない環境でもそのまま動かせるようにするため。
    const draft = broken((copy) => {
      copy.environment.sites = {
        lp: { label: 'LP', baseUrl: config.environment.baseUrl },
        corp: { label: 'コーポ', baseUrl: '${PRODUCTION_CORP_BASE_URL}' },
      };
    });
    expect(
      sitesOf(draft).map((site) => site.id),
      '未解決の環境変数を URL として扱わないこと',
    ).not.toContain('corp');

    // サイトを渡すと、そのドメインと入口のパスで URL を組み立てること
    const corp = { id: 'corp', label: 'コーポレート', baseUrl: 'https://www.example.com', entryPath: '/' };
    const url = buildEntryUrl(config, '/lp/service/', 'littlefamily01', corp);
    expect(url, 'コーポレートのドメインで開くこと').toContain('https://www.example.com/');
    expect(url, 'コーポレートはトップページで判断すること').not.toContain('/lp/service/');
    expect(url, '代理店コードは同じように付けること').toContain(`${config.agency.paramName}=littlefamily01`);
    // サイトを渡さない場合はこれまでどおり
    expect(buildEntryUrl(config, '/lp/service/', null)).toBe(`${config.environment.baseUrl}/lp/service/`);
  });
});
