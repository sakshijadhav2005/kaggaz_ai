import {
  IonButton,
  IonCheckbox,
  IonChip,
  IonContent,
  IonFab,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonProgressBar,
  IonSegment,
  IonSegmentButton,
} from '@ionic/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { expectExternalActivity } from '../core/appLock';
import { joinName, sanitizeStem, splitName } from '../core/naming';
import { canScanNatively, scanToPdf } from '../core/scanner';
import qaCases from '../eval/eval_qa.json';
import { runQaEval, type QaCase, type QaOutcome } from '../eval/qaEval';
import { LANGS, lang, setLang, useT } from '../i18n';
import { getDevApiKey, setDevApiKey, usesProxy } from '../llm/gemini';
import { FOLDERS, IMPORT_EXTENSIONS, type Folder, type StoredFile } from '../models';
import { services } from '../services';
import { BreakableName, Header, MoveDialog, Modal, RenameDialog, type OpenFn } from './common';
import { Icon, type IconName } from './icons';
import BackupPanel from './Backup';
import { CloudSettingsPanel } from './Consent';
import LockSettingsPanel from './LockSettings';
import OfflineModel from './OfflineModel';
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

export default function Library({ onOpen }: { onOpen: OpenFn }) {
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
  const [dialog, setDialog] = useState<'settings' | 'eval' | null>(null);
  const [evalResults, setEvalResults] = useState<QaOutcome[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  const { ingest } = services();

  const load = useCallback(async () => {
    const { db } = services();
    setFiles(view === 'favorites' ? await db.favorites() : view === 'trash' ? await db.trash() : await db.files(view ?? undefined));
    setCounts(await db.folderCounts());
    setSpecial(await db.specialCounts());
  }, [view]);

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
    for (const p of items) {
      const name = joinName(p.stem, p.ext);
      const file = name === p.file.name ? p.file : new File([p.file], name, { type: p.file.type });
      try {
        // Only files the user did not rename by hand are named from their content.
        await ingest.importFile(file, { autoName: autoName && p.stem === p.original });
      } catch (e) {
        setError(s.library.importFailed(p.file.name, String(e)));
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

  const runEval = async () => {
    setDialog('eval');
    setEvalResults(null);
    setEvalResults(await runQaEval(qaCases as QaCase[], (q) => services().answerer.ask(q)));
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const title = view === 'favorites' ? s.library.favourites : view === 'trash' ? s.library.trash : view ? s.folders[view] : s.library.allDocuments;

  return (
    <>
      <Header title="Kaagaz">
        <IonButton aria-label={s.library.runEval} onClick={runEval}><Icon name="check" /></IonButton>
        <IonButton aria-label={s.library.settings} onClick={() => setDialog('settings')}><Icon name="gear" /></IonButton>
      </Header>
      {busy > 0 && <IonProgressBar type="indeterminate" />}
      <IonContent>
        {error && <p className="error ion-padding">{error}</p>}

        <div className="folders">
          <FolderCard name={s.library.all} count={total} active={view === null} onClick={() => setView(null)} />
          <FolderCard name={s.library.favourites} icon="star" count={special.favorites} active={view === 'favorites'} onClick={() => setView('favorites')} />
          {FOLDERS.map((f) => (
            <FolderCard key={f} name={s.folders[f]} count={counts[f] ?? 0} active={view === f} onClick={() => setView(f)} />
          ))}
          <FolderCard name={s.library.trash} icon="trash" count={special.trash} active={view === 'trash'} onClick={() => setView('trash')} />
        </div>

        <div className="section-head">
          <h2 className="label">{title}</h2>
          {view === 'trash' && files.length > 0 && (
            <IonButton
              size="small"
              fill="clear"
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
              {s.library.emptyTrash}
            </IonButton>
          )}
        </div>
        {files.length === 0 ? (
          <p className="empty">
            {view === 'trash' ? s.library.emptyInTrash : view === 'favorites' ? s.library.emptyFavourites : s.library.emptyFolder}
          </p>
        ) : (
          <IonList inset className="docs">
            {files.map((f) => (
              <IonItem key={f.id} lines="full">
                <div slot="start" className="thumb"><Thumb file={f} /></div>
                <IonLabel className="doc-open" role="button" tabIndex={0} aria-label={s.library.open(f.name)} onClick={() => onOpen(f.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(f.id)}>
                  <h2><BreakableName name={f.name} /></h2>
                  <p>
                    {s.folders[f.folder]}
                    {f.locked && <span className="badge"> · <Icon name="lock" size={11} /> {s.library.locked}</span>}
                    {f.status === 'needs_review' && <span className="badge"> · {s.library.needsReview}</span>}
                  </p>
                </IonLabel>
                <div slot="end" className="acts">
                  {view === 'trash' ? (
                    <>
                      <IonButton fill="clear" aria-label={s.library.restore(f.name)} onClick={act(() => ingest.restore(f))}>
                        <Icon name="undo" size={17} />
                      </IonButton>
                      <IonButton
                        fill="clear"
                        color="danger"
                        aria-label={s.library.deleteForever(f.name)}
                        onClick={() =>
                          setConfirm({
                            title: s.library.deleteForeverTitle,
                            body: s.library.deleteForeverBody(f.name),
                            action: s.library.delete,
                            run: () => ingest.deleteForever(f),
                          })
                        }
                      >
                        <Icon name="trash" size={17} />
                      </IonButton>
                    </>
                  ) : (
                    <>
                      <IonButton
                        fill="clear"
                        color={f.favorite ? 'warning' : 'medium'}
                        aria-label={f.favorite ? s.library.removeFavourite(f.name) : s.library.addFavourite(f.name)}
                        aria-pressed={!!f.favorite}
                        onClick={act(() => ingest.toggleFavorite(f))}
                      >
                        <Icon name="star" size={17} filled={!!f.favorite} />
                      </IonButton>
                      <IonButton fill="clear" aria-label={s.library.rename(f.name)} onClick={() => setRenaming(f)}>
                        <Icon name="rename" size={17} />
                      </IonButton>
                      <IonButton fill="clear" aria-label={s.library.move(f.name)} onClick={() => setMoving(f)}>
                        <Icon name="move" size={17} />
                      </IonButton>
                      <IonButton fill="clear" color="danger" aria-label={s.library.toTrash(f.name)} onClick={act(() => ingest.moveToTrash(f))}>
                        <Icon name="trash" size={17} />
                      </IonButton>
                    </>
                  )}
                </div>
              </IonItem>
            ))}
          </IonList>
        )}

        <IonFab slot="fixed" vertical="bottom" horizontal="end">
          <div className="fabs">
            <IonButton shape="round" fill="outline" onClick={() => void scan()}><Icon name="scan" size={18} /> {s.library.scan}</IonButton>
            <IonButton shape="round" onClick={() => { expectExternalActivity(); input.current?.click(); }}><Icon name="plus" size={18} /> {s.library.import}</IonButton>
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
      {pending && (
        <Modal title={s.library.addFiles(pending.length)} onClose={() => setPending(null)}>
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
          <div className="actions">
            <IonButton fill="outline" onClick={() => setPending(null)}>{s.common.cancel}</IonButton>
            <IonButton disabled={pending.some((p) => sanitizeStem(p.stem) === '')} onClick={() => void importPending()}>
              {s.common.add}
            </IonButton>
          </div>
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
          onSuggest={() => ingest.suggestStem(renaming)}
          onClose={() => setRenaming(null)}
        />
      )}
      {moving && <MoveDialog file={moving} onDone={load} onClose={() => setMoving(null)} />}
      {confirm && (
        <Modal title={confirm.title} onClose={() => setConfirm(null)}>
          <p>{confirm.body}</p>
          <div className="actions">
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
          </div>
        </Modal>
      )}
      {dialog === 'settings' && <Settings onClose={() => { setDialog(null); void load(); }} />}
      {dialog === 'eval' && (
        <Modal title={evalResults ? s.library.evalResult(evalResults.filter((r) => r.passed).length, evalResults.length) : s.library.evalRunning} onClose={() => setDialog(null)}>
          <IonList>
            {evalResults?.map((r, i) => (
              <IonItem key={i}>
                <span slot="start">{r.passed ? '✓' : '✗'}</span>
                <IonLabel className="ion-text-wrap">
                  <h3>{r.testCase.question}</h3>
                  <p>{r.answer.slice(0, 200)}</p>
                </IonLabel>
              </IonItem>
            ))}
          </IonList>
        </Modal>
      )}
    </>
  );
}

function FolderCard({ name, count, active, icon, onClick }: { name: string; count: number; active: boolean; icon?: IconName; onClick: () => void }) {
  return (
    <IonChip outline={!active} color="primary" onClick={onClick} aria-pressed={active}>
      {icon && <Icon name={icon} size={13} />}
      <IonLabel>{name} · {count}</IonLabel>
    </IonChip>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  const s = useT();
  const [key, setKey] = useState(getDevApiKey());
  // Release builds use the Kaagaz server and have no key to enter.
  const proxy = usesProxy();
  return (
    <Modal title={s.settings.title} onClose={onClose}>
      <section className="lang-settings">
        <h2>{s.settings.language}</h2>
        <IonSegment value={lang()} onIonChange={(e) => setLang(e.detail.value === 'hi' ? 'hi' : 'en')} aria-label={s.settings.language}>
          {LANGS.map((l) => (
            <IonSegmentButton key={l.id} value={l.id} lang={l.id}>
              {l.label}
            </IonSegmentButton>
          ))}
        </IonSegment>
      </section>
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
      <CloudSettingsPanel />
      <OfflineModel model={services().local} variant="panel" />
      <LockSettingsPanel />
      <BackupPanel />
      <div className="actions">
        <IonButton
          onClick={() => {
            if (!proxy) setDevApiKey(key);
            void services().embedMissing(); // files imported before the key was set become answerable
            onClose();
          }}
        >
          {s.common.save}
        </IonButton>
      </div>
    </Modal>
  );
}
