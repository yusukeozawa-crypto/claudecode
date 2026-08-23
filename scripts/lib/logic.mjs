/**
 * このツールの「判定ロジック」を説明用に組み立てる。
 *
 * 目的:
 *   ブラウザ画面のタブと reports/export/logic.md で、
 *   「何をどう見て、どう合否を決めているのか」を第三者に説明できるようにする。
 *
 * 手で書いた説明は必ず古くなるため、値 (対象ページ・端末・件数・重大度・
 * 判定に使う文言) は設定ファイルから読む。読めなかった項目は
 * 「未設定」と出す (それらしい値を埋めると説明が嘘になる)。
 *
 * 3 つのタブに分ける:
 *   簡易        … 何を検査しているか (背景を知らない人向け)
 *   詳細        … 項目ごとの実測方法・合格条件・重大度・設定場所
 *   限界と前提  … このツールで分からないこと (ここを隠すと信用されない)
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const UNSET = '未設定';

function readYaml(file) {
  try {
    return parseYaml(fs.readFileSync(file, 'utf8')) ?? {};
  } catch {
    // 設定が読めなくても画面を落とさない (説明が減るだけにする)
    return {};
  }
}

/** 環境ごとの設定を重ねる (utils/config.ts と同じ考え方) */
function readConfig(configDir, name, environment) {
  const base = readYaml(path.join(configDir, `${name}.yml`));
  if (!environment) return base;
  const overridePath = path.join(configDir, `${name}.${environment}.yml`);
  if (!fs.existsSync(overridePath)) return base;
  return { ...base, ...readYaml(overridePath) };
}

/**
 * チェックリストの列を検査本体 (utils/checklist.ts) から読む。
 * 画面の表と説明で項目名がずれないようにするため、書き写さない。
 */
