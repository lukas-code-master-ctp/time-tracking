import { Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { useSession } from './data/context';
import { ActiveBreaksPage } from './pages/ActiveBreaksPage';
import { AttendancePage } from './pages/AttendancePage';
import { AnnouncementsPage } from './pages/AnnouncementsPage';
import { CelebrationsPage } from './pages/CelebrationsPage';
import { GroupsPage } from './pages/GroupsPage';
import { InvitationsPage } from './pages/InvitationsPage';
import { LoginPage, NoAccessPage, SplashPage } from './pages/LoginPage';
import { MemberPage } from './pages/MemberPage';
import { FeedbackPage } from './pages/FeedbackPage';
import { MoodPage } from './pages/MoodPage';
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
            <Route path="colaboradores" element={<UsersPage />} />
            <Route path="colaboradores/invitaciones" element={<InvitationsPage />} />
            <Route path="colaboradores/grupos" element={<GroupsPage />} />
            <Route path="colaboradores/fechas" element={<CelebrationsPage />} />
            <Route path="colaboradores/marcaciones" element={<AttendancePage />} />
            <Route path="invitaciones" element={<Navigate to="/colaboradores/invitaciones" replace />} />
            <Route path="pausa-activa" element={<ActiveBreaksPage />} />
            <Route path="comunicados" element={<AnnouncementsPage />} />
            <Route path="animo" element={<MoodPage />} />
            <Route path="comentarios" element={<FeedbackPage />} />
            <Route path="configuracion" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      );
  }
}
