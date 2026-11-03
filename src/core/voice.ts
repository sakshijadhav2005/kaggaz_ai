import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { Capacitor } from '@capacitor/core';

import { expectExternalActivity } from './appLock';

/*
 * Speech to text for the Ask tab. Android: the phone's own recogniser (Google's, with offline Hindi and
 * English if the user has those language packs; otherwise it uses Google's online service, which is the
 * phone's setting, not Kaagaz's). Browser: the Web Speech API where it exists.
 * The text only fills the question box; nothing is sent until the user taps Send.
 */

export type VoiceProblem = 'notAllowed' | 'unavailable' | 'nothingHeard';

export class VoiceError extends Error {
  constructor(readonly problem: VoiceProblem) {
    super(problem);
  }
}

interface WebRecognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type WebRecognitionCtor = new () => WebRecognition;

const webCtor = (): WebRecognitionCtor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: WebRecognitionCtor; webkitSpeechRecognition?: WebRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/** Whether to show the microphone at all. */
export const voiceSupported = () => Capacitor.isNativePlatform() || webCtor() !== null;

const tag = (lang: 'en' | 'hi') => (lang === 'hi' ? 'hi-IN' : 'en-IN');

let stopWeb: (() => void) | null = null;

/** Listens once and returns what was said. Rejects with VoiceError. */
export async function listen(lang: 'en' | 'hi'): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    if (!(await SpeechRecognition.available()).available) throw new VoiceError('unavailable');
    let perm = (await SpeechRecognition.checkPermissions()).speechRecognition;
    if (perm !== 'granted') {
      expectExternalActivity(); // the permission dialog must not trigger the app lock
      perm = (await SpeechRecognition.requestPermissions()).speechRecognition;
    }
    if (perm !== 'granted') throw new VoiceError('notAllowed');
    let matches: string[] | undefined;
    try {
      ({ matches } = await SpeechRecognition.start({ language: tag(lang), maxResults: 1, partialResults: false, popup: false }));
    } catch (e) {
      // The recogniser rejects when it heard nothing; "No match" / "No speech input" on most phones.
      if (/match|speech|timeout/i.test(String(e))) throw new VoiceError('nothingHeard');
      throw e;
    }
    const text = matches?.[0]?.trim() ?? '';
    if (!text) throw new VoiceError('nothingHeard');
    return text;
  }

  const Ctor = webCtor();
  if (!Ctor) throw new VoiceError('unavailable');
  return new Promise<string>((resolve, reject) => {
    const r = new Ctor();
    r.lang = tag(lang);
    r.interimResults = false;
    r.maxAlternatives = 1;
    let heard = '';
    r.onresult = (e) => {
      heard = e.results[0]?.[0]?.transcript?.trim() ?? '';
    };
    r.onerror = (e) => reject(new VoiceError(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'notAllowed' : e.error === 'no-speech' ? 'nothingHeard' : 'unavailable'));
    r.onend = () => {
      stopWeb = null;
      if (heard) resolve(heard);
      else reject(new VoiceError('nothingHeard'));
    };
    stopWeb = () => r.stop();
    r.start();
  });
}

/** Stops listening early; whatever was heard so far is returned by listen(). */
export async function stopListening(): Promise<void> {
  if (Capacitor.isNativePlatform()) await SpeechRecognition.stop();
  else stopWeb?.();
}
