import { useEffect, useRef, useState } from 'react';

import { closePdf, openPdf, renderPage } from '../extract/pdfLib';
import type { StoredFile } from '../models';
import { services } from '../services';
import { FileGlyph } from './icons';

const WIDTH = 260;
// Thumbnails depend only on the file's content, so they stay valid across moves and retries.
const cache = new Map<string, string>();

async function makeThumb(file: StoredFile): Promise<string> {
  const blob = await services().read(file);
  if (file.type === 'pdf') {
    const doc = await openPdf(blob);
    try {
      const page = await doc.getPage(1);
      const canvas = await renderPage(doc, 1, WIDTH / page.getViewport({ scale: 1 }).width);
      return canvas.toDataURL('image/jpeg', 0.75);
    } finally {
      await closePdf(doc);
    }
  }
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = Math.round((bmp.height / bmp.width) * WIDTH);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.75);
}

/** First-page preview for PDFs and images, rendered when the card scrolls into view. Others show a glyph. */
export default function Thumb({ file }: { file: StoredFile }) {
  // A locked file shows only its type: a page preview would reveal what the lock protects.
  const [src, setSrc] = useState(file.locked ? undefined : cache.get(file.id));
  const box = useRef<HTMLDivElement>(null);
  const previewable = (file.type === 'pdf' || file.type === 'image') && !file.locked;
  if (file.locked) cache.delete(file.id);

  useEffect(() => {
    if (src || !previewable || !box.current) return;
    let cancelled = false;
    const watch = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        watch.disconnect();
        makeThumb(file)
          .then((url) => {
            cache.set(file.id, url);
            if (!cancelled) setSrc(url);
          })
          .catch(() => undefined); // keep the glyph (e.g. HEIC the browser cannot decode)
      },
      { rootMargin: '200px' },
    );
    watch.observe(box.current);
    return () => {
      cancelled = true;
      watch.disconnect();
    };
  }, [file, src, previewable]);

  return <div ref={box} className="thumb-fill">{src && !file.locked ? <img src={src} alt="" className={file.type === 'image' ? 'photo' : undefined} /> : <FileGlyph type={file.type} />}</div>;
}
