import { useState } from 'react';
import { Route, Routes } from 'react-router';
import { App } from './App';
import { BackendProvider } from './data/context';
import type { Backend } from './data/types';
import { PRIVACY_PATH, PrivacyPage } from './pages/PrivacyPage';

/**
 * Top-level routes. Public pages (the privacy policy) render without a
 * session and without touching Firebase; everything else goes through the
 * admin gate ({@link App}). The backend is created lazily, only when the
 * admin area is first shown, so `/privacidad` works even without a Firebase
 * configuration.
 */
export function Root({ getBackend }: { getBackend: () => Backend }) {
  return (
    <Routes>
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
