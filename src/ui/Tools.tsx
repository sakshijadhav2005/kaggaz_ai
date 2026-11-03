import { IonButton, IonContent, IonInput, IonProgressBar, IonSelect, IonSelectOption } from '@ionic/react';
import { useEffect, useState } from 'react';

import { useT, type Strings } from '../i18n';
import type { StoredFile } from '../models';
import type { CompressLevel, PdfTools } from '../pdf/pdfTools';
import { services } from '../services';
import { Header, Modal, type OpenFn } from './common';
import { FileGlyph, Icon } from './icons';

type Input = 'pdfs' | 'pdf' | 'images';
type Field = 'pages' | 'pagesOptional' | 'angle' | 'text' | 'level' | 'name';

type ToolId = 'merge' | 'images' | 'compress' | 'extract' | 'split' | 'delete' | 'rotate' | 'watermark' | 'numbers';

interface Tool {
  id: ToolId;
  input: Input;
  fields: Field[];
  run: (pdf: PdfTools, ids: string[], o: Options) => Promise<StoredFile[]>;
}

interface Options {
  pages: string;
  angle: '90' | '180' | '270';
  text: string;
  level: CompressLevel;
  name: string;
}

const DEFAULTS: Options = { pages: '', angle: '90', text: '', level: 'balanced', name: '' };

const TOOLS: Tool[] = [
  { id: 'merge', input: 'pdfs', fields: ['name'], run: (p, ids, o) => p.merge(ids, o.name || undefined) },
  { id: 'images', input: 'images', fields: ['name'], run: (p, ids, o) => p.imagesToPdf(ids, o.name || undefined) },
  { id: 'compress', input: 'pdf', fields: ['level'], run: (p, [id], o) => p.compress(id, o.level) },
  { id: 'extract', input: 'pdf', fields: ['pages'], run: (p, [id], o) => p.extractPages(id, o.pages) },
  { id: 'split', input: 'pdf', fields: ['pagesOptional'], run: (p, [id], o) => p.split(id, o.pages || undefined) },
  { id: 'delete', input: 'pdf', fields: ['pages'], run: (p, [id], o) => p.deletePages(id, o.pages) },
  { id: 'rotate', input: 'pdf', fields: ['angle', 'pagesOptional'], run: (p, [id], o) => p.rotate(id, Number(o.angle) as 90 | 180 | 270, o.pages || undefined) },
  { id: 'watermark', input: 'pdf', fields: ['text'], run: (p, [id], o) => p.watermark(id, o.text) },
  { id: 'numbers', input: 'pdf', fields: [], run: (p, [id]) => p.addPageNumbers(id) },
];

/** [title, hint] in the current language. */
const text = (s: Strings, t: Tool) => s.tools[t.id] as string[];

export default function Tools({ onOpen }: { onOpen: OpenFn }) {
  const s = useT();
  const [tool, setTool] = useState<Tool | null>(null);
  return (
    <>
      <Header title={s.tools.title} />
      <IonContent className="ion-padding">
        <p className="hint">{s.tools.intro}</p>
        <div className="tool-grid">
          {TOOLS.map((t) => (
            <button key={t.id} className="card tool-card" onClick={() => setTool(t)}>
              <Icon name={t.input === 'images' ? 'image' : 'pdf'} />
              <strong>{text(s, t)[0]}</strong>
              <small>{text(s, t)[1]}</small>
            </button>
          ))}
        </div>
      </IonContent>
      {tool && <ToolSheet key={tool.id} tool={tool} onOpen={onOpen} onClose={() => setTool(null)} />}
    </>
  );
}

