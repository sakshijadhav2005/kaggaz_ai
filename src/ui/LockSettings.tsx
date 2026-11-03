import { IonSelect, IonSelectOption, IonToggle } from '@ionic/react';
import { useEffect, useState } from 'react';

import { authenticate, AUTO_LOCK_CHOICES, lockSettings, lockUnavailableReason, saveLockSettings, type LockProblem } from '../core/appLock';
import { useT } from '../i18n';

/** The App lock section of Settings. Turning the lock on or off asks for the fingerprint or screen lock first. */
export default function LockSettingsPanel() {
  const s = useT();
  const [settings, setSettings] = useState(lockSettings);
  // A code, not text, so the message follows a language change.
  const [unavailable, setUnavailable] = useState<LockProblem | 'unavailable' | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    lockUnavailableReason().then(setUnavailable, () => setUnavailable('unavailable'));
  }, []);

  const update = (next: typeof settings) => {
    saveLockSettings(next);
    setSettings(next);
  };

  const toggle = async (enabled: boolean) => {
    setMessage('');
    try {
      // Proves the prompt works before the user can be locked out by it, and stops anyone else turning it off.
      await authenticate(enabled ? s.lock.reasonOn : s.lock.reasonOff);
      update({ ...settings, enabled });
    } catch {
      setMessage(s.lock.notConfirmed);
    }
  };

  return (
    <section className="lock-settings">
      <h2>{s.lock.title}</h2>
      <IonToggle
        checked={settings.enabled}
        disabled={unavailable !== null}
        onIonChange={(e) => {
          // Keep the toggle where it was until the prompt succeeds.
          e.target.checked = settings.enabled;
          void toggle(e.detail.checked);
        }}
      >
        {s.lock.toggle}
      </IonToggle>
      {settings.enabled && (
        <IonSelect
          label={s.lock.again}
          interface="popover"
          value={settings.autoLockMs}
          onIonChange={(e) => update({ ...settings, autoLockMs: Number(e.detail.value) })}
        >
          {AUTO_LOCK_CHOICES.map((ms) => (
            <IonSelectOption key={ms} value={ms}>{s.lock.choices[ms]}</IonSelectOption>
          ))}
        </IonSelect>
      )}
      <p className="hint">{(unavailable && s.lock[unavailable]) || message || s.lock.hint}</p>
    </section>
  );
}
