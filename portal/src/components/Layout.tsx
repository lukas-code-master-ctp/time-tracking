import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAdmin, useSession } from '../data/context';
import { THEME_LABEL, applyTheme, nextTheme, readTheme, type ThemeChoice } from '../lib/theme';
import { initials } from './TeamTable';

const NAV = [
  { to: '/', label: 'Equipo', end: true, icon: 'M3 20v-1a6 6 0 0 1 12 0v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 9v-1a5 5 0 0 0-3-4.6M15 3.2a4 4 0 0 1 0 7.6' },
  // People and their invitations: one page with two tabs (/colaboradores, /colaboradores/invitaciones).
  { to: '/colaboradores', label: 'Colaboradores', end: false, icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8v-1a7 7 0 0 1 14 0v1' },
  { to: '/pausa-activa', label: 'Pausa activa', end: false, icon: 'M3 12h4l3-8 4 16 3-8h4' },
  { to: '/comunicados', label: 'Comunicados', end: false, icon: 'M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1Zm14-2a4 4 0 0 1 0 6M7 14l1 5h3' },
  { to: '/minutas', label: 'Minutas', end: false, icon: 'M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1ZM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2M9 11h6M9 15h4' },
  { to: '/animo', label: 'Pulso de ánimo', end: false, icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01' },
  { to: '/comentarios', label: 'Comentarios', end: false, icon: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12ZM8 11h8M8 14.5h5' },
];

/** At the bottom of the sidebar, above the account. */
const NAV_BOTTOM = [
  { to: '/configuracion', label: 'Configuración', end: false, icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z' },
];

/** The icon shows the current theme; clicking cycles system → light → dark. */
const THEME_ICON: Record<ThemeChoice, string> = {
  system: 'M4 5h16v11H4zM9 20h6M12 16v4',
  light: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  dark: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
};

const SIGN_OUT_ICON = 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9';

function Icon({ d }: { d: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function NavList({ items }: { items: typeof NAV }) {
  return (
    <ul>
      {items.map((n) => (
        <li key={n.to}>
          <NavLink to={n.to} end={n.end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <Icon d={n.icon} />
            {n.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function Layout() {
  const { profile } = useAdmin();
  const { signOut } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const location = useLocation();

  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => applyTheme(theme), [theme]);

  return (
    <div className="shell">
      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Mi Pega HR
        </span>
        <button
          type="button"
          className="btn icon-btn"
          aria-expanded={menuOpen}
          aria-controls="menu"
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? 'Cerrar' : 'Menú'}
        </button>
      </header>
      <aside id="menu" className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="sidebar-inner">
          <span className="brand sidebar-brand">
            <span className="brand-mark" aria-hidden="true" />
            Mi Pega HR
            <span className="brand-sub">Portal de administración</span>
          </span>
          <nav aria-label="Principal">
            <NavList items={NAV} />
          </nav>
          <nav className="nav-bottom" aria-label="Ajustes">
            <NavList items={NAV_BOTTOM} />
          </nav>
          <div className="sidebar-footer">
            <span className="avatar" aria-hidden="true">
              {initials(profile.displayName || profile.email)}
            </span>
            <span className="person-text" title={profile.displayName ? `${profile.displayName}\n${profile.email}` : profile.email}>
              <span className="person-name">{profile.displayName || profile.email}</span>
              {profile.displayName && <span className="person-email">{profile.email}</span>}
            </span>
            <span className="footer-actions">
              <button
                type="button"
                className="footer-icon-btn"
                aria-label={`${THEME_LABEL[theme]}. Cambiar tema`}
                title={`${THEME_LABEL[theme]} (clic para cambiar)`}
                onClick={() => setTheme(nextTheme)}
              >
                <Icon d={THEME_ICON[theme]} />
              </button>
              <button
                type="button"
                className="footer-icon-btn"
                aria-label="Cerrar sesión"
                title="Cerrar sesión"
                onClick={() => void signOut()}
              >
                <Icon d={SIGN_OUT_ICON} />
              </button>
            </span>
          </div>
        </div>
      </aside>
      <main id="contenido" className="content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
