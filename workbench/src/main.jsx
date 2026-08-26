import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Shell from './Shell.jsx';
import { UniverseProvider } from './universe/UniverseContext.jsx';
// NOTE: do NOT import portfolio-app/src/index.css. It is an unused leftover of the Vite
// starter template — a light-theme sheet that sets #root to a centred 1126px column with a
// border, restyles <code> as a light chip, and overrides the font and background. Neither
// standalone app imports it. The workbench's chrome lives in index.html + inline styles.

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <UniverseProvider>
      <Shell />
    </UniverseProvider>
  </StrictMode>,
);
