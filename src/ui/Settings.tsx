import { IonButton, IonInput, IonItem, IonLabel, IonList, IonSegment, IonSegmentButton, IonSelect, IonSelectOption, IonSpinner } from '@ionic/react';
import { useContext, useState } from 'react';

import qaCases from '../eval/eval_qa.json';
import { runQaEval, type QaCase, type QaOutcome } from '../eval/qaEval';
import { LANGS, lang, setLang, useT } from '../i18n';
import { getDevApiKey, setDevApiKey, usesProxy } from '../llm/gemini';
import { services } from '../services';
import BackupPanel from './Backup';
import { Modal, ThemeContext } from './common';
import { CloudSettingsPanel } from './Consent';
import LockSettingsPanel from './LockSettings';
import OfflineModel from './OfflineModel';
import StoragePanel from './StoragePanel';

/** The Settings screen, opened from the gear in any tab's header. */
export default function Settings({ onClose }: { onClose: () => void }) {
  const s = useT();
  const theme = useContext(ThemeContext);
  const [key, setKey] = useState(getDevApiKey());
  const [evalResults, setEvalResults] = useState<QaOutcome[] | 'running' | null>(null);
  // Release builds use the Kaagaz server and have no key to enter.
  const proxy = usesProxy();

  const close = () => {
    if (!proxy) setDevApiKey(key);
    void services().embedMissing(); // files imported before the key or consent became answerable
    onClose();
  };

  const runEval = async () => {
    setEvalResults('running');
    try {
      setEvalResults(await runQaEval(qaCases as QaCase[], (q) => services().answerer.ask(q)));
    } catch {
      setEvalResults(null);
    }
  };

  return (
    <Modal
      title={s.settings.title}
      size="full"
      onClose={close}
      footer={<IonButton onClick={close}>{proxy ? s.common.close : s.common.save}</IonButton>}
    >
      <div className="settings">
        <StoragePanel />

        {theme && (
          <section className="panel">
            <IonSelect
              label={s.settings.appearanceTitle}
              labelPlacement="stacked"
              interface="popover"
              value={theme.theme}
              onIonChange={(e) => {
                const value = e.detail.value;
                if (value === 'light' || value === 'dark' || value === 'neon') theme.setTheme(value);
              }}
            >
              <IonSelectOption value="light">{s.settings.themeLight}</IonSelectOption>
              <IonSelectOption value="dark">{s.settings.themeDark}</IonSelectOption>
              <IonSelectOption value="neon">{s.settings.themeNeon}</IonSelectOption>
            </IonSelect>
          </section>
        )}

        <section className="panel">
          <h2>{s.settings.language}</h2>
          <IonSegment value={lang()} onIonChange={(e) => setLang(e.detail.value === 'hi' ? 'hi' : 'en')} aria-label={s.settings.language}>
            {LANGS.map((l) => (
              <IonSegmentButton key={l.id} value={l.id} lang={l.id}>
                <IonLabel>{l.label}</IonLabel>
              </IonSegmentButton>
            ))}
          </IonSegment>
        </section>

        <section className="panel">
          <h2>{s.settings.aiTitle}</h2>
          {proxy ? (
            <p className="hint">{s.settings.offlineHint}</p>
          ) : (
            <>
              <IonInput
                type="password"
                label={s.settings.devKey}
                labelPlacement="stacked"
                fill="outline"
                value={key}
                onIonInput={(e) => setKey(String(e.detail.value ?? ''))}
                placeholder={s.settings.devKeyPlaceholder}
              />
              <p className="hint">{s.settings.devKeyHint}</p>
            </>
          )}
          <OfflineModel model={services().local} variant="panel" />
        </section>

        <CloudSettingsPanel />
        <LockSettingsPanel />
        <BackupPanel />

        <section className="panel">
          <h2>{s.settings.developer}</h2>
          <p className="hint">{s.settings.evalHint}</p>
          <IonButton fill="outline" disabled={evalResults === 'running'} onClick={() => void runEval()}>
            {evalResults === 'running' ? <><IonSpinner name="crescent" /> {s.library.evalRunning}</> : s.library.runEval}
          </IonButton>
          {Array.isArray(evalResults) && (
            <>
              <p className="eval-score">{s.library.evalResult(evalResults.filter((r) => r.passed).length, evalResults.length)}</p>
              <IonList lines="full">
                {evalResults.map((r, i) => (
                  <IonItem key={i}>
                    <span slot="start" className={r.passed ? 'eval-pass' : 'eval-fail'} aria-hidden>{r.passed ? '✓' : '✗'}</span>
                    <IonLabel className="ion-text-wrap">
                      <h3>{r.testCase.question}</h3>
                      <p>{r.answer.slice(0, 200)}</p>
                    </IonLabel>
                  </IonItem>
                ))}
              </IonList>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
