/**
 * モックサイトの「サイト仕様」データ。
 *
 * 実サイトでは CMS や管理画面が持つ情報にあたる。
 * LP ドメインのサーバーと申込ドメインのサーバーの双方が参照する
 * (実サイトでも両システムが同じ代理店マスタを参照している想定)。
 *
 * ここは検査対象 (SUT) 側の実装であり、テストの期待値は config/agencies.yml で管理する。
 */

/** 代理店マスタ。代理店ごとに挙動が異なる (リダイレクト有無・引き継ぎ方式・表示内容) */
export const AGENCIES = {
  A001: {
    name: '株式会社エーワン保険サービス',
    phone: '03-0000-0001',
    // リダイレクトなし: 流入した LP をそのまま表示する
    redirectTo: null,
    redirectType: 'none',
    banner: '/assets/banner-a001.svg',
    logo: '/assets/logo-a001.svg',
    ctaText: 'Webでお申し込み',
    // 申込ドメインへの引き継ぎ方式: URL クエリパラメータ
    handoffMethod: 'query',
    campaign: '初年度保険料 10% 割引キャンペーン実施中',
  },
  A002: {
    name: '株式会社ビーツー保険',
    phone: '06-0000-0002',
    // HTTP 302 で代理店専用 LP へリダイレクトする
    redirectTo: '/partner/a002/',
    redirectType: 'http',
    banner: '/assets/banner-a002.svg',
    logo: '/assets/logo-a002.svg',
    ctaText: 'パートナー限定プランを申し込む',
    // 申込ドメインへの引き継ぎ方式: 一時トークン (サーバー側セッション)
    handoffMethod: 'token',
    campaign: 'パートナー限定 特別プランのご案内',
  },
  A003: {
    name: 'シースリー少額短期保険株式会社',
    phone: '052-000-0003',
    // meta refresh で代理店専用 LP へリダイレクトする
    redirectTo: '/partner/a003/',
    redirectType: 'meta',
    banner: '/assets/banner-a003.svg',
    logo: '/assets/logo-a003.svg',
    ctaText: 'お申し込み手続きへ進む',
    // 申込ドメインへの引き継ぎ方式: フォームの hidden 項目 + POST 送信
    handoffMethod: 'post',
    campaign: '提携先さま向けのご案内',
  },
};

/** 有効な代理店コードか */
export function isValidCode(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(AGENCIES, code);
}

export function getAgency(code) {
  return isValidCode(code) ? AGENCIES[code] : null;
}

/**
 * 一時トークンの発行 / 復号。
 * 実サイトでは署名付きトークンやサーバー側セッション ID にあたる。
 * テスト側はトークン文字列そのものを比較せず、復元された代理店コードを検証する。
 */
export function issueHandoffToken(code) {
  const nonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return Buffer.from(`${code}.${nonce}`, 'utf8').toString('base64url');
}

export function resolveHandoffToken(token) {
  try {
    const decoded = Buffer.from(String(token), 'base64url').toString('utf8');
    const code = decoded.split('.')[0];
    return isValidCode(code) ? code : null;
  } catch {
    return null;
  }
}

/** HTML エスケープ (URL パラメータをそのまま出力しないための共通処理) */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
