import { App as CapApp } from '@capacitor/app';
import { IonButton } from '@ionic/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { authenticate, consumeExternalActivity, lockSettings } from '../core/appLock';
import { strings, useT } from '../i18n';
import { Icon } from './icons';

/**
 * Covers the app until the user unlocks with fingerprint, face or screen lock. The app stays mounted
 * underneath (an import in progress keeps running) but is hidden and inert while locked.
 */
export default function LockGate({ children }: { children: ReactNode }) {
  const s = useT();
  const [locked, setLocked] = useState(() => lockSettings().enabled);
  const [foreground, setForeground] = useState(true);
  const [error, setError] = useState('');
  const busy = useRef(false);
  /** The system prompt opens by itself once per lock; after a cancel the user taps Unlock. */
  const autoPrompted = useRef(false);
  /** When the app went to the background on an unannounced trip; null otherwise. */
  const leftAt = useRef<number | null>(null);

  const lock = useCallback(() => {
    autoPrompted.current = false;
    setError('');
    setLocked(true);
  }, []);

  const unlock = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setError('');
    try {
      await authenticate(strings().lock.reasonUnlock);
      setLocked(false);
    } catch {
      setError(strings().lock.notUnlocked);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (locked && foreground && !autoPrompted.current) {
      autoPrompted.current = true;
      void unlock();
    }
  }, [locked, foreground, unlock]);

  useEffect(() => {
    const sub = CapApp.addListener('appStateChange', ({ isActive }) => {
      setForeground(isActive);
      const s = lockSettings();
      if (!s.enabled) return;
      if (!isActive) {
        // Trips to the scanner, picker or the unlock prompt itself don't count.
        leftAt.current = consumeExternalActivity() || busy.current ? null : Date.now();
        if (s.autoLockMs === 0 && leftAt.current !== null) lock(); // hides content before the recents snapshot
        return;
      }
      if (leftAt.current !== null && Date.now() - leftAt.current >= s.autoLockMs) lock();
      leftAt.current = null;
    });
    return () => void sub.then((h) => h.remove());
  }, [lock]);

  return (
    <>
      <div className="lock-content" aria-hidden={locked} inert={locked}>
        {children}
      </div>
      {locked && (
        <div className="lock-screen" role="dialog" aria-modal="true" aria-label={s.lock.lockedTitle}>
          <Icon name="lock" size={40} />
          <h1>{s.lock.lockedTitle}</h1>
          <p className="hint">{s.lock.lockedHint}</p>
          {error && <p className="lock-error" role="alert">{error}</p>}
          <IonButton onClick={() => void unlock()}>{s.lock.unlock}</IonButton>
        </div>
      )}
    </>
  );
}
