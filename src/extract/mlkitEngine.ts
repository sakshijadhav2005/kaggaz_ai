import { Script, TextRecognition } from '@capacitor-mlkit/text-recognition';
import { Directory, Filesystem } from '@capacitor/filesystem';

import { blobToBase64 } from '../core/base64';
import type { OcrEngine } from './ocrEngine';
import { pickBestText } from './textUtils';

/**
 * Google ML Kit text recognition (on-device, works offline). Android and iOS only.
 * The plugin reads from a file, so the image is written to the cache folder first.
 */
export class MlKitEngine implements OcrEngine {
  async recognize(image: Blob): Promise<string> {
    const ext = image.type === 'image/jpeg' ? 'jpg' : 'png';
    const path = `ocr_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`;
    await Filesystem.writeFile({ path, data: await blobToBase64(image), directory: Directory.Cache });
    try {
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
      // Latin and Devanagari models read different scripts; keep whichever looks like real text.
      const texts: string[] = [];
      for (const script of [Script.Latin, Script.Devanagari]) {
        texts.push((await TextRecognition.processImage({ path: uri, script })).text);
      }
      return pickBestText(texts);
    } finally {
      await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
    }
  }
}
