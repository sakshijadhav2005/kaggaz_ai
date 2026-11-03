import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonModal,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { Fragment, useState, type ReactNode } from 'react';

import { locale, useT } from '../i18n';
import { FOLDERS, type Folder, type StoredFile } from '../models';
import { services } from '../services';
import { Icon } from './icons';

export type OpenFn = (fileId: string, page?: number) => void;

export const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' });

/** A file name that may wrap after _ . - rather than in the middle of a word. */
export const BreakableName = ({ name }: { name: string }) => (
  <>
    {name.split(/(?<=[_.\-])/).map((part, i) => (
      <Fragment key={i}>
        {i > 0 && <wbr />}
        {part}
      </Fragment>
    ))}
  </>
);

export const fmtMoney = (n: number) => `Rs ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A page header; [children] become buttons on the right. */
export function Header({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <IonHeader>
      <IonToolbar>
        <IonTitle>{title}</IonTitle>
        {children && <IonButtons slot="end">{children}</IonButtons>}
      </IonToolbar>
    </IonHeader>
  );
}

/** A bottom sheet. The parent unmounts it from [onClose]. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const s = useT();
  return (
    <IonModal isOpen onDidDismiss={onClose} initialBreakpoint={0.75} breakpoints={[0, 0.75, 1]} aria-label={title}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>{title}</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onClose}>{s.common.close}</IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">{children}</IonContent>
    </IonModal>
  );
}

/** Asks for a folder and moves the file there manually. */
export function MoveDialog({ file, onDone, onClose }: { file: StoredFile; onDone: () => void; onClose: () => void }) {
  const s = useT();
  const [error, setError] = useState('');
  const pick = async (folder: Folder) => {
    if (folder !== file.folder) {
      try {
        await services().ingest.moveManually(file, folder);
        onDone();
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    onClose();
  };
  return (
    <Modal title={s.dialogs.moveTitle} onClose={onClose}>
      <div className="stack">
        {FOLDERS.map((f) => (
          <IonButton key={f} expand="block" fill={f === file.folder ? 'solid' : 'outline'} onClick={() => pick(f)}>
            {s.folders[f]}
          </IonButton>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

interface RenameProps {
  title?: string;
  /** Name without extension. */
  initial: string;
  /** Shown after the box and never edited, so the file type cannot change. */
  ext: string;
  onSave: (stem: string) => Promise<void>;
  /** Asks Gemma 4 (online, or on the device when offline) for a name based on the content. */
  onSuggest?: () => Promise<string | null>;
  onClose: () => void;
}

export function RenameDialog({ title, initial, ext, onSave, onSuggest, onClose }: RenameProps) {
  const t = useT();
  const s = t;
  const [stem, setStem] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const suggest = async () => {
    setBusy(true);
    setError('');
    try {
      const suggestion = await onSuggest!();
      if (suggestion) setStem(suggestion);
      else setError(t.dialogs.noSuggestion);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await onSave(stem);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={title ?? s.dialogs.renameTitle} onClose={onClose}>
      <IonInput
        label={s.dialogs.name}
        labelPlacement="stacked"
        fill="outline"
        value={stem}
        autofocus
        onIonInput={(e) => setStem(String(e.detail.value ?? ''))}
        onKeyDown={(e) => e.key === 'Enter' && void save()}
      >
        <span slot="end" className="ext">{ext}</span>
      </IonInput>
      {onSuggest && (
        <IonButton fill="outline" disabled={busy} onClick={() => void suggest()}>
          <Icon name="sparkle" size={16} /> {busy ? s.dialogs.thinking : s.dialogs.suggest}
        </IonButton>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <IonButton fill="outline" onClick={onClose}>{s.common.cancel}</IonButton>
        <IonButton disabled={busy || stem.trim() === ''} onClick={() => void save()}>{s.common.save}</IonButton>
      </div>
    </Modal>
  );
}
