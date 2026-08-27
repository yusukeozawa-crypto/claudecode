#!/usr/bin/env node
/**
 * モックサイト: LP ドメイン (既定 http://127.0.0.1:4173)。
 *
 * QA ツールの動作確認専用。実サイトの想定挙動を模している。
 *   - 代理店コードごとのリダイレクト (なし / HTTP 302 / meta refresh)
 *   - 代理店コードごとの表示セクション・代理店名・電話番号・バナー・CTA
 *   - 申込ドメイン (別オリジン) への引き継ぎ (クエリ / 一時トークン / POST)
 *   - Cookie + localStorage への保存と、保存値からの復元
 *   - open redirect 対策・URL パラメータのエスケープ
 *   - 404 / 500 / リダイレクトループの再現 (検出ロジックの自己検査用)
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENCIES, escapeHtml, getAgency, isValidCode, issueHandoffToken } from './agency-master.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_SITE_PORT || 4173);
const HOST = process.env.MOCK_SITE_HOST || '127.0.0.1';
/** 申込ドメイン (別オリジン)。ホスト名を変えることで Cookie が共有されない状況を再現する */
const APPLICATION_ORIGIN = process.env.MOCK_APPLICATION_ORIGIN || 'http://localhost:4174';

const PARAM_NAME = 'agency_code';

/**
 * /protected/ の Basic 認証情報。
 * テスト側と同じ値を参照するため JSON を単一の情報源とする
 * (import 属性はバージョン差があるため readFileSync で読む)。
 */
const BASIC_AUTH = JSON.parse(readFileSync(path.join(ROOT, 'basic-auth.json'), 'utf8'));
const STORAGE_KEY = 'agency_code';