function checkColumns(root) {
  try {
    const source = fs.readFileSync(path.join(root, 'utils', 'checklist.ts'), 'utf8');
    const block = source.match(/CHECK_COLUMNS[^=]*=\s*\[([\s\S]*?)\];/);
    if (!block) return [];
    return [...block[1].matchAll(/key:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'/g)]
      .map((match) => ({ key: match[1], label: match[2] }));
  } catch {
    return [];
  }
}

function list(values, fallback = UNSET) {
  const items = (values ?? []).filter((value) => value !== undefined && value !== null && value !== '');
  return items.length > 0 ? items.join(' / ') : fallback;
}

/**
 * 項目ごとの説明。
 *
 * 「どう判定するか」は検査コードの説明なので文章で書く。
 * 「何と比べるか」の値は設定から差し込む (設定を変えたら説明も変わる)。
 */
function checkRows(root, ctx) {
  const { agency, agencies, runtime } = ctx;
  const texts = agency.agencyNameTexts ?? {};
  const rows = [];
  const known = {
    redirect: {
      observe:
        'ページを開いたときの request / response イベントをすべて記録し、'
        + '最後に到達した URL と、途中の 3xx・JavaScript (history / location)・'
        + 'meta refresh・SPA のどれで遷移したかを判別する。',
      pass:
        'agencies.yml の expectedRedirectPath と最終 URL が一致し、'
        + '方式 (redirectMechanism) と回数 (expectedRedirectCount) が期待値と一致すること。'
        + '方式・回数が未設定 (unknown / null) の項目は照合せず、実測値だけを記録する。',
      severity: '遷移先が違う: High / 方式・回数だけが違う: Medium',
      source: 'config/agency-profiles.yml',
    },
    'header-name': {
      observe:
        `ヘッダー領域の文字列から、フッター用の接頭辞ではなく「${texts.header ?? '{company}'}」`
        + 'に相当する会社名を読み取る。ヘッダーはクラス名で指さない '
        + '(Tailwind のクラスは見た目を変えるたびに変わるため、指した瞬間に'
        + '「検査していないのに合格」になる)。',
      pass:
        `agencies.yml の agencyName が shown で、かつ headerDevices (${list(texts.headerDevices)}) `
        + 'に含まれる端末では会社名が出ていること。hidden の代理店では出ていないこと。',
      severity: '不一致: Critical',
      source: 'config/agency.yml (agencyNameTexts) / config/agency-profiles.yml',
    },
    'footer-name': {
      observe:
        `footerSelectors (${list(texts.footerSelectors)}) の中で「${texts.footer ?? '募集代理店：{company}'}」`
        + 'の接頭辞を含む最も内側の要素を探し、その次の行を会社名として読む。'
        + '行に「：」が含まれたら別項目とみなして打ち切る。',
      pass: 'agencyName が shown なら会社名が出ていること。hidden なら出ていないこと。',
      severity: '不一致: Critical',
      source: 'config/agency.yml (agencyNameTexts) / config/agency-profiles.yml',
    },
    'anshin-pack': {
      observe:
        `${list(texts.anshinPack)} を含む要素をすべて拾い、要素ごとに`
        + '「その要素自身の文字サイズ」と「本文の文字サイズ」、見出しの中かどうか、'
        + '直後に否定表現が来るかを記録する。',
      pass:
        '掲載可 (○) の代理店では 1 箇所以上あること。'
        + '掲載不可 (×) の代理店では、注釈として許される形以外に出ないこと。'
        + '許される形は「本文より小さい文字」かつ「見出しの中でない」、'
        + `または直後が否定表現 (${list(texts.anshinPackNegations)})。`,
      severity: '掲載不可で訴求あり: Critical / 掲載可で表示なし: Critical',
      source: 'config/agency.yml (anshinPack ほか) / config/agency-profiles.yml',
    },
    'code-carry': {
      observe:
        '申込ページへ遷移したあと、URL・入力値 (hidden 含む)・表示テキスト・'
        + 'localStorage / sessionStorage・申込ドメインの Cookie を順に見て、'
        + '代理店コードが「どこに」あったかを記録する。',
      pass:
        '5 か所のどれか 1 つ以上でそのコードが見つかること。'
        + '別の代理店コードが混ざっていた場合は誤帰属として不合格にする。',
      severity: '引き継がれていない / 別コードに化けている: Critical',
      source: 'utils/handoff.ts (実測) / config/agency.yml (application)',
    },
    storage: {
      observe: 'LP を開いた直後の Cookie 名と localStorage / sessionStorage のキーを記録する。',
      pass:
        (agency.storage?.type ?? 'none') === 'none'
          ? '保存先が未実測 (storage.type: none) のため合否判定は行わず、実測値の記録だけを行う。'
          : `storage.type (${agency.storage.type}) と key (${agency.storage.key ?? UNSET}) に一致する保存があること。`,
      severity: '記録のみ: Low',
      source: 'config/agency.yml (storage)',
    },
  };

  for (const column of checkColumns(root)) {
    const info = known[column.key];
    rows.push([
      column.label,
      info?.observe ?? '(説明未整備)',
      info?.pass ?? '(説明未整備)',
      info?.severity ?? UNSET,
      info?.source ?? UNSET,
    ]);
  }

  // チェックリストの列にはないが、同じ実行の中で見ているもの
  const errors = ctx.errors ?? {};
  const layout = ctx.layout ?? {};
  rows.push([
    'ページの異常',
    `console.error (${list(errors.console?.levels)})・未処理の例外・`
      + `HTTP ${list(errors.network?.failStatuses)} の応答・`
      + `${errors.timeout?.pageLoadWarnMs ?? UNSET}ms を超える読み込みを記録する。`,
    '自社ドメインで発生していないこと。他社タグ (計測・A/B テスト) の中で起きたものは '
      + `${errors.thirdPartyScriptSeverity ?? 'low'} として記録するだけにする (表示を壊すことがあるため無視はしない)。`,
    '自社: High / 他社タグ: Low',
    'config/errors.yml',
  ]);
  rows.push([
    '表示崩れ',
    `横スクロール (許容 ${layout.horizontalScroll?.tolerancePx ?? UNSET}px)・`
      + `画面外へのはみ出し (許容 ${layout.viewportOverflow?.tolerancePx ?? UNSET}px)・`
      + `要素の重なり (許容 ${layout.overlap?.maxOverlapRatio ?? UNSET})・`
      + '読み込めていない画像・空白画面を測る。',
    '許容値を超えないこと。端末ごと (PC / SP) に別々に測る。',
    'High',
    'config/layout.yml',
  ]);
  rows.push([
    'セキュリティ',
    'URL パラメータに外部ドメイン・script タグ・javascript: を入れて開き、'
      + '遷移先とページ内の出力を見る。',
    '外部ドメインへ遷移しないこと。入れた値が HTML としてそのまま出ないこと。'
      + '無効なコードで他代理店の情報が出ないこと。',
    'Critical',
    'tests/security/agency-security.spec.ts',
  ]);
  rows.push([
    '文言',
    '表示テキストを抽出し、表記の揺れ・誤字候補・使用禁止表現を照合する。',
    '正式名称と統一ルールに沿っていること。使用禁止表現がないこと。',
    'Low (必ず報告する)',
    'config/text-rules.yml',
  ]);
  rows.push([
    '実行環境の記録',
    '検査した瞬間に動いていた他社タグ・A/B テストの割り当て (Cookie / '
      + 'localStorage / dataLayer) を記録する。',
    '合否は付けない。「この結果はこの状態で測った」という証跡にする。',
    'Low (記録)',
    'utils/runtime-observation.ts',
  ]);

  const gate = list(runtime.failOnSeverities, UNSET);
  return { rows, gate };
}

/** 抽選 (何件を見ているのか) の説明 */
function samplingLines(profiles, agenciesFile) {
  const scope = profiles.scope ?? {};
  const generated = (agenciesFile.agencies ?? []).length;
  const excluded = (agenciesFile.excludedAgencies ?? []).length;
  const lines = [];
  if (scope.mode === 'all') {
    lines.push(`対象の代理店は全件 (${generated} 件) を毎回検査する設定です。`);
  } else {
    lines.push(
      `代理店は挙動のパターンごとに ${scope.perProfile ?? UNSET} 件を実行ごとに抽選します `
      + `(設定ファイルに載っているのは ${generated} 件)。`,
    );
    lines.push(
      '毎回同じ代理店だけを見ると残りに潜む問題を見逃し続けるため、実行ごとに変えます。'
      + '同じ組み合わせを再現したいときは QA_AGENCY_SEED に前回の値を渡します '
      + '(既定は fixed)。全件を見るときは画面の「全件」を選びます。',
    );
    const always = scope.always ?? [];
    if (always.length > 0) {
      lines.push(`抽選に関係なく毎回必ず検査するコード: ${always.join(', ')}`);
    }
  }
  if (excluded > 0) {
    lines.push(`期待結果が確定していない ${excluded} 件は対象外にしています (画面の「備考」に一覧が出ます)。`);
  }
  return lines;
}

function simpleTab(ctx) {
  const { agency, agencies, profiles, pages, devices, environments, runtime } = ctx;
  const deviceLine = (devices.devices ?? [])
    .map((device) => `${device.label ?? device.id} ${device.viewport?.width ?? '?'}×${device.viewport?.height ?? '?'}`)
    .join(' / ') || UNSET;
  const browsers = (devices.browsers ?? []).filter((browser) => browser.enabled).map((browser) => browser.id);
  const pageLines = (pages.pages ?? []).map((page) => `${page.name ?? page.id} (${page.path})`);
  const columns = checkColumns(ctx.root).map((column) => column.label);

  return {
    id: 'simple',
    label: '簡易',
    summary: '「何を検査しているのか」だけを説明します。',
    blocks: [
      {
        title: 'このツールがすること',
        lines: [
          `代理店コード付きの URL (?${agency.paramName ?? UNSET}=コード) で実際にページを開き、`
          + '表示・画面遷移・保存されている値を実測します。',
          '実測値を、代理店ごとに設定した「こうなるはず」と突き合わせます。'
          + '期待結果は設定ファイル (config/agency-profiles.yml) だけに書き、検査コードには書きません。'
          + '代理店を 1 行足せば、その代理店の検査が増えます。',
          '人が押すのと同じブラウザ (Chromium) で開くので、'
          + 'Zoho の A/B テストや GTM で後から差し込まれる表示も、動いている状態のまま検査します。',
        ],
      },
      {
        title: '見ているところ',
        lines: [
          columns.length > 0 ? `代理店ごとの判定: ${columns.join(' / ')}` : '代理店ごとの判定: (未設定)',
          'ページ共通の判定: ページの異常 (エラー・404・遅い読み込み) / 表示崩れ / '
          + 'リンク切れ / 画像の読み込み / 文言 / セキュリティ',
          `端末: ${deviceLine}`,
          `ブラウザ: ${browsers.join(' / ') || UNSET}`,
          pageLines.length > 0 ? `ページ: ${pageLines.join(' / ')}` : `ページ: ${UNSET}`,
        ],
      },
      {
        title: '何件を見ているか',
        lines: samplingLines(profiles, agencies),
      },
      {
        title: '合否の付け方',
        lines: [
          '重大度は Critical / High / Medium / Low の 4 段階です。',
          `${list(runtime.failOnSeverities)} が 1 件でもあれば、その実行は失敗として扱います `
          + '(CI もここで落ちます)。',
          'Low は「直す必要はないが記録しておくもの」です。合格した項目も記録します '
          + '(検査が動いていないことと、問題がないことを区別できるようにするため)。',
          '実測値と期待値の両方をレポートに出します。判定だけを出すと、'
          + 'ツールが間違っているのかサイトが間違っているのかを確かめられません。',
        ],
      },
      {
        title: 'やらないこと (安全のため)',
        lines: [
          `本番環境は読み取り専用です (config/environments.yml の readOnly: ${
            environments.environments?.production?.readOnly === true ? 'true' : UNSET
          })。`,
          '自社ドメインへの GET 以外の通信をブラウザ側で止めるので、申込の送信・完了は起こりません。'
          + '他社タグ (計測・A/B テスト) は止めません (動いている状態を検査するため)。',
          '個人情報は一切入力しません。使うのは代理店コードだけです。',
          `同時実行は ${runtime.workers ?? UNSET} (CI は ${runtime.workersCi ?? UNSET})、`
          + `遷移前に ${runtime.throttle?.navigationDelayMs ?? UNSET}ms 待ちます。`
          + '対象サイトへ過剰なリクエストを送らないためです。',
          `このツールのアクセスは User-Agent の末尾に ${devices.userAgentSuffix ?? UNSET} が付きます。`
          + '計測ツール側で除外できるようにするためです。',
          'トークンなどの秘密の値はレポート上でマスキングします。',
        ],
      },
    ],
  };
}

function detailTab(ctx) {
  const { rows, gate } = checkRows(ctx.root, ctx);
  const texts = ctx.agency.agencyNameTexts ?? {};
  const forbidden = texts.anshinPackAlwaysForbidden ?? [];
  const blocks = [
    {
      title: '項目ごとの判定',
      note: '「実測すること」はブラウザで測る内容、「合格の条件」は設定と突き合わせる内容です。',
      table: {
        head: ['項目', '実測すること', '合格の条件', '不一致のときの重大度', '設定場所'],
        rows,
      },
    },
    {
      title: '安心パックの判定を細かく書くと',
      note: '安心パック (= みらいの約束) は損害保険の資格が必要な商品です。'
        + '少額短期保険の資格しか持たない代理店 (みらやく掲載不可) に訴求させると法令違反になります。'
        + '一方で「安心パックなし」のような注釈は保険料の前提条件で、資格の問題にはあたりません。'
        + 'そのため語が出たかどうかではなく、どの文脈で出たかで判定します。',
      lines: [
        `1. ${list(texts.anshinPack)} のいずれかを含む要素をすべて拾います。`,
        `2. 「文字の大きさに関係なく違反」と決めた文言 (${
          forbidden.length > 0 ? forbidden.map((entry) => `「${entry.text}」`).join(' / ') : 'なし'
        }) で始まる場合は、その時点で違反にします。`
          + (forbidden.length > 0
            ? ` 理由: ${forbidden.map((entry) => entry.reason ?? '(理由未記載)').join(' / ')}`
            : ''),
        `3. 語の直後が否定表現 (${list(texts.anshinPackNegations)}) なら訴求ではないので許します。`
          + '同じ要素の中に複数回出るときは、1 つでも否定でない出現があれば否定扱いにしません。',
        '4. 残りは文字の大きさで決めます。その要素の文字が本文より小さく、かつ見出し (h1〜h6) の中でなければ'
          + '「注釈」として許し、それ以外は違反にします。',
        `5. 許した注釈も件数と全文を証跡と CSV に残します。黙って無視すると、判定が間違っていても気づけません。`,
      ],
    },
    {
      title: '「※」を判定に使わない理由',
      lines: [
        `注釈の目印 (${list(texts.anshinPackAnnotationMarkers)}) は判定に使っていません。`,
        '実サイトでは「※5」と注釈文が別の span に分かれていたり、'
        + '目印が前の要素にあったりして、DOM の形が一定ではありませんでした。'
        + '目印の有無で決めると、書き方が変わるたびに合否が入れ替わります。',
        '文字の大きさは「注釈として小さく併記している」という見た目の事実そのものなので、'
        + '書き方が変わっても意味が変わりません。',
      ],
    },
    {
      title: '遷移と引き継ぎを推測で判定しない理由',
      lines: [
        'リダイレクトは URL の見た目では判定しません。request / response イベントから'
        + '3xx / JavaScript / meta refresh / SPA を判別し、方式が未実測の代理店では'
        + '方式の照合をせず実測値を記録します。推測した方式で判定すると、'
        + '正常なサイトを不具合として報告してしまいます。',
        '申込ページへの引き継ぎも、URL にコードが載っているだけでは合格にしません。'
        + 'URL・入力値・表示・保存領域・申込ドメインの Cookie のどこにあったかを記録します。',
        '一時トークンを使う方式では、トークン文字列そのものを固定値と比較しません '
        + '(毎回変わる値なので、比較すると必ず落ちます)。'
        + 'レポート上ではマスキングします。',
      ],
    },
    {
      title: '同じ結果が続かないための仕組み',
      lines: [
        'PC と SP は別のプロセスで実行するため、端末差はレポート作成時に比べます。'
        + '同じ項目で PC と SP の結果が違う場合は、その差もレポートに出します。',
        '実行中は 10 秒ごとに途中結果を書き出します。'
        + '途中で止まった実行は「途中結果」と明示し、完了した実行と混同しません。',
        'テストの終了時刻の間隔が 5 分以上空いていたら、実行端末がスリープした可能性として記録します '
        + '(スリープを挟んだ結果は信用できないため)。',
        `重大度ゲート: ${gate} が 1 件でもあれば失敗にします。`,
      ],
    },
  ];
  return {
    id: 'detail',
    label: '詳細',
    summary: '判定の中身です。設定ファイルの値をそのまま出しています。',
    blocks,
  };
}

function limitsTab(ctx) {
  const { agency, agencies, profiles, environments, errors } = ctx;
  const scope = profiles.scope ?? {};
  const items = [];

  if (scope.mode !== 'all') {
    items.push({
      title: '毎回すべての代理店を見ているわけではありません',
      detail:
        `既定はパターンごとに ${scope.perProfile ?? UNSET} 件の抽選です。`
        + '抽選は QA_AGENCY_SEED (既定 fixed) で再現できますが、'
        + '「異常なし」は「抽選に当たった代理店では異常なし」という意味です。'
        + '全件を見た結果が必要なときは「全件」で実行してください。',
    });
  }
  items.push({
    title: 'A/B テストは当たった片方しか見ていません',
    detail:
      'Zoho PageSense などの A/B テストは動かしたまま検査します (実際の表示を見るため)。'
      + 'そのため 1 回の実行で見えるのは割り当てられた片方だけです。'
      + 'どちらが当たっていたかは実行ごとに記録しています (Low の「検査したときサイトで動いていたもの」)。'
      + '両方を確かめるには複数回実行するか、テストを止めて実行する必要があります。',
  });
  items.push({
    title: '語を含まない訴求文は拾えません',
    detail:
      `安心パックの判定は ${list(agency.agencyNameTexts?.anshinPack)} という語を含む要素だけを見ています。`
      + '「月額＋180円※1〜でさらに安心！」のように語を書かずに同じ商品を訴求している文は検知できません。'
      + '語を増やせば拾えますが、増やすと関係のない文まで拾って誤検知が増えます。'
      + 'ここは人が見る前提の範囲です。',
  });
  if (environments.environments?.production?.readOnly === true) {
    items.push({
      title: '本番では送信を伴う確認をしていません',
      detail:
        '本番は読み取り専用です。申込の送信・完了は実行しないため、'
        + '送信して初めて分かる引き継ぎ (サーバー側セッション・送信後の帰属) は'
        + '静的な確認 (URL・入力値・表示・保存領域・Cookie) だけになります。'
        + '送信を伴う確認はステージングで行ってください。',
    });
  }
  items.push({
    title: '「コード保持=あり」は有効なコードである証拠ではありません',
    detail:
      '申込ページで代理店コードが見つかったという事実だけを記録しています。'
      + 'そのコードが登録済みで、申込がその代理店に帰属するかどうかは、'
      + 'サイト側の管理画面でしか確認できません。'
      + '存在しないコードでも保存される実装があるため、無効コードを渡したときに'
      + '保存されるかどうかも別に記録しています (Low)。',
  });
  if ((agency.storage?.type ?? 'none') === 'none') {
    items.push({
      title: '代理店コードの保存先は未実測です',
      detail:
        'config/agency.yml の storage.type が none のため、保存値を根拠にした合否判定をしていません '
        + '(URL だけで引き回す実装を誤検知しないため)。実測値は記録しているので、'
        + 'Cookie 名 / localStorage キーが確定したら設定してください。',
    });
  }
  const unknownMechanism = (agencies.agencies ?? []).filter((entry) => entry?.redirectMechanism === 'unknown');
  if (unknownMechanism.length > 0) {
    items.push({
      title: `遷移方式が未実測の代理店が ${unknownMechanism.length} 件あります`,
      detail:
        '方式 (3xx / JavaScript / meta refresh / SPA) が未確定の代理店では、方式の照合をしていません。'
        + '実測値はレポートに出ているので、確定したら config/agency-profiles.yml に設定してください。',
    });
  }
  items.push({
    title: '中断された実行の結果は信用しないでください',
    detail:
      '実行中に PC がスリープした・回線が切れた場合、そのあとの結果は'
      + '「止まっていた時間の後のサイトの状態」になります。'
      + '5 分以上の空白を検知したときは画面上に警告を出します。'
      + 'この警告が出ている実行の結果は、再実行して確認してください。',
  });
  items.push({
    title: '見た目の良し悪しは判定していません',
    detail:
      '測っているのは「はみ出し・重なり・画像の読み込み・空白画面」という数値で表せるものだけです。'
      + '「デザインが崩れて見える」「文章が分かりにくい」は検知できません。'
      + 'スクリーンショットの差分は、前回との違いを出すだけで、'
      + 'どちらが正しいかは人が判断します。',
  });
  items.push({
    title: '他社タグの中で起きたエラーは重大度を下げています',
    detail:
      `計測・A/B テストのスクリプト内部で起きたエラーは ${errors.thirdPartyScriptSeverity ?? 'low'} として記録します。`
      + '自社のコードではないため Critical / High にはしませんが、'
      + '表示を壊すことがあるので無視もしません。件数が増えたら中身を見てください。',
  });

  return {
    id: 'limits',
    label: '限界と前提',
    summary: 'このツールで「分からないこと」です。ここを踏まえずに結果だけを見ると判断を誤ります。',
    blocks: items.map((item) => ({ title: item.title, lines: [item.detail] })),
  };
}

/**
 * ロジック説明を組み立てる。
 *
 * @param root プロジェクトのルート
 * @param options.environment 環境名 (local のときモック用の設定を読む)
 */
export function buildLogic(root, options = {}) {
  const configDir = path.join(root, 'config');
  const { environment = null, now = new Date() } = options;
  const ctx = {
    root,
    agency: readConfig(configDir, 'agency', environment),
    agencies: readConfig(configDir, 'agencies', environment),
    profiles: readYaml(path.join(configDir, 'agency-profiles.yml')),
    pages: readConfig(configDir, 'pages', environment),
    devices: readYaml(path.join(configDir, 'devices.yml')),
    environments: readYaml(path.join(configDir, 'environments.yml')),
    runtime: readYaml(path.join(configDir, 'runtime.yml')),
    errors: readYaml(path.join(configDir, 'errors.yml')),
    layout: readYaml(path.join(configDir, 'layout.yml')),
  };
  return {
    generatedAt: now.toISOString(),
    environment,
    tabs: [simpleTab(ctx), detailTab(ctx), limitsTab(ctx)],
  };
}

/** 共有用の Markdown にする (人に渡す・AI に読ませる用) */
export function logicMarkdown(logic) {
  const lines = ['# Webサイト公開後 自動QA — 判定ロジック', ''];
  lines.push(`生成: ${logic.generatedAt}`, '');
  lines.push(
    'この文書は設定ファイル (config/) から自動生成しています。',
    '設定を変えれば内容も変わります。手で書き足すと実際の判定とずれるため、書き足さないでください。',
    '',
  );
  for (const tab of logic.tabs) {
    lines.push(`## ${tab.label}`, '', tab.summary, '');
    for (const block of tab.blocks) {
      lines.push(`### ${block.title}`, '');
      if (block.note) lines.push(block.note, '');
      for (const line of block.lines ?? []) lines.push(`- ${line}`);
      if (block.lines?.length) lines.push('');
      if (block.table) {
        lines.push(`| ${block.table.head.join(' | ')} |`);
        lines.push(`| ${block.table.head.map(() => '---').join(' | ')} |`);
        for (const row of block.table.rows) {
          lines.push(`| ${row.map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | ')} |`);
        }
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}
