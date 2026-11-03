import { LocalNotifications } from '@capacitor/local-notifications';

import type { ReminderScheduler } from '../interfaces';

/** Local notification at the reminder time. Throws on platforms without support; callers ignore that. */
export class LocalReminderScheduler implements ReminderScheduler {
  async init() {
    await LocalNotifications.requestPermissions();
  }

  async schedule(id: number, title: string, at: Date) {
    await LocalNotifications.schedule({
      notifications: [{ id, title: 'Kaagaz reminder', body: title, schedule: { at } }],
    });
  }

  async cancel(id: number) {
    await LocalNotifications.cancel({ notifications: [{ id }] });
  }
}
