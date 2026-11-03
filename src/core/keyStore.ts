import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

import { base64ToBytes, bytesToBase64, FieldCipher } from './crypto';

const KEY_NAME = 'kaagaz_data_key';
/** Set once a key exists, so a key that later goes missing is an error, not a reason to make a new one. */
const CREATED_FLAG = 'kaagaz.dataKeyCreated';

/**
 * The data key for the database and vault. On Android it lives in secure storage, encrypted by a
 * Keystore key that never leaves the device's secure hardware. In a browser the plugin falls back to
 * localStorage, which is fine for development but not secure.
 */
export async function loadCipher(): Promise<FieldCipher> {
  const { value: keys } = await SecureStoragePlugin.keys();
  if (keys.includes(KEY_NAME)) {
    const { value } = await SecureStoragePlugin.get({ key: KEY_NAME });
    return FieldCipher.fromRawKey(base64ToBytes(value));
  }

  if (readFlag()) {
    // A new key would make every stored document unreadable. Stop instead.
    throw new Error('The encryption key for your documents is missing. Reinstall the app or restore a backup.');
  }

  const raw = FieldCipher.generateRawKey();
  await SecureStoragePlugin.set({ key: KEY_NAME, value: bytesToBase64(raw) });
  writeFlag();
  if (!Capacitor.isNativePlatform()) console.warn('Kaagaz: running in a browser, so the encryption key is kept in localStorage.');
  return FieldCipher.fromRawKey(raw);
}

function readFlag(): boolean {
  try {
    return localStorage.getItem(CREATED_FLAG) === '1';
  } catch {
    return false;
  }
}

function writeFlag() {
  try {
    localStorage.setItem(CREATED_FLAG, '1');
  } catch {
    // Without localStorage the key check above simply has no second line of defence.
  }
}
