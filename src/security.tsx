import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DatabaseBackup, Download, KeyRound, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { today } from '@/lib/finance';
import type { Backup, Storage } from './storage';

const MIN_PASSWORD = 8;
const lockChoices = [
  ['0', 'Never'],
  ['5', 'After 5 minutes'],
  ['15', 'After 15 minutes'],
  ['30', 'After 30 minutes'],
  ['60', 'After 1 hour'],
] as const;

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Password change and automatic locking. */
export function SecurityPanel({
  storage,
  autoLockMinutes,
  saving,
  onAutoLock,
}: {
  storage: Storage;
  autoLockMinutes: number;
  saving: boolean;
  onAutoLock: (minutes: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel settings-panel extra-settings">
      <h2>Security</h2>
      <div className="setting-row">
        <div>
          <h3>Password</h3>
          <p>
            Change the password that encrypts your Folio file. Existing backups keep the password
            they were made with.
          </p>
        </div>
        <button className="secondary" onClick={() => setOpen(true)}>
          <KeyRound size={16} />
          Change password
        </button>
      </div>
      <div className="setting-row">
        <div>
          <h3>Lock automatically</h3>
          <p>Lock Folio when you have not used it for a while. Unsaved form entries are lost.</p>
        </div>
        <label className="form-field compact-field">
          <Select
            value={String(autoLockMinutes)}
            onValueChange={(v) => onAutoLock(Number(v))}
            disabled={saving}
          >
            <SelectTrigger aria-label="Lock automatically">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {lockChoices.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="finance-dialog">
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              There is no way to recover a forgotten password. Write the new one down somewhere
              safe.
            </DialogDescription>
          </DialogHeader>
          <PasswordForm storage={storage} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </section>
  );
}

function PasswordForm({ storage, onDone }: { storage: Storage; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (next.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (next !== confirm) return setError('The new passwords do not match.');
    if (next === current) return setError('Choose a password different from the current one.');
    setWorking(true);
    try {
      await storage.changePassword(current, next);
      toast.success('Password changed');
      onDone();
    } catch (err) {
      setError(message(err, 'The password could not be changed.'));
    } finally {
      setWorking(false);
    }
  }
  const field = (label: string, value: string, set: (v: string) => void, auto: string) => (
    <label className="form-field">
      {label}
      <input
        type="password"
        autoComplete={auto}
        value={value}
        onChange={(e) => set(e.target.value)}
        disabled={working}
        required
      />
    </label>
  );
  return (
    <form className="record-form" onSubmit={submit}>
      {field('Current password', current, setCurrent, 'current-password')}
      {field('New password', next, setNext, 'new-password')}
      {field('Confirm new password', confirm, setConfirm, 'new-password')}
      {error && (
        <p className="negative" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <span />
        <button className="primary" type="submit" disabled={working}>
          {working ? 'Changing…' : 'Change password'}
        </button>
      </div>
    </form>
  );
}

const kindLabels: Record<Backup['kind'], string> = {
  daily: 'Daily',
  manual: 'Made by you',
  upgrade: 'Before an update',
  restore: 'Before a restore',
};

const size = (bytes: number) =>
  bytes < 1_000_000
    ? `${Math.max(1, Math.round(bytes / 1000))} KB`
    : `${(bytes / 1e6).toFixed(1)} MB`;

const madeAt = (b: Backup) =>
  new Date(b.created * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Lists the automatic encrypted backups and restores one. */
export function BackupsPanel({
  storage,
  disabled,
  onRestored,
}: {
  storage: Storage;
  disabled: boolean;
  onRestored: () => Promise<void>;
}) {
  const backups = storage.backups;
  const [list, setList] = useState<Backup[] | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [all, setAll] = useState(false);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const refresh = useCallback(() => {
    if (!backups) return;
    backups.list().then(
      (l) => {
        setList(l);
        setError('');
      },
      (e) => setError(message(e, 'Backups could not be listed.')),
    );
  }, [backups]);
  useEffect(refresh, [refresh]);
  if (!backups) return null;
  const shown = all ? (list ?? []) : (list ?? []).slice(0, 8);
  return (
    <section className="panel settings-panel extra-settings">
      <h2>Automatic backups</h2>
      <div className="setting-row">
        <div>
          <h3>Encrypted copies on this computer</h3>
          <p>
            Folio copies your encrypted file once a day when you unlock it and keeps 30 days, plus a
            copy before each update and before any restore. Each backup opens with the password you
            had when it was made. Save a copy to another drive to protect against losing this
            computer.
          </p>
        </div>
        <button
          className="secondary"
          disabled={disabled || working}
          onClick={async () => {
            setWorking(true);
            try {
              await backups.now(today());
              toast.success('Backup saved');
              refresh();
            } catch (e) {
              toast.error(message(e, 'The backup could not be saved.'));
            } finally {
              setWorking(false);
            }
          }}
        >
          <DatabaseBackup size={16} />
          Back up now
        </button>
      </div>
      {error && (
        <p className="negative" role="alert">
          {error}
        </p>
      )}
      {list && !list.length && <p className="form-hint">No backups yet.</p>}
      {shown.map((b) => (
        <div className="setting-row backup-row" key={b.name}>
          <div>
            <h3>{madeAt(b)}</h3>
            <p>
              {kindLabels[b.kind]} · {size(b.bytes)}
            </p>
          </div>
          <div className="row-actions">
            <button
              className="secondary"
              disabled={disabled || working}
              onClick={() =>
                backups.saveCopy(b.name).then(
                  (saved) => saved && toast.success('Copy saved'),
                  (e) => toast.error(message(e, 'The copy could not be saved.')),
                )
              }
            >
              <Download size={16} />
              Save a copy
            </button>
            <button
              className="secondary"
              disabled={disabled || working}
              onClick={() => setRestoring(b)}
            >
              <RotateCcw size={16} />
              Restore
            </button>
          </div>
        </div>
      ))}
      {list && list.length > shown.length && (
        <button className="text-button" onClick={() => setAll(true)}>
          Show all {list.length} backups
        </button>
      )}
      <Dialog open={!!restoring} onOpenChange={(open) => !open && !working && setRestoring(null)}>
        <DialogContent className="finance-dialog">
          <DialogHeader>
            <DialogTitle>Restore this backup?</DialogTitle>
            <DialogDescription>
              {restoring &&
                `Your finances go back to how they were on ${madeAt(restoring)}. Your current file is kept as a backup first, so this can be reversed.`}
            </DialogDescription>
          </DialogHeader>
          {restoring && (
            <RestoreForm
              backup={restoring}
              working={working}
              onRestore={async (password) => {
                setWorking(true);
                try {
                  await backups.restore(restoring.name, password, today());
                  setRestoring(null);
                  await onRestored();
                  toast.success('Backup restored');
                  refresh();
                  return '';
                } catch (e) {
                  return message(e, 'The backup could not be restored.');
                } finally {
                  setWorking(false);
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function RestoreForm({
  backup,
  working,
  onRestore,
}: {
  backup: Backup;
  working: boolean;
  onRestore: (password: string) => Promise<string>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  return (
    <form
      className="record-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(await onRestore(password));
      }}
    >
      <label className="form-field">
        Password for this backup
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={working}
          required
        />
      </label>
      <p className="form-hint">
        Use the password Folio had on {backup.date}. After restoring, Folio opens with that
        password.
      </p>
      {error && (
        <p className="negative" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <span />
        <button className="primary" type="submit" disabled={working}>
          {working ? 'Restoring…' : 'Restore backup'}
        </button>
      </div>
    </form>
  );
}
