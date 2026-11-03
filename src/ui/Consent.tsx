import { IonButton, IonToggle } from '@ionic/react';
import { useEffect, useState } from 'react';

import { cloudConsent, cloudConsentDate, onConsentChange, setCloudConsent, type ConsentStatus } from '../core/consent';
import type { AuditRow } from '../core/db';
import { lang, locale, useT } from '../i18n';
import { hostedConfigured } from '../llm/gemini';
import { services } from '../services';
import { Modal } from './common';

function useConsent(): ConsentStatus {
  const [status, setStatus] = useState(cloudConsent);
  useEffect(() => onConsentChange(() => setStatus(cloudConsent())), []);
  return status;
}

/** The notice itself: what, why, who, what happens without it, how to withdraw. */
function Notice() {
  const s = useT();
  return (
    <dl className="notice">
      {s.consent.points.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

async function decide(granted: boolean, via: 'first-run' | 'settings') {
  try {
    await setCloudConsent(granted, via, lang());
  } catch (e) {
    // The choice is already in effect; only the audit entry failed.
    console.error('Could not write the consent record:', e);
  }
  if (granted) void services().embedMissing(); // documents imported meanwhile become searchable by meaning
}

/** Asked once, after unlock, in builds that have online AI. Closing without choosing means no: nothing is sent. */
export function FirstRunConsent() {
  const s = useT();
  const status = useConsent();
  const [dismissed, setDismissed] = useState(false);
  if (!hostedConfigured() || status !== 'unasked' || dismissed) return null;
  return (
    <Modal title={s.consent.title} onClose={() => setDismissed(true)}>
      <Notice />
      <div className="actions consent-actions">
        <IonButton fill="outline" onClick={() => void decide(false, 'first-run')}>{s.consent.decline}</IonButton>
        <IonButton onClick={() => void decide(true, 'first-run')}>{s.consent.allow}</IonButton>
      </div>
    </Modal>
  );
}

const fmt = (d: Date | number) => new Date(d).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });

/** The Online AI section of Settings. Withdrawing takes one tap; allowing shows the notice first. */
export function CloudSettingsPanel() {
  const s = useT();
  const status = useConsent();
  const [reviewing, setReviewing] = useState(false);
  const [log, setLog] = useState<{ rows: AuditRow[]; ok: boolean } | null>(null);

  if (!hostedConfigured()) return null;
  const on = status === 'granted';
  const since = cloudConsentDate();

  const showLog = async () => {
    const { db } = services();
    const [rows, check] = await Promise.all([db.auditLog(20), db.verifyAudit()]);
    setLog({ rows: rows.filter((r) => r.event.startsWith('consent.')), ok: check.ok });
  };

  return (
    <section className="lock-settings">
      <h2>{s.consent.panelTitle}</h2>
      <IonToggle
        checked={on}
        onIonChange={(e) => {
          e.target.checked = on; // the toggle follows the stored choice, not the tap
          if (on) void decide(false, 'settings');
          else setReviewing(true);
        }}
      >
        {s.consent.toggle}
      </IonToggle>
      <p className="hint">
        {on ? s.consent.onSince(fmt(since!)) : since ? s.consent.offSince(fmt(since)) : s.consent.off}
        {on ? s.consent.onNote : s.consent.offNote}
      </p>
      {reviewing && !on && (
        <div className="card notice-card">
          <Notice />
          <div className="actions">
            <IonButton fill="outline" onClick={() => setReviewing(false)}>{s.common.cancel}</IonButton>
            <IonButton onClick={() => { setReviewing(false); void decide(true, 'settings'); }}>{s.consent.allow}</IonButton>
          </div>
        </div>
      )}
      {!log ? (
        <IonButton fill="clear" size="small" onClick={() => void showLog()}>{s.consent.showRecord}</IonButton>
      ) : (
        <div className="consent-log">
          {log.rows.length === 0 && <p className="hint">{s.consent.noRecord}</p>}
          {log.rows.map((r) => (
            <p key={r.id} className="hint">
              {fmt(r.at)}: {r.event === 'consent.cloud.granted' ? s.consent.allowed : s.consent.turnedOff} ({s.consent.notice(JSON.parse(r.details).noticeVersion)})
            </p>
          ))}
          <p className="hint">{log.ok ? s.consent.intact : s.consent.altered}</p>
        </div>
      )}
    </section>
  );
}
