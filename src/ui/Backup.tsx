import { IonButton, IonInput, IonProgressBar } from '@ionic/react';
import { useRef, useState } from 'react';

import { expectExternalActivity } from '../core/appLock';
import { saveBackup } from '../backup/backupFiles';
import { blobSource, MIN_PASSWORD } from '../backup/backupFormat';
import { createBackup, restoreBackup } from '../backup/backupService';
import { useT } from '../i18n';
import { services } from '../services';

type Mode = 'idle' | 'create' | 'restore';

/** The Backup section of Settings. */
export default function BackupPanel() {
  const s = useT();
  const [mode, setMode] = useState<Mode>('idle');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [picked, setPicked] = useState<File | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const reset = (m: Mode = 'idle') => {
    setMode(m);
    setPassword('');
    setAgain('');
    setProgress(null);
    setError('');
  };

  const run = async (job: () => Promise<string>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setMessage(await job());
      reset();
      setPicked(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const create = () =>
    run(async () => {
      const n = await saveBackup((write) => createBackup(services().backup, password, write, (done, total) => setProgress({ done, total })));
      return s.backup.made(n);
    });

  const restore = () =>
    run(async () => {
      const r = await restoreBackup(services().backup, blobSource(picked!), password, (done, total) => setProgress({ done, total }));
      void services().embedMissing();
      return s.backup.restored(r.added, r.skipped);
    });

  const mismatch = mode === 'create' && again !== '' && again !== password;
  const tooShort = password.length < MIN_PASSWORD;

  return (
    <section className="panel">
      <h2>{s.backup.title}</h2>
      <p className="hint">{s.backup.intro}</p>

      {mode === 'idle' && (
        <div className="actions backup-actions">
          <IonButton fill="outline" onClick={() => { expectExternalActivity(); input.current?.click(); }}>{s.backup.restore}</IonButton>
          <IonButton onClick={() => { setMessage(''); reset('create'); }}>{s.backup.create}</IonButton>
        </div>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept=".kgbackup,application/octet-stream"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = '';
          if (f) {
            setMessage('');
            setPicked(f);
            reset('restore');
          }
        }}
      />

      {mode !== 'idle' && (
        <div className="card notice-card">
          {mode === 'create' ? (
            <p className="hint"><strong>{s.backup.forgetWarning}</strong> {s.backup.forgetWarning2}</p>
          ) : (
            <p className="hint">{s.backup.restoring(picked?.name ?? '')}</p>
          )}
          <IonInput
            type="password"
            label={s.backup.password}
            labelPlacement="stacked"
            fill="outline"
            value={password}
            onIonInput={(e) => setPassword(String(e.detail.value ?? ''))}
            helperText={mode === 'create' ? s.backup.minLength(MIN_PASSWORD) : undefined}
          />
          {mode === 'create' && (
            <IonInput
              type="password"
              label={s.backup.again}
              labelPlacement="stacked"
              fill="outline"
              className="tool-field"
              value={again}
              onIonInput={(e) => setAgain(String(e.detail.value ?? ''))}
              errorText={s.backup.mismatch}
              {...(mismatch ? { className: 'tool-field ion-invalid ion-touched' } : {})}
            />
          )}
          {progress && <p className="hint">{mode === 'create' ? s.backup.progressCreate(progress.done, progress.total) : s.backup.progressRestore(progress.done, progress.total)}</p>}
          {busy && <IonProgressBar type={progress?.total ? 'determinate' : 'indeterminate'} value={progress?.total ? progress.done / progress.total : undefined} />}
          {error && <p className="lock-error" role="alert">{error}</p>}
          <div className="actions">
            <IonButton fill="outline" disabled={busy} onClick={() => reset()}>{s.common.cancel}</IonButton>
            {mode === 'create' ? (
              <IonButton disabled={busy || tooShort || again !== password} onClick={() => void create()}>{s.backup.create}</IonButton>
            ) : (
              <IonButton disabled={busy || password === ''} onClick={() => void restore()}>{s.backup.restore}</IonButton>
            )}
          </div>
        </div>
      )}
      {message && <p className="hint" role="status">{message}</p>}
    </section>
  );
}
