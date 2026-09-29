import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { createFirebaseBackend } from './data/firebase';
import { BackendProvider } from './data/context';
import { applyTheme, readTheme } from './lib/theme';
import './styles.css';

applyTheme(readTheme());

const backend = createFirebaseBackend();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BackendProvider backend={backend}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </BackendProvider>
  </StrictMode>,
);
