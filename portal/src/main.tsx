import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { createFirebaseBackend } from './data/firebase';
import type { Backend } from './data/types';
import { applyTheme, readTheme } from './lib/theme';
import { Root } from './Root';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import './styles.css';

applyTheme(readTheme());

/** One Firebase backend per page, created on first use (not for public pages). */
let backend: Backend | null = null;
const getBackend = (): Backend => (backend ??= createFirebaseBackend());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Root getBackend={getBackend} />
    </BrowserRouter>
  </StrictMode>,
);
