import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// ── Auto-update: reload when the served bundle changes ───────────────────────
// Clients (especially mobile / WebView) kept running week-old cached bundles,
// which made every deployed fix look broken. Poll index.html (no-store) and
// compare the referenced bundle hash with the one this code was built into
// (import.meta.url). On mismatch, reload once (10-min guard against loops).
function watchForNewVersion() {
  const current = (import.meta.url.match(/index-[A-Za-z0-9_-]+\.js/) || [])[0];
  if (!current) return; // dev mode
  const check = async () => {
    try {
      const res = await fetch('/', { cache: 'no-store' });
      if (!res.ok) return;
      const served = ((await res.text()).match(/index-[A-Za-z0-9_-]+\.js/) || [])[0];
      if (served && served !== current) {
        const last = Number(sessionStorage.getItem('sfera.reloadAt') || 0);
        if (Date.now() - last > 10 * 60 * 1000) {
          sessionStorage.setItem('sfera.reloadAt', String(Date.now()));
          window.location.reload();
        }
      }
    } catch { /* offline — try again later */ }
  };
  setInterval(check, 60 * 1000);
  // Also check when the app returns to the foreground (mobile tab resume).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}
watchForNewVersion();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
