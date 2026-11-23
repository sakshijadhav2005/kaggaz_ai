import { blobToBase64 } from '../core/base64';
import type { Extractor, Transcriber } from '../interfaces';
import { mimeFor, type ExtractedSegment, type StoredFile } from '../models';
import { detectLanguage, textConfidence } from './textUtils';

/*
 * Imported audio (voice notes, recorded calls) as text, so it is sorted, searched and answered from like
 * any document. Online only: the on-device Gemma 4 plugin takes no audio. With no connection, no consent,
 * or a recording over the size cap, it returns nothing and the file is sorted by its name, as before;
 * Retry transcribes it later.
 */

/** The proxy's cap (MAX_AUDIO_B64_CHARS in proxy/src/index.ts) is this size after base64. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** What the model replies when it hears no speech. */
export const NO_SPEECH = '[no speech]';

export class AudioExtractor implements Extractor {
  constructor(
    private read: (file: StoredFile) => Promise<Blob>,
    /** Online, with consent: the recording may leave the phone. */
    private canTranscribe: () => boolean,
    private transcriber: Transcriber,
  ) {}

  canHandle = (file: StoredFile) => file.type === 'audio';

  async extract(file: StoredFile): Promise<ExtractedSegment[]> {
    // A locked document never leaves the phone.
    if (file.locked || !this.canTranscribe()) return [];
    const blob = await this.read(file);
    if (blob.size === 0 || blob.size > MAX_AUDIO_BYTES) return [];
    const text = (await this.transcriber.transcribe(await blobToBase64(blob), mimeFor(file.name))).trim();
    if (text === '' || text.includes(NO_SPEECH)) return [];
    return [{ startMs: 0, text, language: detectLanguage(text), confidence: textConfidence(text), method: 'audio_transcript' }];
  }
}
