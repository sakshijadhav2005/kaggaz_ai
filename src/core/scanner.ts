import { DocumentScanner } from '@capacitor-mlkit/document-scanner';
import { Capacitor } from '@capacitor/core';

/** True where the ML Kit document scanner exists (the Android app). */
export const canScanNatively = () => Capacitor.getPlatform() === 'android';

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');

/**
 * Opens Google's ML Kit document scanner (camera, edge detection, crop, multi-page) and returns
 * the result as one PDF File. Scanned pages have no text layer, so they go through OCR page by page.
 * Returns null if the user cancels.
 */
export async function scanToPdf(): Promise<File | null> {
  try {
    // The scanner lives in Google Play services; fetch it if this device does not have it yet.
    if (!(await DocumentScanner.isGoogleDocumentScannerModuleAvailable()).available) {
      await DocumentScanner.installGoogleDocumentScannerModule();
    }
    const { pdf } = await DocumentScanner.scanDocument({
      resultFormats: 'PDF',
      scannerMode: 'FULL',
      galleryImportAllowed: true,
      pageLimit: 20,
    });
    if (!pdf) return null;
    const blob = await (await fetch(Capacitor.convertFileSrc(pdf.uri))).blob();
    return new File([blob], `scan_${stamp()}.pdf`, { type: 'application/pdf' });
  } catch (e) {
    // The plugin rejects when the user backs out of the scanner.
    if (/cancel/i.test(String(e))) return null;
    throw e;
  }
}