function ToolSheet({ tool, onOpen, onClose }: { tool: Tool; onOpen: OpenFn; onClose: () => void }) {
  const s = useT();
  const [title, hint] = text(s, tool);
  const [docs, setDocs] = useState<StoredFile[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [o, setO] = useState<Options>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<StoredFile[] | null>(null);
  const multi = tool.input !== 'pdf';
  const kind = tool.input === 'images' ? 'image' : 'pdf';

  useEffect(() => {
    void services().db.files().then((all) => setDocs(all.filter((f) => f.type === kind && !f.locked)));
  }, [kind]);

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : multi ? [...p, id] : [id]));

  const needs = tool.input === 'pdfs' ? 2 : 1;
  const missing = picked.length < needs || (tool.fields.includes('pages') && !o.pages.trim()) || (tool.fields.includes('text') && !o.text.trim());

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setMade(await tool.run(services().pdf, picked, o));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof Options>(k: K, v: Options[K]) => setO((x) => ({ ...x, [k]: v }));

  if (made) {
    return (
      <Modal title={title} onClose={onClose}>
        <p>{s.tools.done(made.length)}</p>
        {made.map((f) => (
          <button key={f.id} className="row" onClick={() => { onClose(); onOpen(f.id); }}>
            <FileGlyph type={f.type} size={26} />
            <span className="grow"><strong>{f.name}</strong><small>{s.folders[f.folder]} · {s.tools.tapToOpen}</small></span>
          </button>
        ))}
        <div className="actions">
          <IonButton fill="outline" onClick={() => { setMade(null); setPicked([]); }}>{s.tools.another}</IonButton>
          <IonButton onClick={onClose}>{s.common.close}</IonButton>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose}>
      <p className="hint">{hint}</p>
      <h2 className="tool-step">{multi ? s.tools.pickMany(kind === 'image') : s.tools.pickOne}</h2>
      {docs.length === 0 && <p className="empty">{s.tools.none(kind === 'image')}</p>}
      <div className="tool-picker" role="listbox" aria-multiselectable={multi}>
        {docs.map((f) => {
          const n = picked.indexOf(f.id);
          return (
            <button key={f.id} className={`row${n >= 0 ? ' picked' : ''}`} role="option" aria-selected={n >= 0} onClick={() => toggle(f.id)}>
              <span className="pick-mark" aria-hidden>{n >= 0 ? (multi ? n + 1 : '✓') : ''}</span>
              <FileGlyph type={f.type} size={22} />
              <span className="grow"><strong>{f.name}</strong><small>{s.folders[f.folder]}</small></span>
            </button>
          );
        })}
      </div>

      {tool.fields.includes('pages') && <Field label={s.tools.pages} value={o.pages} placeholder={s.tools.pagesPlaceholder} onChange={(v) => set('pages', v)} />}
      {tool.fields.includes('pagesOptional') && <Field label={s.tools.pagesOptional} value={o.pages} placeholder={s.tools.rangesPlaceholder} onChange={(v) => set('pages', v)} />}
      {tool.fields.includes('text') && <Field label={s.tools.watermarkText} value={o.text} placeholder={s.tools.watermarkPlaceholder} onChange={(v) => set('text', v)} />}
      {tool.fields.includes('name') && <Field label={s.tools.newName} value={o.name} placeholder={s.tools.newNamePlaceholder} onChange={(v) => set('name', v)} />}
      {tool.fields.includes('angle') && (
        <IonSelect label={s.tools.turn} interface="popover" value={o.angle} onIonChange={(e) => set('angle', e.detail.value)}>
          <IonSelectOption value="90">{s.tools.cw}</IonSelectOption>
          <IonSelectOption value="180">{s.tools.half}</IonSelectOption>
          <IonSelectOption value="270">{s.tools.ccw}</IonSelectOption>
        </IonSelect>
      )}
      {tool.fields.includes('level') && (
        <IonSelect label={s.tools.level} interface="popover" value={o.level} onIonChange={(e) => set('level', e.detail.value)}>
          <IonSelectOption value="balanced">{s.tools.balanced}</IonSelectOption>
          <IonSelectOption value="strong">{s.tools.strong}</IonSelectOption>
        </IonSelect>
      )}

      {error && <p className="lock-error" role="alert">{error}</p>}
      {busy && <IonProgressBar type="indeterminate" />}
      <div className="actions">
        <IonButton disabled={busy || missing} onClick={() => void run()}>{busy ? s.common.working : title}</IonButton>
      </div>
    </Modal>
  );
}

function Field({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  return (
    <IonInput
      label={label}
      labelPlacement="stacked"
      fill="outline"
      value={value}
      placeholder={placeholder}
      onIonInput={(e) => onChange(String(e.detail.value ?? ''))}
      className="tool-field"
    />
  );
}