/** 代理店コードにより表示・非表示が変わるセクション (LP 種別ごと) */
const SECTIONS = {
  '/lp/': {
    default: {
      visible: ['default-hero', 'common-benefits', 'default-contact'],
      hidden: ['agency-campaign', 'agency-contact', 'agency-only-content'],
    },
    agency: {
      visible: ['default-hero', 'common-benefits', 'agency-campaign', 'agency-contact', 'agency-only-content'],
      hidden: ['default-contact'],
    },
  },
  partner: {
    default: {
      visible: ['partner-exclusive-hero', 'partner-exclusive-offer'],
      hidden: ['agency-contact'],
    },
    agency: {
      visible: ['partner-exclusive-hero', 'partner-exclusive-offer', 'agency-contact'],
      hidden: [],
    },
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function readCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split('; ').reduce((accumulator, part) => {
    const [name, ...rest] = part.split('=');
    accumulator[decodeURIComponent(name)] = decodeURIComponent(rest.join('='));
    return accumulator;
  }, {});
}

/** CTA の遷移先を引き継ぎ方式に応じて組み立てる */
function buildCta(code, agency) {
  if (!code || !agency) {
    return {
      text: 'お申込みはこちら',
      href: `${APPLICATION_ORIGIN}/entry/`,
      handoffMethod: 'none',
      agencyCode: '',
    };
  }
  switch (agency.handoffMethod) {
    case 'token': {
      // 一時トークン方式: コード自体は URL に載せない
      const token = issueHandoffToken(code);
      return {
        text: agency.ctaText,
        href: `${APPLICATION_ORIGIN}/entry/?handoff_token=${encodeURIComponent(token)}`,
        handoffMethod: 'token',
        agencyCode: '',
      };
    }
    case 'post':
      // POST 方式: フォームの hidden 項目で送信する
      return {
        text: agency.ctaText,
        href: `${APPLICATION_ORIGIN}/entry/`,
        handoffMethod: 'post',
        agencyCode: code,
      };
    default:
      return {
        text: agency.ctaText,
        href: `${APPLICATION_ORIGIN}/entry/?${PARAM_NAME}=${encodeURIComponent(code)}`,
        handoffMethod: 'query',
        agencyCode: code,
      };
  }
}

/**
 * 支店コードか (末尾が BRnn)。
 * 実サイトの支店コード (末尾 brNN) は代理店コードとして扱われず、
 * 通常 LP のまま何も変わらない。その挙動を再現するために区別する。
 */
function isBranchCode(code) {
  return typeof code === 'string' && /BR\d+$/i.test(code);
}

/** ページに埋め込む代理店コンテキストを組み立てる */
function buildContext({ pathname, code, fromUrl }) {
  const agency = getAgency(code);
  const sectionSet = pathname.startsWith('/partner/') ? SECTIONS.partner : SECTIONS['/lp/'];
  const variant = agency ? sectionSet.agency : sectionSet.default;

  return {
    paramName: PARAM_NAME,
    storageKey: STORAGE_KEY,
    activeCode: agency ? code : null,
    // 支店コード (末尾 BRnn) は「受け取るが何もしない」。
    // 実サイトの支店コードと同じ挙動 (通常 LP のまま、
    // 代理店情報もフォールバック案内も出さない) を再現する。
    invalidCode: Boolean(code) && !agency && !isBranchCode(code),
    fromUrl: Boolean(fromUrl),
    agency: agency
      ? {
          mirayaku: agency.mirayaku ?? '○',
          name: agency.name,
          phone: agency.phone,
          banner: agency.banner,
          logo: agency.logo,
          campaign: agency.campaign,
        }
      : null,
    visibleSections: variant.visible,
    hiddenSections: variant.hidden,
    cta: buildCta(agency ? code : null, agency),
  };
}

/**
 * meta refresh 方式のリダイレクトタグ。
 * HTTP ステータスは 200 のまま遷移するため、テスト側は仕組みの違いを検出できる。
 */
function metaRefreshTag(targetUrl) {
  return `<meta http-equiv="refresh" content="0;url=${escapeHtml(targetUrl)}">`;
}

async function serveHtml(res, filePath, injected) {
  const raw = await fs.readFile(filePath, 'utf8');
  // JSON.stringify の結果に </script> が含まれないようにエスケープする
  const serialized = JSON.stringify(injected.context).replace(/</g, '\\u003c');
  const head = [
    injected.metaRefresh ?? '',
    `<script>window.__AGENCY_CONTEXT__ = ${serialized};</script>`,
  ].join('\n');
  const html = raw.replace('<!--AGENCY_CONTEXT-->', head);
  res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // 不正なパーセントエンコーディング (/% など) で落ちないようにする
    res.writeHead(400, { 'content-type': MIME['.html'] });
    res.end('<h1>400 Bad Request</h1>');
    return;
  }
  const cookies = readCookies(req);

  // ---------- 検出ロジックの自己検査用エンドポイント ----------
  // 応答を遅延させる (タイムアウト検知の検証用)。ms は 5000 を上限とする。
  if (pathname === '/slow') {
    const requested = Number(url.searchParams.get('ms') ?? 1000);
    const delay = Math.min(Number.isFinite(requested) ? Math.max(0, requested) : 1000, 5000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>遅延応答</title></head>` +
        `<body><h1 data-testid="slow-page">遅延応答ページ</h1>` +
        `<p>このページは ${delay}ms 待ってから応答します (タイムアウト検知の検証用)。</p></body></html>`,
    );
    return;
  }

  // 意図的に脆弱なエンドポイント (反射型 XSS の検出ロジックの検証用)。
  // 受け取った値をエスケープせず HTML に出力する。
  // 検査対象サイトの脆弱性を「見逃さない」ことを確認するために存在する。
  if (pathname === '/broken/reflect') {
    const raw = url.searchParams.get(PARAM_NAME) ?? '';
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>反射テスト</title></head>` +
        `<body><h1 data-testid="reflect-page">入力値の反射 (検証用)</h1>` +
        // エスケープせずに出力する (これが検出されるべき脆弱性)
        `<p>入力: ${raw}</p></body></html>`,
    );
    return;
  }

  // Basic 認証で保護されたページ (ステージング環境の再現)。
  // 認証情報が httpCredentials として実際に送られるかの検証用。
  if (pathname === '/protected/') {
    const auth = req.headers.authorization ?? '';
    let ok = false;
    if (auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      ok =
        separator !== -1 &&
        decoded.slice(0, separator) === BASIC_AUTH.username &&
        decoded.slice(separator + 1) === BASIC_AUTH.password;
    }
    if (!ok) {
      res.writeHead(401, {
        'content-type': MIME['.html'],
        'www-authenticate': 'Basic realm="staging"',
        'cache-control': 'no-store',
      });
      res.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><h1>401 Unauthorized</h1></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(
      '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>認証済み</title></head>' +
        '<body><h1 data-testid="protected-page">認証済みページ</h1></body></html>',
    );
    return;
  }

  // URL の書き換えだけを行うページ (遷移として数えないことの検証用)。
  //   実サイトでは計測タグ・同意バナー・ABテストのスクリプトが
  //   history.replaceState でクエリを書き換えたり # を付けたりする。
  //   kind=query  … クエリだけ書き換える (遷移ではない)
  //   kind=hash   … フラグメントだけ付ける (遷移ではない)
  //   kind=path   … パスを変える (SPA 遷移として数える)
  if (pathname === '/url-rewrite') {
    const kind = url.searchParams.get('kind') ?? 'query';
    const script =
      kind === 'path'
        ? "history.pushState({}, '', '/url-rewrite-moved/');"
        : kind === 'hash'
          ? "location.hash = 'section';"
          : "history.replaceState({}, '', location.pathname + '?utm_source=test');";
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(
      '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>URL 書き換え</title></head>' +
        `<body><h1 data-testid="url-rewrite-page">URL 書き換え (${escapeHtml(kind)})</h1>` +
        `<script>${script}</script></body></html>`,
    );
    return;
  }

  if (pathname === '/server-error') {
    res.writeHead(500, { 'content-type': MIME['.html'] });
    res.end('<h1>500 Internal Server Error</h1>');
    return;
  }
  if (pathname === '/redirect-loop-a') {
    res.writeHead(302, { location: '/redirect-loop-b' });
    res.end();
    return;
  }
  if (pathname === '/redirect-loop-b') {
    res.writeHead(302, { location: '/redirect-loop-a' });
    res.end();
    return;
  }

  // ---------- サイトルート ----------
  if (pathname === '/') {
    res.writeHead(302, { location: `/lp/${url.search}` });
    res.end();
    return;
  }

  // ---------- LP / 代理店専用 LP ----------
  const isLandingPage = pathname === '/lp/' || pathname === '/lp' || pathname.startsWith('/partner/');
  if (isLandingPage) {
    const normalized = pathname === '/lp' ? '/lp/' : pathname;
    const rawCode = url.searchParams.get(PARAM_NAME);
    // URL パラメータが無い場合は保存済みコードから復元する
    const storedCode = cookies[STORAGE_KEY] ?? null;
    const code = rawCode !== null && rawCode !== '' ? rawCode : storedCode;
    const agency = getAgency(code);

    // open redirect 対策: 外部ドメインへの遷移指示は受け付けない
    const nextParam = url.searchParams.get('next') ?? url.searchParams.get('redirect_to');
    if (nextParam) {
      let allowed = false;
      try {
        const target = new URL(nextParam, `http://${req.headers.host}`);
        allowed = target.host === req.headers.host && target.protocol === 'http:';
      } catch {
        allowed = false;
      }
      if (allowed) {
        res.writeHead(302, { location: new URL(nextParam, `http://${req.headers.host}`).pathname });
        res.end();
        return;
      }
      // 許可されない遷移先は無視してそのままページを表示する (リダイレクトしない)
    }

    // 代理店ごとのリダイレクト。
    //   redirectOnlyWithStoredCode の代理店は「保存済みコードで開いたとき」だけ
    //   リダイレクトする (流入時は専用 LP に直接入ってくるため飛ばさない)。
    const redirectApplies =
      agency &&
      agency.redirectTo &&
      normalized !== agency.redirectTo &&
      (!agency.redirectOnlyWithStoredCode || getAgency(storedCode) === agency);
    if (redirectApplies) {
      const target = `${agency.redirectTo}?${PARAM_NAME}=${encodeURIComponent(code)}`;
      if (agency.redirectType === 'http') {
        res.writeHead(302, { location: target, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (agency.redirectType === 'meta') {
        // meta refresh: HTTP 200 のまま、共通 LP に refresh タグを埋め込む
        await serveHtml(res, path.join(ROOT, 'lp/index.html'), {
          context: buildContext({ pathname: normalized, code, fromUrl: rawCode !== null }),
          metaRefresh: metaRefreshTag(target),
        });
        return;
      }
    }

    const filePath = normalized === '/lp/'
      ? path.join(ROOT, 'lp/index.html')
      : path.resolve(ROOT, normalized.replace(/^\/+/, ''), 'index.html');

    // ROOT の外へ出るパス (..%2f など) を拒否する。
    // pathname は decodeURIComponent 済みなので、ここで必ず確認する。
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403, { 'content-type': MIME['.html'] });
      res.end('<h1>403 Forbidden</h1>');
      return;
    }

    try {
      await serveHtml(res, filePath, {
        context: buildContext({ pathname: normalized, code, fromUrl: rawCode !== null }),
      });
    } catch {
      res.writeHead(404, { 'content-type': MIME['.html'] });
      res.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>404</title></head><body><h1>404 Not Found</h1></body></html>');
    }
    return;
  }

  // ---------- その他の静的ページ (代理店コンテキストを注入する) ----------
  const relative = pathname.replace(/^\/+/, '');
  const target = path.resolve(ROOT, relative);
  // ROOT + セパレータで比較する (兄弟ディレクトリへの脱出を防ぐ)
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(target);
    const filePath = stat.isDirectory() ? path.join(target, 'index.html') : target;
    if (path.extname(filePath) === '.html') {
      const rawCode = url.searchParams.get(PARAM_NAME);
      const code = rawCode !== null && rawCode !== '' ? rawCode : cookies[STORAGE_KEY] ?? null;
      const raw = await fs.readFile(filePath, 'utf8');
      if (raw.includes('<!--AGENCY_CONTEXT-->')) {
        await serveHtml(res, filePath, {
          context: buildContext({ pathname, code, fromUrl: rawCode !== null }),
        });
        return;
      }
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(raw);
      return;
    }
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': MIME['.html'] });
    res.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>404</title></head><body><h1>404 Not Found</h1></body></html>');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`mock LP site listening on http://${HOST}:${PORT} (application: ${APPLICATION_ORIGIN})`);
  console.log(`registered agencies: ${Object.keys(AGENCIES).join(', ')}`);
  if (!isValidCode('A001')) console.warn('agency master is empty');
});
