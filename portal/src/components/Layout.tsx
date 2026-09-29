import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAdmin, useSession } from '../data/context';
import { THEME_LABEL, applyTheme, nextTheme, readTheme, type ThemeChoice } from '../lib/theme';
import { initials } from './TeamTable';

const NAV = [
  { to: '/', label: 'Equipo', end: true, icon: 'M3 20v-1a6 6 0 0 1 12 0v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 9v-1a5 5 0 0 0-3-4.6M15 3.2a4 4 0 0 1 0 7.6' },
  { to: '/invitaciones', label: 'Invitaciones', end: false, icon: 'M3 6h18v12H3zM3 7l9 6 9-6' },
  { to: '/colaboradores', label: 'Colaboradores', end: false, icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8v-1a7 7 0 0 1 14 0v1' },
  { to: '/configuracion', label: 'Configuración', end: false, icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z' },
];

function Icon({ d }: { d: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
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
          Registro de jornada
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
            Registro de jornada
            <span className="brand-sub">Portal de administración</span>
          </span>
          <nav aria-label="Principal">
            <ul>
              {NAV.map((n) => (
                <li key={n.to}>
                  <NavLink to={n.to} end={n.end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                    <Icon d={n.icon} />
                    {n.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="sidebar-footer">
            <div className="me">
              <span className="avatar" aria-hidden="true">
                {initials(profile.displayName || profile.email)}
              </span>
              <span className="person-text">
                <span className="person-name">{profile.displayName || profile.email}</span>
                <span className="person-email">{profile.email}</span>
              </span>
            </div>
            <button type="button" className="btn small-btn" onClick={() => setTheme(nextTheme)}>
              {THEME_LABEL[theme]}
            </button>
            <button type="button" className="btn small-btn" onClick={() => void signOut()}>
              Cerrar sesión
            </button>
          </div>
        </div>
      </aside>
      <main id="contenido" className="content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
