import { Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { useSession } from './data/context';
import { InvitationsPage } from './pages/InvitationsPage';
import { LoginPage, NoAccessPage, SplashPage } from './pages/LoginPage';
import { MemberPage } from './pages/MemberPage';
import { SettingsPage } from './pages/SettingsPage';
import { TeamPage } from './pages/TeamPage';
import { UsersPage } from './pages/UsersPage';

/** Gate: only an active admin (per `joinOrg`) reaches the routes. */
export function App() {
  const { state } = useSession();
  switch (state.status) {
    case 'loading':
      return <SplashPage label="Cargando…" />;
    case 'joining':
      return <SplashPage label="Verificando tu acceso…" />;
    case 'signedOut':
      return <LoginPage />;
    case 'noAccess':
      return <NoAccessPage />;
    case 'ready':
      return (
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<TeamPage />} />
            <Route path="colaborador/:uid" element={<MemberPage />} />
            <Route path="invitaciones" element={<InvitationsPage />} />
            <Route path="colaboradores" element={<UsersPage />} />
            <Route path="configuracion" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      );
  }
}
