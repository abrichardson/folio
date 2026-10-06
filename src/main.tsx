import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';
import { getStorage } from './storage';
import VaultGate from './vault-gate';

const storage = getStorage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {storage ? (
      <VaultGate storage={storage} />
    ) : (
      <main className="vault-screen">
        <p className="error-banner" role="alert">
          Open Folio from the desktop app. This page cannot store finances on its own.
        </p>
      </main>
    )}
  </StrictMode>,
);
