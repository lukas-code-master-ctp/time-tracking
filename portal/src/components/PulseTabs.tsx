import { NavLink } from 'react-router';

/** Pulso y comentarios: the mood pulse and the anonymous comments, two tabs of one menu entry. */
export function PulseTabs() {
  return (
    <nav className="tabs" aria-label="Pulso y comentarios">
      <NavLink to="/animo" end className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Pulso de ánimo
      </NavLink>
      <NavLink to="/animo/comentarios" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Comentarios
      </NavLink>
    </nav>
  );
}
