import { NavLink } from 'react-router';

/** Colaboradores: the people and their invitations, two tabs of one menu entry. */
export function PeopleTabs() {
  return (
    <nav className="tabs" aria-label="Colaboradores">
      <NavLink to="/colaboradores" end className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Personas
      </NavLink>
      <NavLink to="/colaboradores/invitaciones" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Invitaciones
      </NavLink>
    </nav>
  );
}
