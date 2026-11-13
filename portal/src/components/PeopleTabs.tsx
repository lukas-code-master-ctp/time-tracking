import { NavLink } from 'react-router';

/** Colaboradores: the people, their invitations, their groups, their birthdays and their attendance marks, five tabs of one menu entry. */
export function PeopleTabs() {
  return (
    <nav className="tabs" aria-label="Colaboradores">
      <NavLink to="/colaboradores" end className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Personas
      </NavLink>
      <NavLink to="/colaboradores/invitaciones" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Invitaciones
      </NavLink>
      <NavLink to="/colaboradores/grupos" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Grupos
      </NavLink>
      <NavLink to="/colaboradores/fechas" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Cumpleaños y aniversarios
      </NavLink>
      <NavLink to="/colaboradores/marcaciones" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
        Marcaciones
      </NavLink>
    </nav>
  );
}
