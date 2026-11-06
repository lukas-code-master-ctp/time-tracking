/**
 * Generates public/og.png (1200×630, link previews in WhatsApp, Slack, LinkedIn…)
 * with Playwright from the landing's own fonts and logo: `npm run og -w landing`.
 * The PNG is committed; run this again only to change the design.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const pub = (p: string) => fileURLToPath(new URL(`../public/${p}`, import.meta.url));
const font = (p: string) => readFileSync(pub(`fonts/${p}`)).toString('base64');
const logo = readFileSync(pub('favicon.svg'), 'utf8');

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:B;src:url(data:font/woff2;base64,${font('bricolage-grotesque-latin.woff2')}) format('woff2');font-weight:200 800}
@font-face{font-family:J;src:url(data:font/woff2;base64,${font('plus-jakarta-sans-latin.woff2')}) format('woff2');font-weight:200 800}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#26336b;color:#fff;font-family:J;position:relative;overflow:hidden}
.glow{position:absolute;right:-160px;top:-200px;width:720px;height:720px;border-radius:50%;background:radial-gradient(closest-side,rgba(255,201,60,.25),transparent)}
.brand{position:absolute;left:88px;top:84px;display:flex;align-items:center;gap:18px;font:800 40px/1 B;letter-spacing:-.02em}
.brand svg{width:64px;height:64px}
h1{position:absolute;left:88px;top:205px;font:800 100px/0.98 B;letter-spacing:-.04em}
h1 span{display:inline-block;padding:0 14px 8px;margin-left:4px;background:#ffc93c;color:#26336b;border-radius:8px 22px 12px 24px;transform:rotate(-2deg)}
p{position:absolute;left:88px;bottom:84px;font-size:30px;color:rgba(255,255,255,.82)}
.big{position:absolute;right:96px;top:150px;width:300px;height:300px;filter:drop-shadow(0 30px 40px rgba(0,0,0,.35))}
</style><div class="glow"></div>
<div class="brand">${logo.replace('<svg ', '<svg aria-hidden="true" ')}Mi Pega HR</div>
<h1>Tu compañero<br>de <span>pega</span></h1>
<div class="big">${logo.replace('<svg ', '<svg width="300" height="300" aria-hidden="true" ')}</div>
<p>Jornada, pausas activas, ausencias, comunicados y cumpleaños.</p>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: pub('og.png') });
await browser.close();
console.log('og.png listo');
