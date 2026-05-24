/**
 * main.jsx — React entry point
 * Mounts the App into #root. No Router or Provider needed — all state lives in App.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);