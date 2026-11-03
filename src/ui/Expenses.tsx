import { IonContent, IonItem, IonLabel, IonList, IonNote } from '@ionic/react';
import { useEffect, useState } from 'react';

import { useT } from '../i18n';
import type { RecordRow } from '../models';
import { services } from '../services';
import { fmtDate, fmtMoney, Header, type OpenFn } from './common';

type Row = RecordRow & { fileName: string };

export default function Expenses({ onOpen }: { onOpen: OpenFn }) {
  const s = useT();
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    void services().db.records().then(setRows);
  }, []);

  const total = (rows ?? []).reduce((sum, r) => sum + (r.amount ?? 0), 0);

  return (
    <>
      <Header title={s.expenses.title} />
      <IonContent>
        {rows === null ? null : rows.length === 0 ? (
          <p className="empty">{s.expenses.empty}</p>
        ) : (
          <>
            <p className="total"><span>{s.expenses.total}</span><strong>{fmtMoney(total)}</strong></p>
            <IonList inset>
              {rows.map((r) => (
                <IonItem key={r.fileId} button detail onClick={() => onOpen(r.fileId)}>
                  <IonLabel>
                    <p className="kind">{s.expenses.kind[r.kind] ?? r.kind}{r.docDate ? ` · ${fmtDate(r.docDate)}` : ''}</p>
                    <h2>{r.vendor ?? r.fileName}</h2>
                    {r.dueDate && <p>{s.expenses.due(fmtDate(r.dueDate))}</p>}
                  </IonLabel>
                  <IonNote slot="end" className="amount">{r.amount === undefined ? '-' : fmtMoney(r.amount)}</IonNote>
                </IonItem>
              ))}
            </IonList>
          </>
        )}
      </IonContent>
    </>
  );
}
