/**
 * Landing de Mi Pega HR. Sin framework: la página es HTML estático y esto solo
 * agrega el movimiento (todo opcional; sin JS la página se ve completa):
 * - Aparición de secciones al hacer scroll (IntersectionObserver).
 * - Hero: el reloj del popup corre y las notificaciones se turnan, con botón
 *   para pausar (la animación dura más de 5 s).
 * - Línea de tiempo del portal generada con datos de ejemplo fijos.
 * Con prefers-reduced-motion no se anima nada: queda una notificación fija.
 */
import './styles.css';

const root = document.documentElement;
root.classList.add('js');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ---------- Header border once the page scrolls ----------
const header = document.querySelector<HTMLElement>('.site-header');
if (header) {
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px';
  document.body.prepend(sentinel);
  new IntersectionObserver(([entry]) => {
    if (entry) header.toggleAttribute('data-scrolled', !entry.isIntersecting);
  }).observe(sentinel);
}

// ---------- Year in footer ----------
const year = document.querySelector('[data-year]');
if (year) year.textContent = String(new Date().getFullYear());

// ---------- Portal timeline (sample data, fixed so it never changes between visits) ----------
type Level = 'high' | 'mid' | 'low' | 'meeting' | 'lunch' | 'none';
const COLORS: Record<Exclude<Level, 'lunch'>, string> = {
  high: 'var(--lvl-high)',
  mid: 'var(--lvl-mid)',
  low: 'var(--lvl-low)',
  meeting: 'var(--lvl-meeting)',
  none: 'var(--lvl-none)',
};
const ROWS: Array<[string, string]> = [
  ['Camila R.', 'hhhhmmhhhhhmmhhhhmhLLLLLhhhhmmmhhhhhhmhhh'],
  ['Joaquín P.', 'nhhhhhhhmhhhhmmmmhhhLLLLLhhhhhhlhhhhhhmh'],
  ['Fernanda A.', 'hhhmmmmhhhhhhhmhhhhhLLLLLhhhhhhhhmmmhhhll'],
  ['Matías G.', 'hhhhhhlhhhhmhhhhhhhhLLLLLmmmmhhhhhhhhhh'],
  ['Valentina S.', 'hhmhhhhhhhhhhhhmhhhhLLLLLhhhhhmhhhhhhhhh'],
];
const CODE: Record<string, Level> = { h: 'high', m: 'meeting', l: 'low', L: 'lunch', n: 'none' };
const MID = new Set([3, 11, 17, 29, 34]);

const timeline = document.querySelector<HTMLElement>('[data-timeline]');
if (timeline) {
  const frag = document.createDocumentFragment();
  ROWS.forEach(([name, pattern], r) => {
    const row = document.createElement('div');
    row.className = 'pm-row';
    const label = document.createElement('span');
    label.className = 'pm-name';
    label.textContent = name;
    const blocks = document.createElement('span');
    blocks.className = 'pm-blocks';
    blocks.style.setProperty('--n', String(pattern.length));
    [...pattern].forEach((ch, d) => {
      let level = CODE[ch] ?? 'none';
      if (level === 'high' && MID.has((d + r * 7) % 40)) level = 'mid';
      const i = document.createElement('i');
      if (level === 'lunch') i.className = 'lunch';
      else i.style.setProperty('--c', COLORS[level]);
      i.style.setProperty('--d', String(d));
      i.style.setProperty('--r', String(r));
      blocks.append(i);
    });
    row.append(label, blocks);
    frag.append(row);
  });
  timeline.append(frag);
}

// ---------- Reveal on scroll ----------
const reveals = [...document.querySelectorAll<HTMLElement>('.reveal')];
// Stagger siblings that share a parent (feature cards, steps, list columns).
const groups = new Map<Element | null, number>();
for (const el of reveals) {
  const n = groups.get(el.parentElement) ?? 0;
  el.style.setProperty('--i', String(Math.min(n, 6)));
  groups.set(el.parentElement, n + 1);
}
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add('in'));
}

// ---------- Hero demo: ticking clock + rotating notifications ----------
const demo = document.querySelector<HTMLElement>('[data-demo]');
if (demo) {
  const clock = demo.querySelector<HTMLElement>('[data-clock]');
  const toasts = [...demo.querySelectorAll<HTMLElement>('[data-toast]')];
  const toggle = demo.querySelector<HTMLButtonElement>('[data-motion-toggle]');
  const toggleLabel = toggle?.querySelector('span');
  const toggleIcon = toggle?.querySelector('use');

  let seconds = 4 * 3600 + 12 * 60;
  let current = -1;
  let paused = false;
  let visible = true;
  let clockTimer: number | undefined;
  let toastTimer: number | undefined;

  const pad = (n: number) => String(n).padStart(2, '0');
  const renderClock = () => {
    if (!clock) return;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    clock.textContent = `${h}:${pad(m)}:${pad(seconds % 60)}`;
  };

  const show = (index: number) => {
    const prev = toasts[current];
    if (prev && current !== index) {
      prev.removeAttribute('data-on');
      prev.setAttribute('data-off', '');
      window.setTimeout(() => prev.removeAttribute('data-off'), 400);
    }
    current = index;
    const next = toasts[index];
    if (next) {
      next.removeAttribute('data-off');
      // Restart the confetti animation on each appearance.
      next.removeAttribute('data-on');
      void next.offsetWidth;
      next.setAttribute('data-on', '');
    }
  };

  const stop = () => {
    window.clearInterval(clockTimer);
    window.clearInterval(toastTimer);
    clockTimer = toastTimer = undefined;
  };
  const start = () => {
    stop();
    if (paused || !visible || reducedMotion.matches) return;
    clockTimer = window.setInterval(() => {
      seconds += 1;
      renderClock();
    }, 1000);
    toastTimer = window.setInterval(() => show((current + 1) % toasts.length), 3800);
  };

  const applyMotionPreference = () => {
    if (reducedMotion.matches) {
      stop();
      if (toggle) toggle.hidden = true;
      if (current < 0) show(0);
    } else {
      if (toggle) toggle.hidden = false;
      window.setTimeout(() => {
        if (current < 0) show(0);
      }, 900);
      start();
    }
  };

  toggle?.addEventListener('click', () => {
    paused = !paused;
    demo.toggleAttribute('data-paused', paused);
    toggle.setAttribute('aria-pressed', String(paused));
    if (toggleLabel) toggleLabel.textContent = paused ? 'Reanudar animación' : 'Pausar animación';
    toggleIcon?.setAttribute('href', paused ? '#i-play' : '#i-pause');
    if (paused) stop();
    else start();
  });

  // Don't run timers while the hero is off screen or the tab is hidden.
  new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting && !document.hidden;
    if (visible) start();
    else stop();
  }).observe(demo);
  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    if (visible) start();
    else stop();
  });
  reducedMotion.addEventListener('change', applyMotionPreference);

  renderClock();
  applyMotionPreference();
}
