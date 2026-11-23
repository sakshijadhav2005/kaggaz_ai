import { IonButton, IonContent, IonFooter, IonInput, IonProgressBar, IonToolbar } from '@ionic/react';
import { Fragment, useRef, useState, type FormEvent } from 'react';

import { runAgent, runConfirmed, type Turn } from '../agent/agent';
import type { ActionContext, AppTab } from '../agent/registry';
import { actionsFor, matchSkills } from '../agent/skills';
import type { Citation } from '../answer/answerer';
import { searchContent } from '../answer/contentSearch';
import { listen, stopListening, VoiceError, voiceSupported } from '../core/voice';
import { lang, strings, useT } from '../i18n';
import { hostedAllowed } from '../llm/gemini';
import type { StoredFile } from '../models';
import { folderForQuery, isFileRequest, isQuestion } from '../search/folderSearch';
import { searchSnippets, variantsOf, type SnippetHit } from '../search/snippets';
import { isOnline, services } from '../services';
import { Header, type OpenFn } from './common';
import { FileGlyph, Icon } from './icons';
import OfflineModel from './OfflineModel';

interface Message {
  user: boolean;
  text: string;
  files?: StoredFile[];
  citations?: Citation[];
  snippets?: SnippetHit[];
  /** An action waiting for the user's yes or no. */
  confirm?: { actionId: string; args: unknown; state: 'pending' | 'done' | 'cancelled' };
  /** Set on assistant replies from the command agent: its actions, and whether it asked the user something. */
  agent?: { actionIds: string[]; asked: boolean };
}

