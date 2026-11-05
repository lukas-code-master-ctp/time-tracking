import { NavLink } from 'react-router';

/** Colaboradores: the people, their invitations and their birthdays, three tabs of one menu entry. */
export function PeopleTabs() {
  return (
    <nav className="tabs" aria-label="Colaboradores">
      <NavLink to="/colaboradores" end className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Personas
      </NavLink>
      <NavLink to="/colaboradores/invitaciones" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Invitaciones
      </NavLink>
      <NavLink to="/colaboradores/fechas" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Cumpleaños
      </NavLink>
    </nav>
  );
}
