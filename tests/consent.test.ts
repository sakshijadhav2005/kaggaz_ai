import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CLOUD_NOTICE_VERSION, cloudConsent, cloudConsentDate, onConsentChange, setCloudConsent, setConsentAudit } from '../src/core/consent';
import { FieldCipher } from '../src/core/crypto';
import { Db } from '../src/core/db';
import { memoryStorage } from './helpers';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  setConsentAudit(async () => {});
});

describe('cloud consent', () => {
  it('starts unasked, then records yes and no', async () => {
    expect(cloudConsent()).toBe('unasked');
    expect(cloudConsentDate()).toBeNull();
    const seen: string[] = [];
    const stop = onConsentChange(() => seen.push(cloudConsent()));
    await setCloudConsent(true, 'first-run');
    expect(cloudConsent()).toBe('granted');
    expect(cloudConsentDate()).toBeInstanceOf(Date);
    await setCloudConsent(false, 'settings');
    expect(cloudConsent()).toBe('declined');
    stop();
    expect(seen).toEqual(['granted', 'declined']);
  });

  it('asks again when the notice changes', () => {
    localStorage.setItem('kaagaz.cloudConsent', JSON.stringify({ granted: true, version: CLOUD_NOTICE_VERSION - 1, at: 1 }));
    expect(cloudConsent()).toBe('unasked');
  });

  it('treats a damaged record as unasked', () => {
    localStorage.setItem('kaagaz.cloudConsent', '{not json');
    expect(cloudConsent()).toBe('unasked');
  });

  it('writes each answer to the audit log, and a failed log does not undo a withdrawal', async () => {
    const events: [string, Record<string, unknown>][] = [];
    setConsentAudit(async (e, d) => void events.push([e, d]));
    await setCloudConsent(true, 'first-run');
    expect(events[0]).toEqual(['consent.cloud.granted', expect.objectContaining({ noticeVersion: CLOUD_NOTICE_VERSION, via: 'first-run' })]);

    setConsentAudit(async () => {
      throw new Error('disk full');
    });
    await expect(setCloudConsent(false, 'settings')).rejects.toThrow('disk full');
    expect(cloudConsent()).toBe('declined');
  });
});

const cipher = await FieldCipher.fromRawKey(FieldCipher.generateRawKey());

describe('audit log', () => {
  async function withRows(n: number) {
    const name = `audit-${Math.random()}`;
    const db = new Db(cipher, name);
    // Appended without awaiting each, to check that concurrent appends still form one chain.
    await Promise.all(Array.from({ length: n }, (_, i) => db.appendAudit('consent.cloud.granted', { i })));
    const raw = new Dexie(name);
    raw.version(2).stores({ files: 'id, folder, importedAt', chunks: '++id, fileId', records: 'fileId', reminders: '++id, fileId, dueAt', audit: '++id' });
    await raw.open();
    return { db, table: raw.table('audit') };
  }

  it('chains entries and verifies them', async () => {
    const { db } = await withRows(5);
    expect(await db.verifyAudit()).toEqual({ ok: true, rows: 5 });
    const log = await db.auditLog();
    expect(log.map((r) => JSON.parse(r.details).i)).toEqual([4, 3, 2, 1, 0]);
    expect(log[0].prevHash).toBe(log[1].hash);
  });

  it('detects an edited entry', async () => {
    const { db, table } = await withRows(4);
    await table.update(2, { event: 'consent.cloud.withdrawn' });
    expect(await db.verifyAudit()).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('detects a removed entry', async () => {
    const { db, table } = await withRows(4);
    await table.delete(2);
    expect(await db.verifyAudit()).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it('detects an entry rewritten with a fresh hash', async () => {
    const { db, table } = await withRows(3);
    const row = await table.get(1);
    await table.update(1, { details: '{"i":99}', hash: row.hash.replace(/^./, (c: string) => (c === 'a' ? 'b' : 'a')) });
    expect((await db.verifyAudit()).ok).toBe(false);
  });
});
