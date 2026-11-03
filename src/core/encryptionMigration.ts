import type { Db } from './db';
import type { CapacitorVault } from './vault';

const DONE_FLAG = 'kaagaz.encryptionMigrated';

/**
 * One-time upgrade for installs from before encryption: encrypts database fields and vault files
 * stored in plaintext. Every step checks whether its data is already encrypted, so an interrupted run
 * simply continues on the next launch. A file that fails is left readable and retried next launch.
 */
export async function migrateToEncrypted(db: Db, vault: CapacitorVault): Promise<void> {
  if (readFlag()) return;

  await db.encryptLegacyRows();

  let failures = 0;
  for (const f of await db.allFilesIncludingTrash()) {
    try {
      const path = await vault.encryptLegacy(f.path, f.id, f.folder);
      if (path !== f.path) await db.updateFile(f.id, { path });
    } catch (e) {
      failures++;
      console.error(`Could not encrypt stored file ${f.id}:`, e);
    }
  }
  if (failures === 0) writeFlag();
}

function readFlag(): boolean {
  try {
    return localStorage.getItem(DONE_FLAG) === '1';
  } catch {
    return false;
  }
}

function writeFlag() {
  try {
    localStorage.setItem(DONE_FLAG, '1');
  } catch {
    // Without the flag the migration re-checks on each launch, which is slower but harmless.
  }
}
