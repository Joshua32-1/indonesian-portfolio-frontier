import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Shell from './Shell.jsx';
import { UniverseProvider } from './universe/UniverseContext.jsx';
// The workbench's chrome lives in index.html plus inline styles; there is no stylesheet to
// import. (portfolio-app/src/index.css and App.css used to sit here unreferenced — leftovers
// of the Vite starter template — and importing one restyled this whole app. Both deleted.)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <UniverseProvider>
      <Shell />
    </UniverseProvider>
  </StrictMode>,
);
