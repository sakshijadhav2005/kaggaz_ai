import { IonApp, IonLabel, IonTabBar, IonTabButton } from '@ionic/react';
import { useCallback, useState } from 'react';

import type { AppTab } from '../agent/registry';
import { useT } from '../i18n';

import Chat from './Chat';
import { SettingsContext } from './common';
import Expenses from './Expenses';
import { Icon, type IconName } from './icons';
import Library from './Library';
import { FirstRunConsent } from './Consent';
import Reminders from './Reminders';
import Settings from './Settings';
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
  const [settings, setSettings] = useState(false);
  /** Bumped when something outside a screen may have changed its data (a viewer closing, a restore). */
  const [version, setVersion] = useState(0);
  const open = (id: string, page?: number) => setViewing({ id, page });
  const openSettings = useCallback(() => setSettings(true), []);
  const refresh = () => setVersion((v) => v + 1);

  return (
    <IonApp>
      <SettingsContext.Provider value={openSettings}>
      <div className="shell">
        <div className="screen">
          {tab === 'library' && <Library onOpen={open} version={version} />}
          {tab === 'ask' && <Chat onOpen={open} onTab={setTab} />}
          {tab === 'tools' && <Tools onOpen={open} />}
          {tab === 'expenses' && <Expenses key={version} onOpen={open} />}
          {tab === 'reminders' && <Reminders key={version} onOpen={open} />}
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
      {viewing && (
        <Viewer
          key={`${viewing.id}:${viewing.page}`}
          fileId={viewing.id}
          page={viewing.page}
          onClose={() => {
            setViewing(null);
            refresh();
          }}
        />
      )}
      {settings && (
        <Settings
          onClose={() => {
            setSettings(false);
            refresh();
          }}
        />
      )}
      <FirstRunConsent />
      </SettingsContext.Provider>
    </IonApp>
  );
}
