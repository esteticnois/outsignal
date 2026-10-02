// Браузерные тесты глоссария: node tests/glossary.test.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let failed = 0;
async function test(name, fn) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await fn(page);
    assert.deepEqual(errors, [], 'ошибки JS на странице');
    console.log('✔', name);
  } catch (e) {
    failed++;
    console.log('✘', name, '\n  ', e.message);
  } finally {
    await page.close();
  }
}
const ready = (p) => p.waitForSelector('html.os-glossary-ready');
const termsIn = (p, sel) => p.$$eval(sel + ' .os-term', (els) => els.map((e) => e.textContent));

await test('размечает термины в тексте статьи, с lang="en"', async (p) => {
  await p.goto(base + '/demo/index.html'); await ready(p);
  const t = await termsIn(p, '.entry-content');
  for (const w of ['clarity', 'feedback', 'support', 'signal', 'noise', 'mindset', 'trust', 'deadline', 'burnout']) assert.ok(t.includes(w), 'нет термина ' + w);
  assert.equal(await p.getAttribute('.os-term[data-term="clarity"]', 'lang'), 'en');
});

await test('фраза побеждает отдельное слово (call to action, use case, pain point)', async (p) => {
  await p.goto(base + '/demo/index.html'); await ready(p);
  const t = await termsIn(p, '.entry-content');
  for (const w of ['call to action', 'value proposition', 'use case', 'pain point']) assert.ok(t.includes(w), 'нет фразы ' + w);
});

await test('не трогает code, кнопки, ссылки, заголовки, меню, бренд и чужие словоформы', async (p) => {
  await p.goto(base + '/demo/index.html'); await ready(p);
  assert.equal(await p.$$eval('code .os-term, button .os-term, a .os-term, h1 .os-term, nav .os-term', (e) => e.length), 0);
  const t = await termsIn(p, 'body');
  assert.ok(!t.includes('supportive'), 'supportive не должно размечаться');
  assert.ok(!t.includes('OutSignal'));
});

await test('при наведении показывает плашку с переводом и пояснением (uk)', async (p) => {
  await p.goto(base + '/demo/index.html'); await ready(p);
  await p.hover('.os-term[data-term="clarity"]');
  const tip = p.locator('#os-gloss-tip');
  await tip.waitFor({ state: 'visible' });
  assert.match(await tip.textContent(), /ясність/);
  assert.match(await tip.textContent(), /Чітке розуміння/);
  assert.equal(await p.getAttribute('.os-term[data-term="clarity"]', 'aria-describedby'), 'os-gloss-tip');
  const [tb, tt] = await Promise.all([tip.boundingBox(), p.locator('.os-term[data-term="clarity"]').boundingBox()]);
  assert.ok(tb.y + tb.height <= tt.y, 'плашка должна быть над словом');
  const bg = await p.$eval('.os-term[data-term="clarity"]', (e) => getComputedStyle(e).backgroundColor);
  assert.notEqual(bg, 'rgba(0, 0, 0, 0)', 'нет подсветки при наведении');
});

await test('плашка скрывается при уходе курсора и по Escape', async (p) => {
  await p.goto(base + '/demo/index.html'); await ready(p);
  await p.hover('.os-term[data-term="feedback"]');
  await p.locator('#os-gloss-tip').waitFor({ state: 'visible' });
  await p.mouse.move(5, 790);
  await p.locator('#os-gloss-tip').waitFor({ state: 'hidden' });
  await p.focus('.os-term[data-term="trust"]');
  await p.locator('#os-gloss-tip').waitFor({ state: 'visible' });
  await p.keyboard.press('Escape');
  await p.locator('#os-gloss-tip').waitFor({ state: 'hidden' });
});

await test('JSON-LD DefinedTermSet добавлен и содержит только найденные термины', async (p) => {
  await p.goto(base + '/demo/index.html'); await ready(p);
  const ld = JSON.parse(await p.textContent('script[data-os-glossary-ld]'));
  assert.equal(ld['@type'], 'DefinedTermSet');
  assert.equal(ld.inLanguage, 'uk');
  const names = ld.hasDefinedTerm.map((t) => t.name);
  assert.ok(names.includes('clarity') && names.includes('call to action'));
  assert.ok(!names.includes('onboarding'), 'onboarding нет в статье');
  assert.equal(ld.hasDefinedTerm.find((t) => t.name === 'clarity').alternateName, 'ясність');
});

await test('русская страница: язык подсказок ru и пояснение конкретной статьи', async (p) => {
  await p.goto(base + '/demo/ru.html'); await ready(p);
  await p.hover('.os-term[data-term="clarity"]');
  const text = await p.locator('#os-gloss-tip').textContent();
  assert.match(text, /ясность/);
  assert.match(text, /ясность ожиданий клиента/);
  await p.hover('.os-term[data-term="onboarding"]');
  assert.match(await p.locator('#os-gloss-tip').textContent(), /адаптация/);
});

await test('тап на мобильном открывает и закрывает плашку', async (p) => {
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 700 } });
  const m = await ctx.newPage();
  await m.goto(base + '/demo/index.html'); await ready(m);
  await m.tap('.os-term[data-term="support"]');
  await m.locator('#os-gloss-tip').waitFor({ state: 'visible' });
  const box = await m.locator('#os-gloss-tip').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375, 'плашка вылезает за экран');
  await m.tap('h1');
  await m.locator('#os-gloss-tip').waitFor({ state: 'hidden' });
  await ctx.close();
});

await test('внешний словарь для слов не из глоссария (подмена API)', async (p) => {
  await p.route('**/api.dictionaryapi.dev/**', (r) => r.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ word: 'supportive', phonetic: '/səˈpɔːrtɪv/', meanings: [{ partOfSpeech: 'adjective', definitions: [{ definition: 'Providing encouragement or emotional help.' }] }] }]),
  }));
  await p.addInitScript(() => { window.OutSignalGlossaryConfig = { external: true }; });
  await p.goto(base + '/demo/index.html'); await ready(p);
  assert.equal(await p.$$eval('.os-term--auto[data-term="outsignal"]', (e) => e.length), 0, 'бренд в ignore');
  await p.hover('.os-term--auto[data-term="supportive"]');
  await p.locator('#os-gloss-tip', { hasText: 'Providing encouragement' }).waitFor();
});

await test('скрипт статической вставки JSON-LD', async () => {
  const out = execFileSync('node', ['tools/inject-jsonld.mjs', 'glossary/glossary.json', 'demo/index.html', '--dry'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /index\.html: терминов 1\d/);
});

await browser.close();
server.close();
console.log(failed ? `\nПровалено: ${failed}` : '\nВсе тесты пройдены');
process.exit(failed ? 1 : 0);
