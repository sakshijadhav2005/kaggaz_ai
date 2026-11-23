import { IonButton, IonButtons, IonContent, IonHeader, IonModal, IonProgressBar, IonTextarea, IonTitle, IonToolbar } from '@ionic/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticate, lockUnavailableReason } from '../core/appLock';
import { splitName } from '../core/naming';
import { closePdf, openPdf, renderPage } from '../extract/pdfLib';
import { useT } from '../i18n';
import type { StoredFile } from '../models';
import { services } from '../services';
import { MoveDialog, Modal, RenameDialog } from './common';
import { Icon, type IconName } from './icons';

interface Props {
  fileId: string;
  page?: number; // 1-based, from a citation
  onClose: () => void;
}

export default function Viewer({ fileId, page, onClose }: Props) {
  const s = useT();
  const [file, setFile] = useState<StoredFile | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  /** A locked file stays closed until the fingerprint or screen lock says yes. */
  const [sealed, setSealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'move' | 'edit' | 'rename' | null>(null);
  const [draft, setDraft] = useState('');

  const { ingest, db } = services();
  const reload = async () => setFile((await db.getFile(fileId)) ?? null);

  const openContent = useCallback(async (f: StoredFile) => {
    setError('');
    if (f.locked) {
      try {
        await authenticate(s.viewer.unlockReason(f.name));
      } catch {
        setSealed(true);
        return;
      }
    }
    setSealed(false);
    try {
      setBlob(await services().read(f));
    } catch (e) {
      setError(s.viewer.openFailed(String(e)));
    }
  }, [s]);

  useEffect(() => {
    void (async () => {
      const f = await services().db.getFile(fileId);
      if (!f) return;
      setFile(f);
      await openContent(f);
    })();
    // Only on open: changing the language must not ask for the fingerprint again.
  }, [fileId]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Both directions need the fingerprint or screen lock, so nobody can quietly remove a lock. */
  const toggleLock = (f: StoredFile) =>
    run(async () => {
      if (await lockUnavailableReason()) throw new Error(s.viewer.lockUnavailable);
      await authenticate(f.locked ? s.viewer.unlockReasonRemove(f.name) : s.viewer.lockReason(f.name));
      await db.setLocked(f.id, !f.locked);
    });

  if (!file) return null;

  const inTrash = !!file.deletedAt;
  const locked = !!file.locked;
  type Tool = { id: string; icon: IconName; label: string; on?: boolean; danger?: boolean; click: () => void };
  const tools: Tool[] = inTrash
    ? [{ id: 'restore', icon: 'undo', label: s.viewer.restore, click: () => void run(() => ingest.restore(file)) }]
    : sealed
      ? []
      : [
          { id: 'fav', icon: 'star', label: s.viewer.favourite, on: !!file.favorite, click: () => void run(() => ingest.toggleFavorite(file)) },
          { id: 'lock', icon: 'lock', label: locked ? s.viewer.unlock : s.viewer.lock, on: locked, click: () => void toggleLock(file) },
          { id: 'rename', icon: 'rename', label: s.viewer.rename, click: () => setDialog('rename') },
          { id: 'move', icon: 'move', label: s.viewer.move, click: () => setDialog('move') },
          { id: 'text', icon: 'edit', label: s.viewer.text, click: () => { setDraft(file.text); setDialog('edit'); } },
          // Reading again may use online AI (sorting, OCR fallback), which a locked file must never reach.
          ...(locked ? [] : [{ id: 'retry', icon: 'refresh' as IconName, label: s.viewer.retry, click: () => void run(() => ingest.process(file)) }]),
          {
            id: 'trash',
            icon: 'trash',
            label: s.viewer.trash,
            danger: true,
            click: () => void (async () => {
              await ingest.moveToTrash(file);
              onClose();
            })(),
          },
        ];

  return (
    <IonModal isOpen onDidDismiss={onClose}>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonButton onClick={onClose} aria-label={s.common.close}><Icon name="back" /></IonButton>
          </IonButtons>
          <IonTitle className="ellipsis">{file.name}</IonTitle>
        </IonToolbar>
        {tools.length > 0 && (
          <div className="viewer-actions" role="toolbar" aria-label={s.viewer.actions}>
            {tools.map((t) => (
              <button
                key={t.id}
                className={`viewer-action${t.on ? ' on' : ''}${t.danger ? ' danger' : ''}`}
                aria-pressed={t.id === 'fav' || t.id === 'lock' ? !!t.on : undefined}
                disabled={busy}
                onClick={t.click}
              >
                <Icon name={t.icon} size={20} filled={t.on && t.id === 'fav'} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        )}
        {busy && <IonProgressBar type="indeterminate" />}
      </IonHeader>
      <IonContent className="ion-padding">
        <p className="meta tags">
          <span>{s.viewer.folder(s.folders[file.folder], s.source[file.source] ?? file.source)}</span>
          {inTrash && <span className="tag danger">{s.viewer.inTrash}</span>}
          {locked && <span className="tag"><Icon name="lock" size={12} /> {s.viewer.lockedBadge}</span>}
          {file.status === 'needs_review' && <span className="tag warn">{s.viewer.needsReview}</span>}
        </p>
        {locked && !sealed && <p className="hint">{s.viewer.lockHint}</p>}
        {error && <p className="error">{error}</p>}
        {sealed ? (
          <div className="sealed">
            <Icon name="lock" size={40} />
            <p>{s.viewer.stillLocked}</p>
            <IonButton onClick={() => void openContent(file)}>{s.lock.unlock}</IonButton>
          </div>
        ) : (
          <>
            {blob && file.type === 'pdf' && <PdfView blob={blob} page={page} />}
            {blob && file.type === 'image' && <ImageView blob={blob} />}
            {blob && file.type === 'audio' && <AudioView blob={blob} />}
            {file.type === 'other' && <p className="empty">{s.viewer.noPreview}</p>}
            {(file.type === 'audio' || file.type === 'other') && file.text.trim() !== '' && (
              <section className="panel transcript">
                <h2>{s.viewer.extractedText}</h2>
                <p>{file.text}</p>
              </section>
            )}
          </>
        )}
      </IonContent>

      {dialog === 'move' && <MoveDialog file={file} onDone={reload} onClose={() => setDialog(null)} />}
      {dialog === 'rename' && (
        <RenameDialog
          initial={splitName(file.name).stem}
          ext={splitName(file.name).ext}
          onSave={async (stem) => {
            await ingest.rename(file, stem);
            await reload();
          }}
          // A suggestion may come from online Gemma, so locked files do not offer it.
          onSuggest={locked ? undefined : () => ingest.suggestStem(file)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'edit' && (
        <Modal
          title={s.viewer.extractedText}
          size="full"
          onClose={() => setDialog(null)}
          footer={
            <>
              <IonButton fill="outline" onClick={() => setDialog(null)}>{s.common.cancel}</IonButton>
              <IonButton
                onClick={() => {
                  setDialog(null);
                  void run(() => ingest.replaceText(file, draft));
                }}
              >
                {s.common.save}
              </IonButton>
            </>
          }
        >
          <IonTextarea fill="outline" value={draft} onIonInput={(e) => setDraft(String(e.detail.value ?? ''))} autoGrow rows={14} aria-label={s.viewer.extractedText} />
        </Modal>
      )}
    </IonModal>
  );
}

/** Plays an imported recording. */
function AudioView({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <audio className="audio" controls src={url} /> : null;
}

function ImageView({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} alt="" className="img" /> : null;
}

/** Renders every page; scrolls to [page] when given. */
function PdfView({ blob, page }: { blob: Blob; page?: number }) {
  const s = useT();
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | undefined;
    const el = host.current;
    void (async () => {
      try {
        const doc = await openPdf(blob);
        destroy = () => closePdf(doc);
        if (cancelled) return;
        for (let n = 1; n <= doc.numPages; n++) {
          const canvas = await renderPage(doc, n, 1.5);
          if (cancelled) return;
          el?.appendChild(canvas);
          if (n === page) canvas.scrollIntoView();
        }
      } catch (e) {
        if (!cancelled) setError(s.viewer.renderFailed(String(e)));
      }
    })();
    return () => {
      cancelled = true;
      el?.replaceChildren();
      void destroy?.();
    };
  }, [blob, page, s]);

  return (
    <>
      {error && <p className="error">{error}</p>}
      <div ref={host} className="pdf" />
    </>
  );
}
