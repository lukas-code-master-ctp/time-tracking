/**
 * Fake, blurred "screenshots" for the demo data: simple HTML mock-ups of the
 * usual apps (mail, document, spreadsheet, call…) rendered by Chromium and
 * blurred like the extension does with `blurScreenshots` on.
 */
import type { Browser } from 'playwright';
import type { Task } from './seedData.ts';

export const SHOT_WIDTH = 1280;
export const SHOT_HEIGHT = 720;

const APPS: Record<Task, { bar: string; accent: string; title: string; body: 'list' | 'doc' | 'grid' | 'call' | 'calendar' | 'chat' | 'web' }> = {
  mail: { bar: '#f6f8fc', accent: '#c5221f', title: 'Recibidos', body: 'list' },
  docs: { bar: '#f9fbfd', accent: '#1a73e8', title: 'Informe de ventas', body: 'doc' },
  sheets: { bar: '#f9fbfd', accent: '#188038', title: 'Pipeline de clientes', body: 'grid' },
  drive: { bar: '#f8fafd', accent: '#fbbc04', title: 'Mi unidad', body: 'list' },
  calendar: { bar: '#ffffff', accent: '#1a73e8', title: 'Semana', body: 'calendar' },
  meet: { bar: '#202124', accent: '#8ab4f8', title: 'Reunión comercial', body: 'call' },
  slides: { bar: '#f9fbfd', accent: '#f29900', title: 'Presentación', body: 'doc' },
  chat: { bar: '#ffffff', accent: '#00897b', title: 'Equipo ventas', body: 'chat' },
  whatsapp: { bar: '#f0f2f5', accent: '#25d366', title: 'WhatsApp', body: 'chat' },
  web: { bar: '#ffffff', accent: '#2e7d32', title: 'Parcelas en venta', body: 'web' },
  outside: { bar: '#ffffff', accent: '#5f6368', title: '', body: 'web' },
};

function lines(n: number, color: string, widthFrom = 40, widthTo = 95): string {
  let out = '';
  for (let i = 0; i < n; i++) {
    const w = widthFrom + ((i * 37) % (widthTo - widthFrom));
    out += `<div style="height:14px;margin:14px 0;width:${w}%;background:${color};border-radius:4px"></div>`;
  }
  return out;
}

function body(kind: (typeof APPS)[Task]['body'], accent: string): string {
  switch (kind) {
    case 'list':
      return Array.from({ length: 11 }, (_, i) =>
        `<div style="display:flex;gap:16px;align-items:center;padding:12px 20px;border-bottom:1px solid #e5e7eb;background:${i < 3 ? '#fff' : '#f8f9fa'}">` +
          `<div style="width:28px;height:28px;border-radius:50%;background:${i % 3 ? '#9aa0a6' : accent}"></div>` +
          `<div style="width:180px;height:12px;background:#3c4043;border-radius:3px"></div>` +
          `<div style="flex:1;height:12px;background:#9aa0a6;border-radius:3px"></div></div>`,
      ).join('');
    case 'doc':
      return `<div style="margin:24px auto;width:720px;min-height:600px;background:#fff;box-shadow:0 1px 4px #0003;padding:56px 72px">
        <div style="height:26px;width:60%;background:${accent};border-radius:4px;margin-bottom:28px"></div>${lines(14, '#5f6368')}</div>`;
    case 'grid': {
      let cells = '';
      for (let r = 0; r < 18; r++) {
        for (let c = 0; c < 9; c++) {
          const fill = r === 0 ? accent : (r * c) % 5 === 0 ? '#e6f4ea' : '#fff';
          cells += `<div style="border:1px solid #dadce0;height:28px;background:${fill}"></div>`;
        }
      }
      return `<div style="display:grid;grid-template-columns:repeat(9,1fr);margin:12px">${cells}</div>`;
    }
    case 'call':
      return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:16px;background:#202124;height:600px">
        ${['#5f6368', '#3c4043', '#4a4d51', '#5b5e62'].map((c) => `<div style="background:${c};border-radius:12px;display:grid;place-items:center"><div style="width:90px;height:90px;border-radius:50%;background:${accent}"></div></div>`).join('')}</div>`;
    case 'calendar': {
      let cols = '';
      for (let d = 0; d < 5; d++) {
        cols += `<div style="border-left:1px solid #dadce0;position:relative">${[1, 3, 5].map((h) => `<div style="position:absolute;top:${h * 60 + d * 18}px;left:6px;right:6px;height:${50 + d * 8}px;background:${accent};border-radius:6px;opacity:.85"></div>`).join('')}</div>`;
      }
      return `<div style="display:grid;grid-template-columns:repeat(5,1fr);height:600px;margin:12px">${cols}</div>`;
    }
    case 'chat':
      return `<div style="padding:24px 80px">${Array.from({ length: 8 }, (_, i) =>
        `<div style="display:flex;justify-content:${i % 2 ? 'flex-end' : 'flex-start'};margin:12px 0"><div style="max-width:55%;padding:14px 18px;border-radius:14px;background:${i % 2 ? '#d9fdd3' : '#fff'};box-shadow:0 1px 2px #0002">${lines(2, '#667781', 50, 90)}</div></div>`,
      ).join('')}</div>`;
    case 'web':
      return `<div style="height:260px;background:linear-gradient(135deg,${accent},#a5d6a7)"></div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:24px">${[0, 1, 2].map(() => `<div style="background:#fff;border-radius:10px;box-shadow:0 1px 4px #0002;padding:16px"><div style="height:120px;background:#c8e6c9;border-radius:6px"></div>${lines(3, '#607d8b')}</div>`).join('')}</div>`;
  }
}

/** HTML of the mock-up (blurred with CSS, as the extension would upload it). */
export function mockScreenHtml(task: Task, blurPx = 13): string {
  const app = APPS[task];
  return `<!doctype html><html><body style="margin:0;background:#fff;font:14px system-ui;overflow:hidden">
    <div style="filter:blur(${blurPx}px);transform:scale(1.04);transform-origin:center;height:${SHOT_HEIGHT}px">
      <div style="height:64px;background:${app.bar};display:flex;align-items:center;gap:18px;padding:0 20px;border-bottom:1px solid #dadce0">
        <div style="width:40px;height:40px;border-radius:8px;background:${app.accent}"></div>
        <div style="font-size:20px;color:${task === 'meet' ? '#e8eaed' : '#202124'}">${app.title}</div>
        <div style="flex:1;max-width:520px;height:40px;border-radius:20px;background:${task === 'meet' ? '#3c4043' : '#e9eef6'}"></div>
      </div>
      ${body(app.body, app.accent)}
    </div></body></html>`;
}

/** Renders one blurred JPEG per task (cached per task). */
export async function renderMockScreens(browser: Browser, tasks: Iterable<Task>): Promise<Map<Task, Uint8Array<ArrayBuffer>>> {
  const page = await browser.newPage({ viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT } });
  const out = new Map<Task, Uint8Array<ArrayBuffer>>();
  try {
    for (const task of new Set(tasks)) {
      await page.setContent(mockScreenHtml(task));
      out.set(task, new Uint8Array(await page.screenshot({ type: 'jpeg', quality: 60 })));
    }
  } finally {
    await page.close();
  }
  return out;
}
