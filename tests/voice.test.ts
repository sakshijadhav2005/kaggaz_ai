import { afterEach, describe, expect, it, vi } from 'vitest';

/** A browser SpeechRecognition that says [text], or fails with [error]. */
function fakeRecognition(outcome: { text?: string; error?: string }) {
  const made: { lang: string }[] = [];
  class Fake {
    lang = '';
    interimResults = true;
    maxAlternatives = 5;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() {
      made.push(this);
    }
    start() {
      queueMicrotask(() => {
        if (outcome.error) this.onerror?.({ error: outcome.error });
        else if (outcome.text !== undefined) this.onresult?.({ results: [[{ transcript: outcome.text }]] });
        this.onend?.();
      });
    }
    stop() {}
  }
  return { Fake, made };
}

async function voiceWith(outcome: { text?: string; error?: string }) {
  const { Fake, made } = fakeRecognition(outcome);
  vi.stubGlobal('window', { webkitSpeechRecognition: Fake });
  vi.resetModules();
  return { voice: await import('../src/core/voice'), made };
}

afterEach(() => vi.unstubAllGlobals());

describe('voice input (browser)', () => {
  it('listens in the app language and returns the words', async () => {
    const { voice, made } = await voiceWith({ text: ' आधार कार्ड दिखाओ ' });
    expect(voice.voiceSupported()).toBe(true);
    expect(await voice.listen('hi')).toBe('आधार कार्ड दिखाओ');
    expect(made[0].lang).toBe('hi-IN');
  });

  it.each([
    ['not-allowed', 'notAllowed'],
    ['no-speech', 'nothingHeard'],
    ['network', 'unavailable'],
  ])('maps the browser error %s to %s', async (error, problem) => {
    const { voice } = await voiceWith({ error });
    await expect(voice.listen('en')).rejects.toMatchObject({ problem });
  });

  it('treats silence as nothing heard', async () => {
    const { voice } = await voiceWith({ text: '   ' });
    await expect(voice.listen('en')).rejects.toMatchObject({ problem: 'nothingHeard' });
  });

  it('is hidden where there is no recogniser', async () => {
    vi.stubGlobal('window', {});
    vi.resetModules();
    expect((await import('../src/core/voice')).voiceSupported()).toBe(false);
  });
});
