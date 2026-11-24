import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonInput,
  IonModal,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { createContext, Fragment, useContext, useState, type ReactNode } from 'react';

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

/** Opens the Settings screen from any tab's header. Provided by App. */
export const SettingsContext = createContext<(() => void) | null>(null);
export type AppTheme = 'light' | 'dark' | 'neon';
export const ThemeContext = createContext<{
  theme: AppTheme;
  toggle: () => void;
  setTheme: (theme: AppTheme) => void;
} | null>(null);

/** A page header; [children] become buttons on the right, followed by Settings. */
export function Header({ title, children }: { title: string; children?: ReactNode }) {
  const s = useT();
  const openSettings = useContext(SettingsContext);
  const theme = useContext(ThemeContext);
  return (
    <IonHeader>
      <IonToolbar>
        <IonTitle>{title}</IonTitle>
        <IonButtons slot="end">
          {children}
          {theme && (
            <IonButton
              aria-label={theme.theme === 'light' ? s.theme.switchToDark : s.theme.switchToLight}
              title={theme.theme === 'light' ? s.theme.switchToDark : s.theme.switchToLight}
              onClick={theme.toggle}
            >
              <Icon name={theme.theme === 'light' ? 'moon' : 'sun'} />
            </IonButton>
          )}
          {openSettings && (
            <IonButton aria-label={s.library.settings} title={s.library.settings} onClick={openSettings}>
              <Icon name="gear" />
            </IonButton>
          )}
        </IonButtons>
      </IonToolbar>
    </IonHeader>
  );
}

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Buttons pinned below the content, so they are always on screen. */
  footer?: ReactNode;
  /**
   * `dialog` (default) is a centred card sized to its content, for short forms and confirmations.
   * `full` covers the screen, for long content such as Settings or a file picker.
   */
  size?: 'dialog' | 'full';
}

/** A dialog. The parent unmounts it from [onClose]. */
export function Modal({ title, onClose, children, footer, size = 'dialog' }: ModalProps) {
  const s = useT();
  if (size === 'full') {
    return (
      <IonModal isOpen onDidDismiss={onClose} aria-label={title}>
        <IonHeader>
          <IonToolbar>
            <IonButtons slot="start">
              <IonButton onClick={onClose} aria-label={s.common.close} title={s.common.close}>
                <Icon name="back" />
              </IonButton>
            </IonButtons>
            <IonTitle>{title}</IonTitle>
          </IonToolbar>
        </IonHeader>
        <IonContent className="ion-padding">{children}</IonContent>
        {footer && (
          <IonFooter className="modal-footer-bar">
            <div className="modal-footer">{footer}</div>
          </IonFooter>
        )}
      </IonModal>
    );
  }
  return (
    <IonModal isOpen onDidDismiss={onClose} className="dialog" aria-label={title}>
      <div className="dialog-page">
        <div className="dialog-head">
          <h2>{title}</h2>
          <IonButton fill="clear" color="medium" onClick={onClose} aria-label={s.common.close} title={s.common.close}>
            <Icon name="close" size={20} />
          </IonButton>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
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
      <div className="choice-list" role="listbox" aria-label={s.dialogs.moveTitle}>
        {FOLDERS.map((f) => (
          <button key={f} className={f === file.folder ? 'choice current' : 'choice'} role="option" aria-selected={f === file.folder} onClick={() => void pick(f)}>
            <Icon name="folder" size={20} />
            <span className="grow">{s.folders[f]}</span>
            {f === file.folder && <Icon name="check" size={18} />}
          </button>
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
  const s = useT();
  const t = s;
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
    <Modal
      title={title ?? s.dialogs.renameTitle}
      onClose={onClose}
      footer={
        <>
          <IonButton fill="outline" onClick={onClose}>{s.common.cancel}</IonButton>
          <IonButton disabled={busy || stem.trim() === ''} onClick={() => void save()}>{s.common.save}</IonButton>
        </>
      }
    >
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
        <IonButton className="suggest" fill="clear" size="small" disabled={busy} onClick={() => void suggest()}>
          <Icon name="sparkle" size={16} /> {busy ? s.dialogs.thinking : s.dialogs.suggest}
        </IonButton>
      )}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
