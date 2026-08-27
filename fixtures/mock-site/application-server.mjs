#!/usr/bin/env node
/**
 * モックサイト: 申込ドメイン (既定 http://localhost:4174)。
 *
 * LP ドメイン (127.0.0.1:4173) とは別オリジンであり、LP 側の Cookie は共有されない。
 * 実サイトと同様、代理店情報は次のいずれかで引き継がれる。
 *   - URL クエリパラメータ (agency_code)
 *   - 一時トークン (handoff_token) — サーバー側でコードに復元する
 *   - フォームの hidden 項目 + POST 送信
 * 受け取った後は申込ドメイン自身のセッション Cookie で保持する。
 *
 * 申込完了 (/entry/complete) は用意してあるが、テストからは決して呼ばない。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { escapeHtml, getAgency, resolveHandoffToken } from './agency-master.mjs';

const PORT = Number(process.env.MOCK_APPLICATION_PORT || 4174);
/**
 * 既定では全インターフェースで待ち受ける (ローカル検証用のモックのため)。
 * 申込ドメインの URL はホスト名 (localhost) で指定されるため、
 * 環境によって localhost が ::1 (IPv6) に解決されることがある。
 * 127.0.0.1 だけに bind すると、その環境で接続できなくなる
 * (GitHub Actions の ubuntu-latest は /etc/hosts に ::1 localhost を持つ)。
 * ネットワークに公開したくない場合は MOCK_APPLICATION_HOST=127.0.0.1 を指定する。
 */
const HOST = process.env.MOCK_APPLICATION_HOST || undefined;

const PARAM_NAME = 'agency_code';
const SESSION_COOKIE = 'app_session';

/** サーバー側セッション (実サイトの Redis / DB セッションにあたる) */
const sessions = new Map();
/** セッション数の上限 (無制限に増やさない) */
const MAX_SESSIONS = 500;
/** リクエストボディの上限 (バイト) */
const MAX_BODY_BYTES = 64 * 1024;

/** 申込フローの画面定義 */
const STEPS = [
  { path: '/entry/', title: 'お申込み (1/3) ペット情報', next: '/entry/step2/', testId: 'entry-step1' },
  { path: '/entry/step2/', title: 'お申込み (2/3) プラン選択', next: '/entry/confirm/', testId: 'entry-step2' },
  { path: '/entry/confirm/', title: 'お申込み (3/3) 内容確認', next: null, testId: 'entry-confirm' },
];

function readCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split('; ').reduce((accumulator, part) => {
    const [name, ...rest] = part.split('=');
    accumulator[decodeURIComponent(name)] = decodeURIComponent(rest.join('='));
    return accumulator;
  }, {});
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 引き継がれた代理店コードを特定する。
 * 優先順位: POST ボディ > 一時トークン > クエリパラメータ > 既存セッション
 */
function resolveIncomingCode({ url, body, cookies }) {
  const fromBody = body ? new URLSearchParams(body).get(PARAM_NAME) : null;
  if (fromBody) return { code: fromBody, method: 'post' };

  const token = url.searchParams.get('handoff_token');
  if (token) {
    const restored = resolveHandoffToken(token);
    // トークンが復元できない場合もコードは付与しない (別代理店へ誤帰属させない)
    return { code: restored, method: 'token' };
  }

  const fromQuery = url.searchParams.get(PARAM_NAME);
  if (fromQuery) return { code: fromQuery, method: 'query' };

  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId && sessions.has(sessionId)) {
    return { code: sessions.get(sessionId).code, method: 'session' };
  }

  return { code: null, method: 'none' };
}

