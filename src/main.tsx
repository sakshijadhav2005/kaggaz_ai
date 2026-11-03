import './polyfills'; // must stay first
import { setupIonicReact } from '@ionic/react';
import '@ionic/react/css/core.css';
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';
import '@ionic/react/css/padding.css';
import '@ionic/react/css/flex-utils.css';
import '@ionic/react/css/display.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './ui/App';
import LockGate from './ui/LockGate';
import './ui/styles.css';
import { initServices } from './services';

setupIonicReact({ mode: 'md' });

const root = createRoot(document.getElementById('root')!);

initServices()
  .then(() =>
    root.render(
      <StrictMode>
        <LockGate>
          <App />
        </LockGate>
      </StrictMode>,
    ),
  )
  .catch((e) => {
    root.render(<p className="empty">Could not start: {String(e)}</p>);
  });
