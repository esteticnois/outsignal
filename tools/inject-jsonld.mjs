#!/usr/bin/env node
/**
 * Статическая вставка JSON-LD (schema.org DefinedTermSet) в готовые HTML-файлы.
 *
 * Скрипт в браузере и так добавляет JSON-LD, но если сайт собирается
 * статически (или есть доступ к HTML на сервере), надёжнее положить разметку
 * прямо в исходник — тогда поисковик видит её без выполнения JavaScript.
 * Если блок уже есть, браузерный скрипт второй раз его не добавит.
 *
 * Использование:
 *   node tools/inject-jsonld.mjs glossary/glossary.json public/**\/*.html
 *   node tools/inject-jsonld.mjs glossary/glossary.json page.html --base https://outsignal.com --dry
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';

const args = process.argv.slice(2);
const flags = { dry: args.includes('--dry'), base: '' };
const bi = args.indexOf('--base');
if (bi !== -1) { flags.base = args[bi + 1].replace(/\/$/, ''); args.splice(bi, 2); }
const files = args.filter((a) => !a.startsWith('--'));
const glossaryPath = files.shift();
if (!glossaryPath || !files.length) {
  console.error('Использование: node tools/inject-jsonld.mjs <glossary.json> <file.html...> [--base https://site] [--dry]');
  process.exit(1);
}

const glossary = JSON.parse(readFileSync(glossaryPath, 'utf8'));
const SET_NAME = { uk: 'Англійські терміни у статті', ru: 'Английские термины в статье' };

const norm = (s) => String(s).toLowerCase().replace(/[\s\u00A0]+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const entries = (glossary.terms || []).map((t) => ({
  ...t,
  id: t.id || norm(t.term).replace(/[^a-z0-9]+/g, '-'),
  re: new RegExp(
    '(^|[^A-Za-z0-9\\u00C0-\\u024F_])(' +
      [t.term, ...(t.forms || [])].map((f) => esc(norm(f)).replace(/ /g, '[\\s\\u00A0]+')).join('|') +
      ')(?![A-Za-z0-9\\u00C0-\\u024F_])',
    'i'
  ),
}));

function articleText(html) {
  const m = html.match(/<article[\s\S]*?<\/article>/i);
  return (m ? m[0] : html)
    .replace(/<(script|style|code|pre|a|button|nav|header|footer|h[1-6])\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ');
}

export function buildJsonLd(html, pageUrl) {
  const lang = ((html.match(/<html[^>]*\blang=["']?([a-zA-Z-]+)/i) || [])[1] || 'uk').slice(0, 2).toLowerCase();
  const text = articleText(html);
  const setId = pageUrl + '#glossary';
  const found = entries.filter((e) => e.re.test(text));
  if (!found.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'DefinedTermSet',
    '@id': setId,
    name: SET_NAME[lang] || SET_NAME.uk,
    inLanguage: lang,
    hasDefinedTerm: found.map((e) => {
      const l = e[lang] || e.uk || e.ru || {};
      const dt = { '@type': 'DefinedTerm', '@id': pageUrl + '#term-' + e.id, name: e.term, inLanguage: 'en', inDefinedTermSet: setId };
      if (l.t) dt.alternateName = l.t;
      if (l.t || l.d) dt.description = [l.t, l.d].filter(Boolean).join(' — ');
      return dt;
    }),
  };
}

const BLOCK_RE = /\s*<script type="application\/ld\+json" data-os-glossary-ld[^>]*>[\s\S]*?<\/script>/i;
let changed = 0;
for (const file of files) {
  let html = readFileSync(file, 'utf8');
  const url = flags.base ? flags.base + '/' + relative(process.cwd(), file).replace(/\\/g, '/').replace(/index\.html$/, '') : '';
  const ld = buildJsonLd(html, url);
  html = html.replace(BLOCK_RE, '');
  if (ld) {
    const tag = `\n  <script type="application/ld+json" data-os-glossary-ld="static">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>\n`;
    html = html.replace(/\s*<\/head>/i, tag + '</head>');
  }
  console.log(`${ld ? '✔' : '–'} ${file}${ld ? ': терминов ' + ld.hasDefinedTerm.length : ': терминов нет'}`);
  if (!flags.dry) { writeFileSync(file, html); changed++; }
}
if (!flags.dry) console.log(`Обработано файлов: ${changed}`);