function renderPage({ step, agency, agencyCode, handoffMethod }) {
  const recognized = Boolean(agency);
  const stepIndex = STEPS.findIndex((entry) => entry.path === step.path) + 1;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(step.title)}｜申込サイト</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; line-height: 1.7; color: #222; }
  header { padding: 12px 16px; border-bottom: 1px solid #e3e6ea; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  .panel { border: 1px solid #e3e6ea; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .agency-panel { background: #f7fbf7; border-color: #cfe6cf; }
  .default-panel { background: #f6f8fa; }
  .btn { display: inline-block; padding: 12px 24px; background: #c8461f; color: #fff; border: 0;
         border-radius: 6px; text-decoration: none; font-weight: 700; cursor: pointer; }
  .form-row { margin-bottom: 12px; }
  label { display: block; font-weight: 700; }
  select { width: 100%; max-width: 360px; padding: 8px; }
  .meta { color: #5a6671; font-size: 12px; }
</style>
</head>
<body>
  <header data-testid="application-header">
    <strong>申込サイト (別ドメイン)</strong>
    <span class="meta">ステップ ${stepIndex} / ${STEPS.length}</span>
  </header>
  <main data-testid="${escapeHtml(step.testId)}">
    <h1>${escapeHtml(step.title)}</h1>

    ${
      recognized
        ? `<section class="panel agency-panel" data-testid="application-agency-info">
      <h2>担当代理店</h2>
      <p>代理店名：<span data-testid="application-agency-name">${escapeHtml(agency.name)}</span></p>
      <p>お問合せ先：<span data-testid="application-agency-phone">${escapeHtml(agency.phone)}</span></p>
    </section>`
        : `<section class="panel default-panel" data-testid="application-default-route">
      <h2>通常のお申込み</h2>
      <p>担当代理店の指定はありません。通常の手続きへ進みます。</p>
      <p>お問合せ窓口：0120-000-000</p>
    </section>`
    }

    <form class="panel" data-testid="application-form" method="post" action="${escapeHtml(step.next ?? '/entry/confirm/')}">
      <input type="hidden" name="${PARAM_NAME}" data-testid="application-agency-code" value="${escapeHtml(agencyCode ?? '')}">
      <div class="form-row">
        <label for="pet-type">ペットの種類</label>
        <select id="pet-type" name="pet_type" data-testid="input-pet-type">
          <option value="dog">犬</option>
          <option value="cat">猫</option>
        </select>
      </div>
      <p class="meta">この画面はテスト用です。個人情報は入力しないでください。</p>
      ${
        step.next
          ? `<a class="btn" href="${escapeHtml(step.next)}" data-testid="application-next">次へ進む</a>`
          : `<button type="button" class="btn" data-testid="application-submit">申し込みを完了する</button>
             <p class="meta">※ 自動テストではこのボタンを押しません。</p>`
      }
    </form>

    <p class="meta" data-testid="application-handoff-method">handoff: ${escapeHtml(handoffMethod)}</p>
  </main>
  <script>
    // 申込ドメイン側でも代理店コードを保持する (サーバーから渡された値のみを使用)
    (function () {
      var code = ${JSON.stringify(agencyCode ?? '')};
      try {
        if (code) { window.localStorage.setItem('${PARAM_NAME}', code); }
        else { window.localStorage.removeItem('${PARAM_NAME}'); }
      } catch (e) { /* noop */ }
    })();
  </script>
</body>
</html>
`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>400 Bad Request</h1>');
    return;
  }
  const cookies = readCookies(req);
  const body = req.method === 'POST' ? await readBody(req) : '';

  // ---------- 申込完了 (テストからは呼ばれない) ----------
  if (pathname === '/entry/complete') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, completed: true }));
    return;
  }

  // ---------- 申込側が認識している代理店を返す API ----------
  if (pathname === '/api/session') {
    const sessionId = cookies[SESSION_COOKIE];
    const session = sessionId ? sessions.get(sessionId) : null;
    const agency = session ? getAgency(session.code) : null;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(
      JSON.stringify({
        [PARAM_NAME]: session?.code ?? null,
        agency_name: agency?.name ?? null,
        handoff_method: session?.method ?? 'none',
      }),
    );
    return;
  }

  // ---------- 申込フローの各画面 ----------
  const step = STEPS.find((entry) => entry.path === pathname || entry.path === `${pathname}/`);
  if (step) {
    const incoming = resolveIncomingCode({ url, body, cookies });
    const agency = getAgency(incoming.code);
    // 有効なコードのみセッションに保存する (無効コードは通常経路へフォールバック)
    let sessionId = cookies[SESSION_COOKIE];
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

    if (agency) {
      if (!sessionId || !sessions.has(sessionId)) {
        sessionId = randomUUID();
        headers['set-cookie'] = `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`;
      }
      // 古いセッションから削除して上限を保つ
      while (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      sessions.set(sessionId, { code: incoming.code, method: incoming.method });
    } else if (incoming.code) {
      // 無効なコードを受け取った場合はセッションを作らない
      if (sessionId && sessions.has(sessionId)) sessions.delete(sessionId);
    }

    const session = sessionId ? sessions.get(sessionId) : null;
    res.writeHead(200, headers);
    res.end(
      renderPage({
        step,
        agency,
        agencyCode: agency ? incoming.code : null,
        handoffMethod: session?.method ?? incoming.method,
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>404</title></head><body><h1>404 Not Found</h1></body></html>');
});

server.listen(PORT, HOST, () => {
  console.log(`mock application site listening on port ${PORT} (host: ${HOST ?? 'all interfaces'})`);
});
