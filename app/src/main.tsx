import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { app } from './app/controller.js';
import { captureInviteFromLocation } from './app/invite.js';
import './styles.css';

// Read the pairing invite out of the URL fragment (and erase it from the address bar) before anything else runs.
captureInviteFromLocation();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void app.init().catch((e) => {
  console.error('startup failed', e instanceof Error ? e.message : e);
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => app.setServiceWorker(reg))
      .catch(() => undefined);
  });
}