// Kept outside the component so history survives tab switches.
const history: Message[] = [];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Wraps the query words found in [text] in <mark>. */
function Highlight({ text, words }: { text: string; words: string[] }) {
  const variants = words.flatMap(variantsOf);
  if (variants.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${variants.map(escapeRe).join('|')})`, 'gi'));
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

export default function Chat({ onOpen, onTab }: { onOpen: OpenFn; onTab: (tab: AppTab) => void }) {
  const s = useT();
  const [messages, setMessages] = useState<Message[]>(history);
  const [listening, setListening] = useState(false);
  const [voiceNote, setVoiceNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const content = useRef<HTMLIonContentElement>(null);
  const ctx: ActionContext = { openFile: onOpen, openTab: onTab };

  const push = (m: Message) => {
    history.push(m);
    setMessages([...history]);
    setTimeout(() => void content.current?.scrollToBottom(250), 0);
  };

  /** "Move my PAN card to Study": Gemma 4 picks actions from the registry; the app runs them. */
  const runCommand = async (q: string, actionIds: string[], earlier: Message[]): Promise<Message> => {
    const { llm, actions } = services();
    if (!llm.available()) {
      return { user: false, text: s.chat.needModel };
    }
    const turns: Turn[] = earlier.slice(-6).map((m) => ({
      role: m.user ? 'user' : 'assistant',
      text: m.text,
      files: m.files?.map((f) => ({ id: f.id, name: f.name })),
    }));
    const out = await runAgent(q, { llm, registry: actions, ctx, actionIds, history: turns });
    if (out.kind === 'confirm') {
      return { user: false, text: out.question, files: out.files, confirm: { actionId: out.actionId, args: out.args, state: 'pending' }, agent: { actionIds, asked: false } };
    }
    return { user: false, text: out.text, files: out.files, agent: { actionIds, asked: out.text.trim().endsWith('?') } };
  };

  const decide = async (m: Message, ok: boolean) => {
    if (!m.confirm || m.confirm.state !== 'pending' || busy) return;
    m.confirm.state = ok ? 'done' : 'cancelled';
    setMessages([...history]);
    if (!ok) {
      push({ user: false, text: s.chat.cancelledReply });
      return;
    }
    setBusy(true);
    try {
      push({ user: false, text: await runConfirmed(services().actions, m.confirm.actionId, m.confirm.args, ctx) });
    } finally {
      setBusy(false);
    }
  };

  /** "Give me Aadhaar card": the folder's files. */
  const findFiles = async (q: string): Promise<Message> => {
    const folder = folderForQuery(q)!;
    const all = await services().db.files(folder);
    // Locked documents are not listed in the conversation; the Library shows them behind the lock.
    const files = all.filter((f) => !f.locked);
    const lockedNote = all.length > files.length ? `\n${s.chat.lockedSkipped(all.length - files.length)}` : '';
    if (files.length === 0) return { user: false, text: s.chat.noFilesIn(s.folders[folder]) + lockedNote };
    return { user: false, text: s.chat.found(files.length) + lockedNote, files };
  };

  /**
   * Anything else is a question about the content. Gemma answers when it can;
   * otherwise (no key, offline, or nothing found) the matching passages are
   * shown directly. Either way the file and page are named.
   */
  const answerContent = async (q: string): Promise<Message> => {
    const { db, answerer, embedMissing, general, local } = services();
    const result = await searchContent(q, {
      online: isOnline(),
      hasKey: hostedAllowed(),
      localReady: local.isInstalled(),
      askHosted: async (question) => {
        await embedMissing();
        return answerer.ask(question);
      },
      findPassages: async (question) => searchSnippets(question, await db.searchableChunks()),
      askFromPassages: (question, hits) => answerer.askFromPassages(question, hits),
      general,
    }, strings().search);
    return { user: false, ...result };
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || busy) return;
    setInput('');
    const earlier = [...history];
    push({ user: true, text: q });
    setBusy(true);
    try {
      // A command, or the answer to a question the command agent just asked ("the second one").
      const skills = matchSkills(q);
      const lastReply = [...earlier].reverse().find((m) => !m.user);
      const followUp = lastReply?.agent?.asked && !isQuestion(q) ? lastReply.agent.actionIds : null;
      if (skills.length > 0 || followUp) push(await runCommand(q, skills.length > 0 ? actionsFor(skills) : followUp!, earlier));
      else push(isFileRequest(q) ? await findFiles(q) : await answerContent(q));
    } catch (err) {
      push({ user: false, text: s.common.error(String(err)) });
    } finally {
      setBusy(false);
    }
  };

  /** Fills the box with what was said. Nothing is sent until the user taps Send. */
  const speak = async () => {
    if (listening) {
      await stopListening();
      return;
    }
    setVoiceNote('');
    setListening(true);
    try {
      setInput(await listen(lang()));
    } catch (e) {
      setVoiceNote(e instanceof VoiceError ? s.voice[e.problem] : s.common.error(String(e)));
    } finally {
      setListening(false);
    }
  };

  return (
    <>
      <Header title={s.chat.title} />
      <IonContent ref={content}>
      <OfflineModel model={services().local} variant="banner" />
      <div className="messages">
        {messages.length === 0 && (
          <p className="empty">{s.chat.empty}</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.user ? 'bubble user' : 'bubble'}>
            <p>{m.text}</p>
            {m.files?.map((f) => (
              <button key={f.id} className="row" onClick={() => onOpen(f.id)}>
                <FileGlyph type={f.type} size={26} />
                <span className="grow"><strong>{f.name}</strong><small>{s.folders[f.folder]}</small></span>
              </button>
            ))}
            {m.snippets?.map((h, j) => (
              <button key={j} className="hit" onClick={() => onOpen(h.fileId, h.page)}>
                <strong>{h.fileName}</strong>
                <small>{s.folders[h.folder as keyof typeof s.folders] ?? h.folder}{h.page ? ` · ${s.common.page(h.page)}` : ''}</small>
                <span><Highlight text={h.snippet} words={h.matched} /></span>
              </button>
            ))}
            {m.confirm && (
              <div className="actions">
                {m.confirm.state === 'pending' ? (
                  <>
                    <IonButton fill="outline" disabled={busy} onClick={() => void decide(m, false)}>{s.common.cancel}</IonButton>
                    <IonButton disabled={busy} onClick={() => void decide(m, true)}>{s.common.confirm}</IonButton>
                  </>
                ) : (
                  <small>{m.confirm.state === 'done' ? s.chat.confirmed : s.chat.cancelled}</small>
                )}
              </div>
            )}
            {m.citations && m.citations.length > 0 && (
              <div className="cites">
                <small>{s.chat.source}</small>
                {m.citations.map((c) => (
                  <button key={`${c.fileId}:${c.page}`} className="chip" onClick={() => onOpen(c.fileId, c.page)}>
                    {c.fileName} · {s.folders[c.folder as keyof typeof s.folders] ?? c.folder}{c.page ? ` · ${s.common.pageShort(c.page)}` : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      </IonContent>
      <IonFooter>
        {busy && <IonProgressBar type="indeterminate" />}
        {(listening || voiceNote) && <p className="voice-note" role="status">{listening ? s.voice.listening : voiceNote}</p>}
        <IonToolbar>
          <form className="composer" onSubmit={send}>
            {voiceSupported() && (
              <IonButton
                color="primary"
                fill={listening ? 'solid' : 'outline'}
                className={listening ? 'mic listening' : 'mic'}
                aria-label={listening ? s.voice.stop : s.voice.start}
                aria-pressed={listening}
                disabled={busy}
                onClick={() => void speak()}
              >
                <Icon name="mic" size={18} />
              </IonButton>
            )}
            <IonInput
              fill="outline"
              value={input}
              onIonInput={(e) => setInput(String(e.detail.value ?? ''))}
              placeholder={s.chat.placeholder}
              aria-label={s.chat.placeholder}
            />
            <IonButton color="primary" type="submit" disabled={busy || listening}><Icon name="send" size={18} /> {s.chat.send}</IonButton>
          </form>
        </IonToolbar>
      </IonFooter>
    </>
  );
}
