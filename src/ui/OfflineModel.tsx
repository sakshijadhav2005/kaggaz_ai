import { IonButton } from '@ionic/react';
import { useEffect, useReducer, useState } from 'react';

import { useT } from '../i18n';
import { LOCAL_MODEL, type LocalModelView } from '../llm/localModel';
import { Icon } from './icons';

interface Props {
  model: LocalModelView;
  /** `banner` sits at the top of the Ask tab; `panel` is the section in Settings. */
  variant: 'banner' | 'panel';
}

/** Download and status of Gemma 4 on the phone, which is used whenever the app is offline. */
export default function OfflineModel({ model, variant }: Props) {
  const s = useT();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [starting, setStarting] = useState(false);
  useEffect(() => model.subscribe(refresh), [model]);

  const percent = model.downloadPercent();
  const error = model.lastError();
  const loadError = model.loadError();
  // Errors are read back from the model, so a failed start needs no handling here.
  const start = () => void model.download().catch(() => undefined);
  const again = () => void model.redownload().catch(() => undefined);
  const retry = () => {
    setStarting(true);
    void model
      .retryLoad()
      .catch(() => undefined)
      .finally(() => setStarting(false));
  };

  let body;
  if (!model.isSupported()) {
    if (variant === 'banner') return null; // nothing to offer in a browser
    body = <p className="hint">{s.offline.browser}</p>;
  } else if (percent !== null) {
    body = (
      <>
        <p>
          <strong>{s.offline.downloading(percent)}</strong>
        </p>
        <progress max={100} value={percent} aria-label={s.offline.progressLabel} />
        <small>{s.offline.keepWifi}</small>
      </>
    );
  } else if (model.isInstalled() && loadError) {
    // Downloaded, but would not start. Say why, and offer a retry that does not download 2.6 GB again.
    body = (
      <>
        <p>
          <strong>{s.offline.noStart}</strong>
        </p>
        <p className="error">{loadError}</p>
        <div className="actions">
          <IonButton disabled={starting} onClick={retry}>
            {starting ? s.offline.starting : s.common.retry}
          </IonButton>
          <IonButton fill="outline" disabled={starting} onClick={again}>
            {s.offline.downloadAgain}
          </IonButton>
        </div>
      </>
    );
  } else if (model.isInstalled()) {
    if (variant === 'banner') {
      return (
        <p className="model-ok">
          <Icon name="check" size={16} /> {s.offline.readyBanner}
        </p>
      );
    }
    body = <p className="hint">{s.offline.readyPanel(LOCAL_MODEL.name)}</p>;
  } else {
    body = (
      <>
        <p>
          {variant === 'banner' && <strong>{s.offline.pitchBanner}</strong>}
          {s.offline.pitch(LOCAL_MODEL.name, LOCAL_MODEL.sizeLabel)}
        </p>
        <IonButton expand="block" onClick={start}>
          <Icon name="plus" size={16} /> {s.offline.download(LOCAL_MODEL.sizeLabel)}
        </IonButton>
      </>
    );
  }

  const failure = error && percent === null && !model.isInstalled() ? <p className="error">{s.offline.failed(error)}</p> : null;

  if (variant === 'panel') {
    return (
      <div className="offline">
        <h3>{s.offline.title}</h3>
        {body}
        {failure}
      </div>
    );
  }
  return (
    <div className="card model-card">
      {body}
      {failure}
    </div>
  );
}
