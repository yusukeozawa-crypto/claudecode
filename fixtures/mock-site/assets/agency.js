/**
 * モックサイトの代理店コード処理。
 * 実サイトの想定挙動:
 *   1. URL パラメータ agency_code を受け取ったら Cookie と localStorage に保存する
 *   2. 保存済みのコードはページ遷移後も引き継ぐ
 *   3. 有効コードなら代理店セクションを表示し、既定セクションを隠す
 *   4. 無効コードなら保存せずフォールバック表示を出す
 *   5. 申込画面へは URL パラメータと hidden 項目で引き継ぐ
 */
(function () {
  'use strict';

  var PARAM = 'agency_code';
  var STORAGE_KEY = 'agency_code';

  // 代理店マスタ (実サイトでは API 等から取得する想定)
  var AGENCIES = {
    A001: { name: 'テスト保険代理店A', contact: '0120-000-001' },
    B002: { name: 'テスト保険代理店B', contact: '0120-000-002' },
  };

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split('; ') : [];
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i].split('=');
      if (decodeURIComponent(pair[0]) === name) return decodeURIComponent(pair.slice(1).join('='));
    }
    return null;
  }

  function writeCookie(name, value) {
    document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(value) + '; path=/; max-age=2592000; samesite=lax';
  }

  function readStored() {
    var fromCookie = readCookie(STORAGE_KEY);
    if (fromCookie) return fromCookie;
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function store(code) {
    writeCookie(STORAGE_KEY, code);
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
    } catch (e) {
      /* localStorage が使えない環境では Cookie のみ */
    }
  }

  function show(el, visible) {
    if (!el) return;
    el.classList.toggle('hidden', !visible);
  }

  function decorateLinks(code) {
    // サイト内リンクに代理店コードを引き継ぐ
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      if (!href || /^(https?:)?\/\//.test(href) || /^(mailto|tel|javascript):/.test(href) || href.charAt(0) === '#') continue;
      var url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) continue;
      if (code) {
        url.searchParams.set(PARAM, code);
      } else {
        url.searchParams.delete(PARAM);
      }
      links[i].setAttribute('href', url.pathname + url.search + url.hash);
    }
  }

  function render() {
    var params = new URLSearchParams(window.location.search);
    var fromUrl = params.get(PARAM);
    var stored = readStored();

    var activeCode = null;
    var invalidCode = null;

    if (fromUrl !== null && fromUrl !== '') {
      if (AGENCIES[fromUrl]) {
        // 有効コード: 保存して切り替える (別コードでの再流入も上書きされる)
        store(fromUrl);
        activeCode = fromUrl;
      } else {
        // 無効コード: 保存しない。保存済みコードがあってもフォールバックを表示する
        invalidCode = fromUrl;
      }
    } else if (stored && AGENCIES[stored]) {
      activeCode = stored;
    }

    var agency = activeCode ? AGENCIES[activeCode] : null;

    var defaultSection = document.querySelector('[data-testid="default-section"]');
    var agencySection = document.querySelector('[data-testid="agency-section"]');
    var fallbackNotice = document.querySelector('[data-testid="fallback-notice"]');
    var agencyOnly = document.querySelector('[data-testid="agency-only-content"]');

    show(defaultSection, !agency);
    show(agencySection, Boolean(agency));
    show(fallbackNotice, Boolean(invalidCode));
    if (agencyOnly) show(agencyOnly, Boolean(agency));

    if (agency) {
      var nameEl = document.querySelector('[data-testid="agency-name"]');
      var contactEl = document.querySelector('[data-testid="agency-contact"]');
      if (nameEl) nameEl.textContent = agency.name;
      if (contactEl) contactEl.textContent = agency.contact;
    }

    // 申込フォームの hidden 項目へ引き継ぐ
    var hiddenField = document.querySelector('[data-testid="application-agency-code"]');
    if (hiddenField) hiddenField.value = activeCode || '';

    decorateLinks(activeCode);

    // 表示中の日時 (視覚差分ではマスク対象になる動的要素)
    var clock = document.querySelector('[data-testid="current-datetime"]');
    if (clock) clock.textContent = new Date().toLocaleString('ja-JP');

    document.documentElement.setAttribute('data-agency-state', agency ? 'agency' : invalidCode ? 'invalid' : 'default');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
