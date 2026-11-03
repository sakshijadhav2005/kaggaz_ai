import { IonApp, IonLabel, IonTabBar, IonTabButton } from '@ionic/react';
import { useState } from 'react';

import type { AppTab } from '../agent/registry';
import { useT } from '../i18n';

import Chat from './Chat';
import Expenses from './Expenses';
import { Icon, type IconName } from './icons';
import Library from './Library';
import { FirstRunConsent } from './Consent';
import Reminders from './Reminders';
import Tools from './Tools';
import Viewer from './Viewer';

const TABS: { id: AppTab; icon: IconName }[] = [
  { id: 'library', icon: 'folder' },
  { id: 'ask', icon: 'chat' },
  { id: 'tools', icon: 'pdf' },
  { id: 'expenses', icon: 'receipt' },
  { id: 'reminders', icon: 'bell' },
];

export default function App() {
  const s = useT();
  const [tab, setTab] = useState<AppTab>('library');
  const [viewing, setViewing] = useState<{ id: string; page?: number } | null>(null);
  const open = (id: string, page?: number) => setViewing({ id, page });

  return (
    <IonApp>
      <div className="shell">
        <div className="screen">
          {tab === 'library' && <Library onOpen={open} />}
          {tab === 'ask' && <Chat onOpen={open} onTab={setTab} />}
          {tab === 'tools' && <Tools onOpen={open} />}
          {tab === 'expenses' && <Expenses onOpen={open} />}
          {tab === 'reminders' && <Reminders onOpen={open} />}
        </div>
        <IonTabBar selectedTab={tab}>
          {TABS.map((t) => (
            <IonTabButton key={t.id} tab={t.id} selected={t.id === tab} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} />
              <IonLabel>{s.tabs[t.id]}</IonLabel>
            </IonTabButton>
          ))}
        </IonTabBar>
      </div>
      {viewing && <Viewer key={`${viewing.id}:${viewing.page}`} fileId={viewing.id} page={viewing.page} onClose={() => setViewing(null)} />}
      <FirstRunConsent />
    </IonApp>
  );
}
