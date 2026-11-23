import {
  IonActionSheet,
  IonButton,
  IonCheckbox,
  IonContent,
  IonFab,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonProgressBar,
} from '@ionic/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { expectExternalActivity } from '../core/appLock';
import { joinName, sanitizeStem, splitName } from '../core/naming';
import { canScanNatively, scanToPdf } from '../core/scanner';
import { useT } from '../i18n';
import { FOLDERS, IMPORT_EXTENSIONS, type Folder, type StoredFile } from '../models';
import { services } from '../services';
import { BreakableName, fmtDate, Header, MoveDialog, Modal, RenameDialog, type OpenFn } from './common';
import { Icon, type IconName } from './icons';
import Thumb from './Thumb';

/** A folder, one of the two special sections, or null for everything. */
type View = Folder | 'favorites' | 'trash' | null;

interface Confirm {
  title: string;
  body: string;
  action: string;
  run: () => Promise<void>;
}

/** A picked file waiting for the user to confirm its name. */
interface Pending {
  file: File;
  stem: string;
  ext: string;
  original: string;
}

export default function Library({ onOpen, version = 0 }: { onOpen: OpenFn; version?: number }) {
  const s = useT();
  const [view, setView] = useState<View>(null);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [special, setSpecial] = useState({ favorites: 0, trash: 0 });
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState('');
  const [moving, setMoving] = useState<StoredFile | null>(null);
  const [renaming, setRenaming] = useState<StoredFile | null>(null);
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [autoName, setAutoName] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  /** The file whose options menu is open. */
  const [menu, setMenu] = useState<StoredFile | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  const { ingest } = services();

  const load = useCallback(async () => {
    const { db } = services();
    setFiles(view === 'favorites' ? await db.favorites() : view === 'trash' ? await db.trash() : await db.files(view ?? undefined));
    setCounts(await db.folderCounts());
    setSpecial(await db.specialCounts());
    // [version] changes when the viewer or Settings may have changed files.
  }, [view, version]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Picked or scanned files wait here so each can be renamed before it is added. */
  const stage = (picked: File[]) => {
    if (picked.length === 0) return;
    setPending(
      picked.map((file) => {
        const { stem, ext } = splitName(file.name);
        return { file, stem, ext, original: stem };
      }),
    );
  };

  const importPending = async () => {
    const items = pending ?? [];
    setPending(null);
    setError('');
    setBusy((b) => b + items.length);
    const failures: string[] = [];
    for (const p of items) {
      const name = joinName(p.stem, p.ext);
      const file = name === p.file.name ? p.file : new File([p.file], name, { type: p.file.type });
      try {
        // Only files the user did not rename by hand are named from their content.
        await ingest.importFile(file, { autoName: autoName && p.stem === p.original });
      } catch (e) {
        failures.push(s.library.importFailed(p.file.name, String(e)));
        setError(failures.join('\n')); // every failure stays listed, not only the last
      }
      setBusy((b) => b - 1);
      await load();
    }
  };

  const fromInput = (el: HTMLInputElement) => {
    const picked = Array.from(el.files ?? []);
    el.value = ''; // allow picking the same file again
    stage(picked);
  };

  /** Android: ML Kit document scanner (camera, crop, multi-page PDF). Elsewhere: camera or file picker. */
  const scan = async () => {
    expectExternalActivity(); // the scanner or camera must not trigger the app lock
    if (!canScanNatively()) {
      camera.current?.click();
      return;
    }
    setError('');
    try {
      const pdf = await scanToPdf();
      if (pdf) stage([pdf]);
    } catch (e) {
      setError(s.library.scanFailed(String(e)));
    }
  };

  /** Runs a file action, then refreshes the list. */
  const act = (fn: () => Promise<void>) => async () => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
    await load();
  };

  const confirmDelete = (f: StoredFile) =>
    setConfirm({
      title: s.library.deleteForeverTitle,
      body: s.library.deleteForeverBody(f.name),
      action: s.library.delete,
      run: () => ingest.deleteForever(f),
    });

  /** The options for [f], shown in its menu. */
  const menuButtons = (f: StoredFile) =>
    view === 'trash'
      ? [
          { text: s.library.restoreLabel, handler: () => void act(() => ingest.restore(f))() },
          { text: s.library.deleteForeverLabel, role: 'destructive', handler: () => confirmDelete(f) },
          { text: s.common.cancel, role: 'cancel' },
        ]
      : [
          { text: s.library.openLabel, handler: () => onOpen(f.id) },
          { text: f.favorite ? s.library.removeFromFavourites : s.library.addToFavourites, handler: () => void act(() => ingest.toggleFavorite(f))() },
          { text: s.viewer.rename, handler: () => setRenaming(f) },
          { text: s.library.moveToFolder, handler: () => setMoving(f) },
          { text: s.library.moveToTrash, role: 'destructive', handler: () => void act(() => ingest.moveToTrash(f))() },
          { text: s.common.cancel, role: 'cancel' },
        ];

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const title = view === 'favorites' ? s.library.favourites : view === 'trash' ? s.library.trash : view ? s.folders[view] : s.library.allDocuments;

  return (
    <>
      <Header title="Kaagaz" />
      {busy > 0 && <IonProgressBar type="indeterminate" />}
      <IonContent>
        <nav className="folders" aria-label={s.library.folders}>
          <FolderChip name={s.library.all} count={total} active={view === null} onClick={() => setView(null)} />
          <FolderChip name={s.library.favourites} icon="star" count={special.favorites} active={view === 'favorites'} onClick={() => setView('favorites')} />
          {FOLDERS.map((f) => (
            <FolderChip key={f} name={s.folders[f]} count={counts[f] ?? 0} active={view === f} onClick={() => setView(f)} />
          ))}
          <FolderChip name={s.library.trash} icon="trash" count={special.trash} active={view === 'trash'} onClick={() => setView('trash')} />
        </nav>

        {error && <p className="error banner" role="alert">{error}</p>}

        <div className="section-head">
          <div>
            <h2>{title}</h2>
            <small>{s.library.count(files.length)}</small>
          </div>
          {view === 'trash' && files.length > 0 && (
            <IonButton
              size="small"
              fill="outline"
              color="danger"
              onClick={() =>
                setConfirm({
                  title: s.library.emptyTrashTitle,
                  body: s.library.emptyTrashBody(files.length),
                  action: s.library.deleteAll,
                  run: () => ingest.emptyTrash(),
                })
              }
            >
              <Icon name="trash" size={16} /> {s.library.emptyTrash}
            </IonButton>
          )}
        </div>

        {files.length === 0 ? (
          <div className="empty-state">
            <Icon name={view === 'trash' ? 'trash' : view === 'favorites' ? 'star' : 'folder'} size={40} />
            <p>{view === 'trash' ? s.library.emptyInTrash : view === 'favorites' ? s.library.emptyFavourites : s.library.emptyFolder}</p>
          </div>
        ) : (
          <IonList inset className="docs" lines="full">
            {files.map((f) => (
              <IonItem key={f.id}>
                <div
                  className="doc-open"
                  role="button"
                  tabIndex={0}
                  aria-label={s.library.open(f.name)}
                  onClick={() => onOpen(f.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen(f.id)}
                >
                  <div className="thumb"><Thumb file={f} /></div>
                  <IonLabel>
                    <h2><BreakableName name={f.name} /></h2>
                    <p className="doc-meta">
                      <span>{s.folders[f.folder]}</span>
                      <span>{fmtDate(f.importedAt)}</span>
                    </p>
                    {(f.locked || f.status === 'needs_review') && (
                      <p className="tags">
                        {f.locked && <span className="tag"><Icon name="lock" size={12} /> {s.library.locked}</span>}
                        {f.status === 'needs_review' && <span className="tag warn">{s.library.needsReview}</span>}
                      </p>
                    )}
                  </IonLabel>
                </div>
                <div slot="end" className="acts">
                  {view === 'trash' ? (
                    <IonButton fill="clear" aria-label={s.library.restore(f.name)} title={s.library.restoreLabel} onClick={act(() => ingest.restore(f))}>
                      <Icon name="undo" size={20} />
                    </IonButton>
                  ) : (
                    <IonButton
                      fill="clear"
                      color={f.favorite ? 'warning' : 'medium'}
                      aria-label={f.favorite ? s.library.removeFavourite(f.name) : s.library.addFavourite(f.name)}
                      title={f.favorite ? s.library.removeFromFavourites : s.library.addToFavourites}
                      aria-pressed={!!f.favorite}
                      onClick={act(() => ingest.toggleFavorite(f))}
                    >
                      <Icon name="star" size={20} filled={!!f.favorite} />
                    </IonButton>
                  )}
                  <IonButton fill="clear" color="medium" aria-label={s.library.moreOptions(f.name)} title={s.library.moreOptions(f.name)} onClick={() => setMenu(f)}>
                    <Icon name="more" size={20} filled />
                  </IonButton>
                </div>
              </IonItem>
            ))}
          </IonList>
        )}

        <IonFab slot="fixed" vertical="bottom" horizontal="end">
          <div className="fabs">
            <IonButton className="fab-btn" color="light" onClick={() => void scan()}>
              <Icon name="scan" size={20} /> {s.library.scan}
            </IonButton>
            <IonButton className="fab-btn" onClick={() => { expectExternalActivity(); input.current?.click(); }}>
              <Icon name="plus" size={20} /> {s.library.import}
            </IonButton>
          </div>
        </IonFab>
      </IonContent>

      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={IMPORT_EXTENSIONS.map((e) => `.${e}`).join(',')}
        onChange={(e) => fromInput(e.target)}
      />
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => fromInput(e.target)} />

      <IonActionSheet
        isOpen={menu !== null}
        header={menu?.name}
        buttons={menu ? menuButtons(menu) : []}
        onDidDismiss={() => setMenu(null)}
      />

      {pending && (
        <Modal
          title={s.library.addFiles(pending.length)}
          onClose={() => setPending(null)}
          footer={
            <>
              <IonButton fill="outline" onClick={() => setPending(null)}>{s.common.cancel}</IonButton>
              <IonButton disabled={pending.some((p) => sanitizeStem(p.stem) === '')} onClick={() => void importPending()}>
                {s.common.add}
              </IonButton>
            </>
          }
        >
          <p className="hint">{s.library.renameHint}</p>
          <div className="stack">
            {pending.map((p, i) => (
              <IonInput
                key={i}
                fill="outline"
                value={p.stem}
                aria-label={s.library.nameFor(p.file.name)}
                onIonInput={(e) => setPending(pending.map((q, j) => (j === i ? { ...q, stem: String(e.detail.value ?? '') } : q)))}
              >
                <span slot="end" className="ext">{p.ext}</span>
              </IonInput>
            ))}
          </div>
          <IonCheckbox className="check" labelPlacement="end" justify="start" checked={autoName} onIonChange={(e) => setAutoName(e.detail.checked)}>
            {s.library.autoName}
            <small>{services().local.isInstalled() ? s.library.autoNameOffline : s.library.autoNameOnline}</small>
          </IonCheckbox>
        </Modal>
      )}
      {renaming && (
        <RenameDialog
          initial={splitName(renaming.name).stem}
          ext={splitName(renaming.name).ext}
          onSave={async (stem) => {
            await ingest.rename(renaming, stem);
            await load();
          }}
          // A suggestion may come from online Gemma, so locked files do not offer it.
          onSuggest={renaming.locked ? undefined : () => ingest.suggestStem(renaming)}
          onClose={() => setRenaming(null)}
        />
      )}
      {moving && <MoveDialog file={moving} onDone={load} onClose={() => setMoving(null)} />}
      {confirm && (
        <Modal
          title={confirm.title}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <IonButton fill="outline" onClick={() => setConfirm(null)}>{s.common.cancel}</IonButton>
              <IonButton
                color="danger"
                onClick={() => {
                  const run = confirm.run;
                  setConfirm(null);
                  void act(run)();
                }}
              >
                {confirm.action}
              </IonButton>
            </>
          }
        >
          <p>{confirm.body}</p>
        </Modal>
      )}
    </>
  );
}

function FolderChip({ name, count, active, icon, onClick }: { name: string; count: number; active: boolean; icon?: IconName; onClick: () => void }) {
  return (
    <button className={active ? 'folder-chip active' : 'folder-chip'} aria-pressed={active} onClick={onClick}>
      {icon && <Icon name={icon} size={15} />}
      <span>{name}</span>
      <span className="count">{count}</span>
    </button>
  );
}
