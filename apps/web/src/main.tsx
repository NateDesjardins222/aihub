import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerDrawingDiagnostics } from './chart/drawings/diagnostics';
import './styles/theme.css';

// A readable, drivable seam onto the drawing layer, for tools/drawing-matrix.mjs.
registerDrawingDiagnostics();

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
