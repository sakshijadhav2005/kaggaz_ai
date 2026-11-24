import { useEffect, useState } from 'react';

import type { StorageDetails } from '../core/storage';
import { useT } from '../i18n';
import { services } from '../services';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
};

export default function StoragePanel() {
  const s = useT();
  const [details, setDetails] = useState<StorageDetails | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void services()
      .storageDetails()
      .then((result) => {
        if (active) setDetails(result);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="panel">
      <h2>{s.storage.title}</h2>
      {error ? (
        <p className="error" role="alert">{s.storage.failed(error)}</p>
      ) : details ? (
        <dl className="storage-stats">
          <div className="storage-stat">
            <dt>{s.storage.files}</dt>
            <dd>{s.storage.fileCount(details.fileCount)}</dd>
          </div>
          <div className="storage-stat">
            <dt>{s.storage.totalUsed}</dt>
            <dd>{formatBytes(details.bytesUsed)}</dd>
          </div>
          <div className="storage-stat">
            <dt>{s.storage.pdfs}</dt>
            <dd>{s.storage.pdfCount(details.pdfCount)}</dd>
          </div>
          <div className="storage-stat">
            <dt>{s.storage.pdfUsed}</dt>
            <dd>{formatBytes(details.pdfBytesUsed)}</dd>
          </div>
        </dl>
      ) : (
        <p className="hint">{s.storage.loading}</p>
      )}
      <p className="hint">{s.storage.location}</p>
      <code className="storage-path">vault/&lt;folder&gt;/&lt;id&gt;.kgz</code>
      <p className="hint">{s.storage.encryption}</p>
      <p className="hint">{s.storage.trash}</p>
    </section>
  );
}
