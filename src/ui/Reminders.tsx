import { IonButton, IonCheckbox, IonContent, IonItem, IonLabel, IonList } from '@ionic/react';
import { useCallback, useEffect, useState } from 'react';

import { useT } from '../i18n';
import type { Reminder } from '../models';
import { services } from '../services';
import { fmtDate, Header, type OpenFn } from './common';
import { Icon } from './icons';

export default function Reminders({ onOpen }: { onOpen: OpenFn }) {
  const s = useT();
  const [items, setItems] = useState<Reminder[] | null>(null);

  const load = useCallback(async () => setItems(await services().db.reminders()), []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (r: Reminder, done: boolean) => {
    const { db, scheduler } = services();
    await db.setReminderDone(r.id!, done);
    try {
      // Completed reminders stop alerting; un-checking a future one re-arms it.
      if (done) await scheduler.cancel(r.id!);
      else if (r.dueAt > Date.now()) await scheduler.schedule(r.id!, r.title, new Date(r.dueAt));
    } catch {
      // No notification support here.
    }
    await load();
  };

  return (
    <>
      <Header title={s.reminders.title} />
      <IonContent>
        {items === null ? null : items.length === 0 ? (
          <p className="empty">{s.reminders.empty}</p>
        ) : (
          <IonList inset>
            {items.map((r) => {
              const overdue = !r.done && r.dueAt < Date.now();
              return (
                <IonItem key={r.id}>
                  <IonCheckbox
                    slot="start"
                    checked={r.done}
                    aria-label={s.reminders.markDone(r.title)}
                    onIonChange={(e) => e.detail.checked !== r.done && void toggle(r, e.detail.checked)}
                  />
                  <IonLabel>
                    <h2 className={r.done ? 'done' : ''}>{r.title}</h2>
                    <p className={overdue ? 'error' : ''}>{overdue ? s.reminders.overdue : ''}{fmtDate(r.dueAt)}</p>
                  </IonLabel>
                  <IonButton slot="end" fill="clear" aria-label={s.reminders.openFile} onClick={() => onOpen(r.fileId)}>
                    <Icon name="open" />
                  </IonButton>
                </IonItem>
              );
            })}
          </IonList>
        )}
      </IonContent>
    </>
  );
}
