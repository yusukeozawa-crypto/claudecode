/**
 * モックサイト (LP ドメイン) の代理店コード処理。
 *
 * 代理店ごとの挙動 (表示セクション・代理店名・電話番号・バナー・CTA 文言・
 * 申込ドメインへの引き継ぎ方式) はサーバーが window.__AGENCY_CONTEXT__ に
 * 埋め込む。実サイトでのサーバーサイドレンダリングを模している。
 *
 * URL パラメータの値を HTML へそのまま出力しないこと (テキストは textContent 経由)。
 */
(function () {
  'use strict';

  var context = window.__AGENCY_CONTEXT__ || {};
  var STORAGE_KEY = context.storageKey || 'agency_code';

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split('; ') : [];
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i].split('=');
      if (decodeURIComponent(pair[0]) === name) return decodeURIComponent(pair.slice(1).join('='));
    }
    return null;
  }

  function writeCookie(name, value) {
    document.cookie =
      encodeURIComponent(name) + '=' + encodeURIComponent(value) + '; path=/; max-age=2592000; samesite=lax';
  }

  function store(code) {
    writeCookie(STORAGE_KEY, code);
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
      // 他社タグ (計測・A/B テスト) の模擬。
      // 本番では Zoho PageSense が訪問 URL を localStorage に書き込むため、
      // URL に代理店コードが入っていると「サイトがコードを保持している」
      // ように見える。これを自社の保存と分けて数えられることを検査するため、
      // モックでも同じ状況を作る (キーは他社タグのパターンに合わせる)。
      window.localStorage.setItem('zab_g_mockab', JSON.stringify({ url: location.href }));
    } catch (e) {
      /* localStorage が使えない環境では Cookie のみ */
    }
  }

  function show(element, visible) {
    if (!element) return;
    if (visible) {
      element.removeAttribute('hidden');
    } else {
      element.setAttribute('hidden', 'hidden');
    }
  }

  function bySection(name) {
    return document.querySelector('[data-testid="' + name + '"]');
  }

  function setText(testId, value) {
    var element = document.querySelector('[data-testid="' + testId + '"]');
    // textContent で設定するため、値が HTML として解釈されることはない
    if (element) element.textContent = value;
  }

  function setImage(testId, src, alt) {
    var element = document.querySelector('[data-testid="' + testId + '"]');
    if (!element) return;
    if (src) {
      element.setAttribute('src', src);
      element.setAttribute('alt', alt || '');
      element.removeAttribute('hidden');
    } else {
      element.setAttribute('hidden', 'hidden');
    }
  }

  /** サイト内リンクに代理店コードを引き継ぐ (同一オリジンのみ) */
  function decorateInternalLinks(code) {
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      if (!href || /^(mailto|tel|javascript):/i.test(href) || href.charAt(0) === '#') continue;
      var url;
      try {
        url = new URL(href, window.location.href);
      } catch (e) {
        continue;
      }
      // 外部ドメイン (申込ドメインを含む) のリンクはサーバーが生成した URL をそのまま使う
      if (url.origin !== window.location.origin) continue;
      if (code) {
        url.searchParams.set(context.paramName || 'agency_code', code);
      } else {
        url.searchParams.delete(context.paramName || 'agency_code');
      }
      links[i].setAttribute('href', url.pathname + url.search + url.hash);
    }
  }

  function render() {
    var activeCode = context.activeCode || null;
    var invalidCode = Boolean(context.invalidCode);
    var agency = context.agency || null;

    // 有効コードで流入した場合のみ保存する (無効コードは保存しない)
    if (activeCode && context.fromUrl) store(activeCode);

    // A/B テストのツール (Zoho PageSense 等) が置く値を模す。
    //   「検査したときサイトで何が動いていたか」の記録が本当に拾えるかを
    //   モックで確かめるために置く。表示には影響しない。
    try {
      window.localStorage.setItem('zps-ft-details', 'mock-variant-a');
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: 'experiment_view', experiment_id: 'mock-exp-1', variant: 'A' });
    } catch (error) {
      /* 保存できない環境では何もしない */
    }

    // 保存済みコードからの復元はサーバーが行うため、ここでは表示のみを担当する
    var visible = context.visibleSections || [];
    var hidden = context.hiddenSections || [];
    for (var i = 0; i < visible.length; i++) show(bySection(visible[i]), true);
    for (var j = 0; j < hidden.length; j++) show(bySection(hidden[j]), false);

    show(bySection('fallback-notice'), invalidCode);
    // 代理店コードが無い / 無効な場合は募集代理店の表記を出さない
    if (!agency) {
      show(bySection('footer-agency'), false);
      show(bySection('header-agency'), false);
      show(bySection('header-agency-sp'), false);
    }

    if (agency) {
      setText('agency-name', agency.name);
      // フッターの「募集代理店：<会社名>」
      setText('footer-agency-name', agency.name);
      show(bySection('footer-agency'), true);
      // ヘッダーの代理店名 (実サイトと同じく PC 用 / スマートフォン用の 2 要素)
      setText('header-agency-name', agency.name);
      show(bySection('header-agency'), true);
      setText('header-agency-sp-name', agency.name);
      show(bySection('header-agency-sp'), true);
      // みらやく × の代理店では「あんしんパック」の記載を一切出さない
      show(bySection('anshin-pack'), agency.mirayaku !== '×');
      setText('agency-phone', agency.phone);
      setText('agency-campaign-text', agency.campaign);
      setImage('agency-banner', agency.banner, agency.name + 'のご案内');
      setImage('agency-logo', agency.logo, agency.name);
    }

    // CTA (文言・遷移先・引き継ぎ方式はサーバーが決定する)
    var cta = document.querySelector('[data-testid="cta-primary"]');
    var ctaForm = document.querySelector('[data-testid="cta-form"]');
    var ctaHiddenField = document.querySelector('[data-testid="cta-agency-code"]');

    if (cta && context.cta) {
      if (context.cta.text) cta.textContent = context.cta.text;
      if (context.cta.handoffMethod === 'post') {
        // POST 送信方式: リンクではなくフォームを使用する
        show(cta, false);
        show(ctaForm, true);
        if (ctaForm) {
          ctaForm.setAttribute('action', context.cta.href);
          var submit = document.querySelector('[data-testid="cta-form-submit"]');
          if (submit && context.cta.text) submit.textContent = context.cta.text;
        }
        if (ctaHiddenField) ctaHiddenField.value = context.cta.agencyCode || '';
      } else {
        cta.setAttribute('href', context.cta.href);
        show(ctaForm, false);
      }
    }

    var clock = document.querySelector('[data-testid="current-datetime"]');
    if (clock) clock.textContent = new Date().toLocaleString('ja-JP');

    decorateInternalLinks(activeCode);

    document.documentElement.setAttribute(
      'data-agency-state',
      agency ? 'agency' : invalidCode ? 'invalid' : 'default',
    );
    // テストが描画完了を待てるようにする
    document.documentElement.setAttribute('data-agency-rendered', '1');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
