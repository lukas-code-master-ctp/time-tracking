import { useState } from 'react';
import { Route, Routes } from 'react-router';
import { App } from './App';
import { BackendProvider } from './data/context';
import type { Backend } from './data/types';
import { KIOSK_PATH } from './lib/attendance';
import type { Punch } from './lib/kioskClient';
import { DAILY_REPORT_FIELD_PATH } from '@timetracking/shared';
import { FieldArea } from './pages/FieldPage';
import { KioskPage } from './pages/KioskPage';
import { PRIVACY_PATH, PrivacyPage } from './pages/PrivacyPage';

/**
 * Top-level routes. Public pages (the privacy policy, the kiosk) render without a
 * session and without touching Firebase; everything else goes through the
 * admin gate ({@link App}). The backend is created lazily, only when the
 * admin area is first shown, so `/privacidad` works even without a Firebase
 * configuration.
 */
export function Root({ getBackend, getPunch }: { getBackend: () => Backend; getPunch?: () => Punch }) {
  return (
    <Routes>
      {/* Attendance kiosk (spec 2026-11-10-marcaciones): no admin session. */}
      {getPunch ? <Route path={KIOSK_PATH} element={<KioskPage getPunch={getPunch} />} /> : null}
      {/* Phone page of the people in the field (spec 2026-11-13-minuta-terreno): any active person. */}
      <Route path={DAILY_REPORT_FIELD_PATH} element={<FieldArea getBackend={getBackend} />} />
      <Route path={PRIVACY_PATH} element={<PrivacyPage />} />
      {/* The prerendered file itself (dist/privacidad.html), if opened directly. */}
      <Route path={`${PRIVACY_PATH}.html`} element={<PrivacyPage />} />
      <Route path="*" element={<AdminArea getBackend={getBackend} />} />
    </Routes>
  );
}

function AdminArea({ getBackend }: { getBackend: () => Backend }) {
  const [backend] = useState(getBackend);
  return (
    <BackendProvider backend={backend}>
      <App />
    </BackendProvider>
  );
}
