import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { FieldCipher } from '../src/core/crypto';
import { Db } from '../src/core/db';
import { IngestService } from '../src/core/ingestService';
import { AudioExtractor, MAX_AUDIO_BYTES, NO_SPEECH } from '../src/extract/audioExtractor';
import { Indexer } from '../src/index/indexer';
import type { Transcriber, VaultStore } from '../src/interfaces';
import type { StoredFile } from '../src/models';
import { RuleClassifier, type RuleJson } from '../src/sort/ruleClassifier';
import rulesJson from '../src/sort/rules.json';
import { SmartSorter } from '../src/sort/smartSorter';

const stored = (over: Partial<StoredFile> = {}): StoredFile => ({
  id: 'a1', name: 'note.m4a', type: 'audio', path: 'p', folder: 'Unsorted', status: 'processing', source: 'rule',
  language: 'en', importedAt: 1, text: '', ...over,
});

/** Records what was sent, and replies with [reply]. */
function fakeTranscriber(reply: string | (() => never)) {
  const sent: { base64: string; mime: string }[] = [];
  const t: Transcriber = {
    transcribe: async (base64, mime) => {
      sent.push({ base64, mime });
      return typeof reply === 'string' ? reply : reply();
    },
  };
  return { t, sent };
}

describe('AudioExtractor', () => {
  const blob = (n = 4) => new Blob([new Uint8Array(n).fill(65)]);

  it('only handles audio files', () => {
    const x = new AudioExtractor(async () => blob(), () => true, fakeTranscriber('').t);
    expect(x.canHandle(stored())).toBe(true);
    expect(x.canHandle(stored({ type: 'pdf' }))).toBe(false);
  });

  it('sends the recording with its type and returns one passage', async () => {
    const { t, sent } = fakeTranscriber('  बिजली का बिल 1840 रुपये, आख़िरी तारीख़ 10 तारीख़  ');
    const segs = await new AudioExtractor(async () => blob(), () => true, t).extract(stored());
    expect(sent).toEqual([{ base64: 'QUFBQQ==', mime: 'audio/mp4' }]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ startMs: 0, method: 'audio_transcript', language: 'hi', text: 'बिजली का बिल 1840 रुपये, आख़िरी तारीख़ 10 तारीख़' });
  });

  it('sends nothing when offline, without consent, for a locked file, or over the size cap', async () => {
    const { t, sent } = fakeTranscriber('text');
    expect(await new AudioExtractor(async () => blob(), () => false, t).extract(stored())).toEqual([]);
    expect(await new AudioExtractor(async () => blob(), () => true, t).extract(stored({ locked: true }))).toEqual([]);
    expect(await new AudioExtractor(async () => blob(MAX_AUDIO_BYTES + 1), () => true, t).extract(stored())).toEqual([]);
    expect(await new AudioExtractor(async () => blob(0), () => true, t).extract(stored())).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('treats silence as no text', async () => {
    const x = new AudioExtractor(async () => blob(), () => true, fakeTranscriber(NO_SPEECH).t);
    expect(await x.extract(stored())).toEqual([]);
  });
});

const cipher = await FieldCipher.fromRawKey(FieldCipher.generateRawKey());

describe('audio through the import pipeline', () => {

  function build(transcriber: Transcriber) {
    const files = new Map<string, Blob>();
    const vault: VaultStore = {
      store: async (data, _name, id, folder) => {
        const path = `vault/${folder}/${id}`;
        files.set(path, data);
        return path;
      },
      move: async (path, folder) => {
        const dest = `vault/${folder}/${path.split('/').pop()}`;
        files.set(dest, files.get(path)!);
        if (dest !== path) files.delete(path);
        return dest;
      },
      read: async (path) => files.get(path)!,
      remove: async (path) => void files.delete(path),
    };
    const db = new Db(cipher, `audio-${Math.random()}`);
    const read = (f: StoredFile) => vault.read(f.path, f.name);
    const ingest = new IngestService(
      vault, db, [new AudioExtractor(read, () => true, transcriber)],
      new SmartSorter(new RuleClassifier(rulesJson as RuleJson[]), () => false),
      new Indexer(db, { embed: async () => [1, 0] }),
    );
    return { db, ingest };
  }

  it('sorts a voice note by what was said and keeps its text', async () => {
    const said = 'Adani Electricity bill. Units consumed 230. Amount payable Rs. 1,840.50.';
    const { ingest } = build(fakeTranscriber(said).t);
    const f = await ingest.importFile(new File(['audio'], 'voice note.mp3'));
    expect(f).toMatchObject({ folder: 'Bills', status: 'ready', text: said });
  });

  it('falls back to name-only sorting when transcription fails, so Retry can try again', async () => {
    const { ingest } = build(fakeTranscriber(() => { throw new Error('offline'); }).t);
    const errors = console.error;
    console.error = () => {};
    try {
      const f = await ingest.importFile(new File(['audio'], 'call.mp3'));
      expect(f).toMatchObject({ status: 'needs_review', text: '' });
    } finally {
      console.error = errors;
    }
  });
});
