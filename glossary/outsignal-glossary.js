/*!
 * OutSignal Glossary — hover-подсказки для английских терминов в статьях.
 *
 * Как работает:
 *  1. Загружает словарь (glossary.json) — свой, курируемый, с переводом и
 *     кратким пояснением контекста на языке страницы (uk / ru).
 *  2. Находит в тексте статьи английские слова и фразы из словаря и
 *     оборачивает их в <span class="os-term" lang="en">. Исходный HTML
 *     статьи в CMS не меняется — разметка добавляется только в браузере.
 *  3. При наведении / фокусе / тапе показывает одну общую плашку-подсказку.
 *  4. Добавляет в <head> JSON-LD schema.org DefinedTermSet с терминами,
 *     найденными на странице, — чтобы поисковики понимали определения.
 *  5. (опционально) Для английских слов, которых нет в словаре, берёт
 *     определение из внешнего API (по умолчанию Free Dictionary API).
 *
 * Без зависимостей. Подключение:
 *  <link rel="stylesheet" href="/glossary/outsignal-glossary.css">
 *  <script src="/glossary/outsignal-glossary.js" data-src="/glossary/glossary.json" defer></script>
 */
(function (window, document) {
  'use strict';

  var DEFAULTS = {
    // URL словаря. Можно вместо этого задать window.OutSignalGlossaryData = {...}
    src: '/glossary/glossary.json',
    // Где искать термины: только тело статьи, не меню / шапку / футер.
    scope: 'article .entry-content, article .post-content, .entry-content, .post-content, .article-body, article',
    // Где НЕ размечать: ссылки, кнопки, код, заголовки, формы и т.п.
    skip: 'a, button, code, pre, kbd, samp, var, script, style, noscript, template, textarea, input, select, option, label, svg, math, h1, h2, h3, h4, h5, h6, nav, header, footer, figcaption, [contenteditable], [role="button"], [data-no-glossary], .os-term, .os-gloss-tip',
    // Язык подсказок. null = из <html lang>.
    lang: null,
    fallbackLangs: ['uk', 'ru'],
    // true = размечать только первое вхождение каждого термина в статье.
    firstOnly: false,
    // Вставлять JSON-LD DefinedTermSet (если на странице его ещё нет).
    jsonLd: true,
    // Внешний словарь для слов, которых нет в glossary.json. Выключен по умолчанию.
    external: false,
    externalUrl: 'https://api.dictionaryapi.dev/api/v2/entries/en/',
    // Своя функция поиска: function (word) -> Promise<{t, d, pos, ipa, source}|null>
    lookup: null,
    minWordLength: 3,
    ignore: [],
    hideDelay: 150
  };

  var POS = {
    uk: { noun: 'ім.', verb: 'дієсл.', adj: 'прикм.', adjective: 'прикм.', adv: 'присл.', adverb: 'присл.', phrase: 'вираз' },
    ru: { noun: 'сущ.', verb: 'гл.', adj: 'прил.', adjective: 'прил.', adv: 'нар.', adverb: 'нар.', phrase: 'выражение' },
    en: { noun: 'n.', verb: 'v.', adj: 'adj.', adjective: 'adj.', adv: 'adv.', adverb: 'adv.', phrase: 'phrase' }
  };

  var UI = {
    uk: { loading: 'Шукаю визначення…', notFound: 'Визначення не знайдено', en: 'англ. визначення', set: 'Англійські терміни у статті' },
    ru: { loading: 'Ищу определение…', notFound: 'Определение не найдено', en: 'англ. определение', set: 'Английские термины в статье' },
    en: { loading: 'Looking up…', notFound: 'No definition found', en: 'definition', set: 'English terms in this article' }
  };

  // Латиница (включая диакритику) — граница слова определяется по ней,
  // поэтому «support» внутри кириллического предложения находится корректно.
  var WORD_CHAR = 'A-Za-z0-9\\u00C0-\\u024F_';

  var cfg, lang, byKey = {}, byId = {}, termRe = null, autoRe = null, ignoreSet = {};
  var tip, tipBody, activeEl = null, hideTimer = null, pinned = false, extCache = {}, bound = false;

  function extend(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i] || {};
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) target[k] = src[k];
    }
    return target;
  }

  function readScriptConfig() {
    var el = document.currentScript || document.querySelector('script[src*="outsignal-glossary"]');
    if (!el) return {};
    var d = el.dataset, out = {};
    if (d.src) out.src = d.src;
    if (d.scope) out.scope = d.scope;
    if (d.lang) out.lang = d.lang;
    if (d.firstOnly) out.firstOnly = d.firstOnly === 'true';
    if (d.jsonLd) out.jsonLd = d.jsonLd !== 'false';
    if (d.external) out.external = d.external === 'true';
    if (d.externalUrl) out.externalUrl = d.externalUrl;
    return out;
  }

  var scriptCfg = readScriptConfig();

  function norm(s) {
    return String(s).toLowerCase().replace(/[\s ]+/g, ' ').replace(/[‐‑‒–]/g, '-').replace(/’/g, "'").trim();
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function formPattern(form) {
    return escapeRe(norm(form)).replace(/ /g, '[\\s\\u00A0]+').replace(/-/g, '[-\\u2010\\u2011]').replace(/'/g, "['\\u2019]");
  }

  function pickLang(entry) {
    if (entry[lang]) return entry[lang];
    for (var i = 0; i < cfg.fallbackLangs.length; i++) if (entry[cfg.fallbackLangs[i]]) return entry[cfg.fallbackLangs[i]];
    return null;
  }

  function buildIndex(data) {
    var terms = (data && data.terms) || [];
    var forms = [];
    terms.forEach(function (t) {
      if (!t || !t.term) return;
      var id = t.id || norm(t.term).replace(/[^a-z0-9]+/g, '-');
      t.id = id;
      byId[id] = t;
      var list = [t.term].concat(t.forms || []);
      list.forEach(function (f) {
        var k = norm(f);
        if (!k || byKey[k]) return;
        byKey[k] = t;
        forms.push(k);
      });
    });
    (data && data.ignore || []).concat(cfg.ignore || []).forEach(function (w) { ignoreSet[norm(w)] = true; });
    // Длинные фразы первыми: «call to action» должно победить «action».
    forms.sort(function (a, b) { return b.length - a.length; });
    if (forms.length) {
      termRe = new RegExp('(^|[^' + WORD_CHAR + '])(' + forms.map(formPattern).join('|') + ')(?![' + WORD_CHAR + '])', 'gi');
    }
    if (cfg.external || cfg.lookup) {
      autoRe = new RegExp('(^|[^' + WORD_CHAR + '])([A-Za-z][A-Za-z\'\\u2019-]*[A-Za-z])(?![' + WORD_CHAR + '])', 'g');
    }
  }

  /* ---------- Разметка текста ---------- */

  function makeSpan(text, id, auto) {
    var s = document.createElement('span');
    s.className = auto ? 'os-term os-term--auto' : 'os-term';
    s.setAttribute('lang', 'en');
    s.setAttribute('tabindex', '0');
    s.setAttribute('data-term', id);
    s.textContent = text;
    return s;
  }

  // Делит строку на фрагменты: строки и {text, id, auto}.
  function tokenize(text, seen) {
    var out = [], last = 0, m;
    if (termRe) {
      termRe.lastIndex = 0;
      while ((m = termRe.exec(text))) {
        var start = m.index + m[1].length, word = m[2], entry = byKey[norm(word)];
        if (!entry) continue;
        if (cfg.firstOnly && seen[entry.id]) continue;
        seen[entry.id] = true;
        if (start > last) out = out.concat(tokenizeAuto(text.slice(last, start), seen));
        out.push({ text: word, id: entry.id, auto: false });
        last = start + word.length;
      }
    }
    if (last < text.length) out = out.concat(tokenizeAuto(text.slice(last), seen));
    return out;
  }

  function tokenizeAuto(text, seen) {
    if (!autoRe) return [text];
    var out = [], last = 0, m;
    autoRe.lastIndex = 0;
    while ((m = autoRe.exec(text))) {
      var start = m.index + m[1].length, word = m[2], key = norm(word);
      if (word.length < cfg.minWordLength || ignoreSet[key] || /^[A-Z0-9-]+$/.test(word)) continue;
      if (cfg.firstOnly && seen['auto:' + key]) continue;
      seen['auto:' + key] = true;
      if (start > last) out.push(text.slice(last, start));
      out.push({ text: word, id: key, auto: true });
      last = start + word.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function scan(root) {
    if (!root || (!termRe && !autoRe)) return [];
    var found = {}, seen = {}, nodes = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!/[A-Za-z]/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p || p.closest(cfg.skip)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach(function (node) {
      var parts = tokenize(node.nodeValue, seen);
      if (parts.length === 1 && typeof parts[0] === 'string') return;
      var frag = document.createDocumentFragment();
      parts.forEach(function (p) {
        if (typeof p === 'string') { if (p) frag.appendChild(document.createTextNode(p)); return; }
        frag.appendChild(makeSpan(p.text, p.id, p.auto));
        if (!p.auto) found[p.id] = true;
      });
      node.parentNode.replaceChild(frag, node);
    });
    return Object.keys(found);
  }

  function scopes() {
    var all = Array.prototype.slice.call(document.querySelectorAll(cfg.scope));
    // Убираем вложенные: если .entry-content внутри article — берём один корень.
    return all.filter(function (el) {
      return !all.some(function (o) { return o !== el && o.contains(el); });
    });
  }

  /* ---------- JSON-LD для поисковиков ---------- */

  function injectJsonLd(ids) {
    if (!cfg.jsonLd || !ids.length || document.querySelector('script[data-os-glossary-ld]')) return;
    var pageUrl = location.origin + location.pathname;
    var setId = pageUrl + '#glossary';
    var ui = UI[lang] || UI.uk;
    var terms = ids.map(function (id) {
      var e = byId[id], l = pickLang(e) || {};
      var dt = { '@type': 'DefinedTerm', '@id': pageUrl + '#term-' + id, name: e.term, inLanguage: 'en', inDefinedTermSet: setId };
      if (l.t) dt.alternateName = l.t;
      if (l.t || l.d) dt.description = [l.t, l.d].filter(Boolean).join(' — ');
      return dt;
    });
    var ld = { '@context': 'https://schema.org', '@type': 'DefinedTermSet', '@id': setId, name: ui.set, inLanguage: lang, hasDefinedTerm: terms };
    var s = document.createElement('script');
    s.type = 'application/ld+json';
    s.setAttribute('data-os-glossary-ld', 'runtime');
    s.textContent = JSON.stringify(ld);
    document.head.appendChild(s);
  }

  /* ---------- Плашка-подсказка ---------- */

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ensureTip() {
    if (tip) return;
    tip = el('div', 'os-gloss-tip');
    tip.id = 'os-gloss-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    tipBody = el('div', 'os-gloss-tip__body');
    tip.appendChild(tipBody);
    tip.appendChild(el('span', 'os-gloss-tip__arrow'));
    tip.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    tip.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(tip);
  }

  function render(data, word) {
    var ui = UI[lang] || UI.uk, pos = POS[lang] || POS.uk;
    tipBody.textContent = '';
    var head = el('div', 'os-gloss-tip__head');
    var icon = el('span', 'os-gloss-tip__icon', 'i');
    icon.setAttribute('aria-hidden', 'true');
    head.appendChild(icon);
    var term = el('span', 'os-gloss-tip__term', data.term || word);
    term.setAttribute('lang', 'en');
    head.appendChild(term);
    if (data.ipa) head.appendChild(el('span', 'os-gloss-tip__ipa', '/' + data.ipa.replace(/^\/|\/$/g, '') + '/'));
    if (data.pos) head.appendChild(el('span', 'os-gloss-tip__pos', pos[data.pos] || data.pos));
    tipBody.appendChild(head);

    if (data.loading) { tipBody.appendChild(el('div', 'os-gloss-tip__note', ui.loading)); return; }
    if (data.missing) { tipBody.appendChild(el('div', 'os-gloss-tip__note', ui.notFound)); return; }
    if (data.t) tipBody.appendChild(el('div', 'os-gloss-tip__tr', data.t));
    if (data.d) {
      var d = el('div', 'os-gloss-tip__note', data.d);
      if (data.source) d.setAttribute('lang', 'en');
      tipBody.appendChild(d);
    }
    if (data.source) tipBody.appendChild(el('div', 'os-gloss-tip__src', ui.en + ' · ' + data.source));
  }

  function position(target) {
    var r = target.getBoundingClientRect();
    // Для термина, перенесённого на две строки, берём первую строку.
    var rects = target.getClientRects();
    if (rects.length > 1) r = rects[0];
    tip.style.left = '0px';
    tip.style.top = '0px';
    var tw = tip.offsetWidth, th = tip.offsetHeight, vw = document.documentElement.clientWidth, gap = 10, pad = 8;
    var below = r.top < th + gap + pad;
    var left = r.left + r.width / 2 - tw / 2;
    left = Math.max(pad, Math.min(left, vw - tw - pad));
    var top = below ? r.bottom + gap : r.top - th - gap;
    tip.style.left = Math.round(left + window.pageXOffset) + 'px';
    tip.style.top = Math.round(top + window.pageYOffset) + 'px';
    tip.classList.toggle('os-gloss-tip--below', below);
    var arrowX = Math.max(14, Math.min(r.left + r.width / 2 - left, tw - 14));
    tip.style.setProperty('--os-arrow-x', Math.round(arrowX) + 'px');
  }

  function dataFor(target) {
    var id = target.getAttribute('data-term');
    if (!target.classList.contains('os-term--auto')) {
      var e = byId[id];
      if (!e) return null;
      var l = pickLang(e) || {};
      return { term: e.term, ipa: e.ipa, pos: e.pos, t: l.t, d: l.d };
    }
    return extCache[id] || { term: target.textContent, loading: true };
  }

  function show(target) {
    ensureTip();
    clearTimeout(hideTimer);
    if (activeEl && activeEl !== target) deactivate();
    var data = dataFor(target);
    if (!data) return;
    activeEl = target;
    target.classList.add('os-term--active');
    target.setAttribute('aria-describedby', 'os-gloss-tip');
    render(data, target.textContent);
    tip.hidden = false;
    position(target);
    tip.classList.add('os-gloss-tip--visible');
    if (data.loading) fetchExternal(target.getAttribute('data-term'), target);
  }

  function deactivate() {
    if (!activeEl) return;
    activeEl.classList.remove('os-term--active');
    activeEl.removeAttribute('aria-describedby');
    activeEl = null;
  }

  function hide() {
    clearTimeout(hideTimer);
    pinned = false;
    deactivate();
    if (tip) { tip.classList.remove('os-gloss-tip--visible'); tip.hidden = true; }
  }

  function scheduleHide() {
    if (pinned) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, cfg.hideDelay);
  }

  /* ---------- Внешний словарь (опционально) ---------- */

  function cacheGet(k) { try { var v = sessionStorage.getItem('osg:' + k); return v && JSON.parse(v); } catch (e) { return null; } }
  function cacheSet(k, v) { try { sessionStorage.setItem('osg:' + k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } }

  function defaultLookup(word) {
    return fetch(cfg.externalUrl + encodeURIComponent(word)).then(function (r) {
      if (!r.ok) return null;
      return r.json().then(function (json) {
        var e = json && json[0];
        var m = e && e.meanings && e.meanings[0];
        var def = m && m.definitions && m.definitions[0];
        if (!def) return null;
        var ipa = e.phonetic || (e.phonetics || []).map(function (p) { return p.text; }).filter(Boolean)[0];
        return { term: e.word, ipa: ipa, pos: m.partOfSpeech, d: def.definition, source: 'Free Dictionary' };
      });
    });
  }

  function fetchExternal(key, target) {
    var cached = cacheGet(key);
    var p = cached ? Promise.resolve(cached) : (cfg.lookup || defaultLookup)(key);
    Promise.resolve(p).catch(function () { return null; }).then(function (res) {
      var data = res ? extend({ term: target.textContent }, res) : { term: target.textContent, missing: true };
      extCache[key] = data;
      if (res && !cached) cacheSet(key, res);
      if (activeEl === target) { render(data, target.textContent); position(target); }
    });
  }

  /* ---------- События ---------- */

  function termFrom(e) {
    return e.target && e.target.closest ? e.target.closest('.os-term') : null;
  }

  function bind() {
    if (bound) return;
    bound = true;
    var lastPointer = 'mouse';
    document.addEventListener('pointerdown', function (e) { lastPointer = e.pointerType || 'mouse'; }, true);

    document.addEventListener('mouseover', function (e) {
      if (lastPointer === 'touch') return;
      var t = termFrom(e);
      if (t) show(t);
    });
    document.addEventListener('mouseout', function (e) {
      var t = termFrom(e);
      if (t && !t.contains(e.relatedTarget)) scheduleHide();
    });
    document.addEventListener('focusin', function (e) {
      var t = termFrom(e);
      if (t) show(t);
    });
    document.addEventListener('focusout', function (e) {
      if (termFrom(e)) scheduleHide();
    });
    // Тап на мобильных: показать / скрыть; тап мимо — скрыть.
    document.addEventListener('click', function (e) {
      var t = termFrom(e);
      if (t) {
        if (activeEl === t && pinned) { hide(); return; }
        show(t);
        pinned = lastPointer === 'touch';
        return;
      }
      if (tip && !tip.contains(e.target)) hide();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && activeEl) hide();
    });
    window.addEventListener('resize', function () { if (activeEl) position(activeEl); });
    window.addEventListener('scroll', function () { if (activeEl) position(activeEl); }, { passive: true });
  }

  /* ---------- Старт ---------- */

  function detectLang() {
    var l = (cfg.lang || document.documentElement.getAttribute('lang') || cfg.fallbackLangs[0] || 'uk').toLowerCase().slice(0, 2);
    return l === 'ua' ? 'uk' : l;
  }

  function loadData() {
    if (window.OutSignalGlossaryData) return Promise.resolve(window.OutSignalGlossaryData);
    return fetch(cfg.src, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // Термины / пояснения конкретной статьи поверх общего словаря:
  // <script type="application/json" data-os-glossary>{"terms":[...]}</script>
  function mergePageTerms(data) {
    var nodes = document.querySelectorAll('script[type="application/json"][data-os-glossary]');
    if (!nodes.length) return data;
    var map = {};
    (data.terms || []).forEach(function (t) { map[t.id || norm(t.term)] = t; });
    Array.prototype.forEach.call(nodes, function (n) {
      try {
        (JSON.parse(n.textContent).terms || []).forEach(function (t) {
          var id = t.id || norm(t.term);
          map[id] = map[id] ? extend({}, map[id], t) : t;
        });
      } catch (e) { console.warn('[OutSignal Glossary] page terms JSON error', e); }
    });
    return extend({}, data, { terms: Object.keys(map).map(function (k) { return map[k]; }) });
  }

  function init(options) {
    cfg = extend({}, DEFAULTS, scriptCfg, window.OutSignalGlossaryConfig, options);
    lang = detectLang();
    return loadData().then(function (data) {
      buildIndex(mergePageTerms(data || {}));
      var ids = {};
      scopes().forEach(function (root) { scan(root).forEach(function (id) { ids[id] = true; }); });
      injectJsonLd(Object.keys(ids));
      bind();
      document.documentElement.classList.add('os-glossary-ready');
      return Object.keys(ids);
    }).catch(function (err) {
      console.warn('[OutSignal Glossary] не удалось загрузить словарь:', err);
      return [];
    });
  }

  window.OutSignalGlossary = {
    init: init,
    // Разметить динамически подгруженный блок: OutSignalGlossary.scan(el)
    scan: function (root) { return scan(root); },
    hide: hide
  };

  if (window.OutSignalGlossaryConfig && window.OutSignalGlossaryConfig.manual) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(); });
  else init();
})(window, document);
