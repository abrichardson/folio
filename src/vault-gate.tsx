import { useEffect, useState, type FormEvent } from 'react';
import { Leaf, LockKeyhole, LoaderCircle } from 'lucide-react';
import FinanceApp from './finance-app';
import type { Storage, VaultStatus } from './storage';

const MIN_PASSWORD = 8;

/** Creates or unlocks the encrypted Folio file before showing any finances. */
export default function VaultGate({ storage }: { storage: Storage }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    storage.status().then(setStatus, (e: Error) => setError(e.message));
  }, [storage]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (status === 'missing') {
      if (password.length < MIN_PASSWORD)
        return setError(`Use at least ${MIN_PASSWORD} characters.`);
      if (password !== confirm) return setError('The passwords do not match.');
    }
    setWorking(true);
    try {
      await (status === 'missing' ? storage.create(password) : storage.unlock(password));
      setPassword('');
      setConfirm('');
      setStatus('unlocked');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  async function lock() {
    await storage.lock();
    setStatus('locked');
  }

  if (status === 'unlocked') return <FinanceApp storage={storage} onLock={lock} />;

  const creating = status === 'missing';
  return (
    <main className="vault-screen">
      <form className="vault-card" onSubmit={submit}>
        <div className="brand">
          <Leaf size={29} />
          <span>
            folio<span className="brand-dot">.</span>
          </span>
        </div>
        <div className="vault-body">
          {status === null && !error ? (
            <p className="vault-note">
              <LoaderCircle size={16} className="animate-spin" /> Opening Folio…
            </p>
          ) : (
            <>
              <h1>{creating ? 'Create your Folio file' : 'Unlock Folio'}</h1>
              <p className="vault-note">
                {creating
                  ? 'Your finances are stored only on this computer, in a file encrypted with this password.'
                  : 'Enter your password to open your finances.'}
              </p>
              <label className="form-field">
                Password
                <input
                  type="password"
                  autoFocus
                  autoComplete={creating ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={working}
                  required
                />
              </label>
              {creating && (
                <>
                  <label className="form-field">
                    Confirm password
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      disabled={working}
                      required
                    />
                  </label>
                  <p className="form-hint">
                    There is no way to recover a forgotten password. Write it down somewhere safe.
                  </p>
                </>
              )}
              {error && (
                <p className="error-banner" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" type="submit" disabled={working || status === null}>
                <LockKeyhole size={16} />
                {working ? 'Please wait…' : creating ? 'Create and open' : 'Unlock'}
              </button>
            </>
          )}
        </div>
      </form>
    </main>
  );
}
