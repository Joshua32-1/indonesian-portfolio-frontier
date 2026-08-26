import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Shell from './Shell.jsx';
import { UniverseProvider } from './universe/UniverseContext.jsx';
import '../../portfolio-app/src/index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <UniverseProvider>
      <Shell />
    </UniverseProvider>
  </StrictMode>,
);
