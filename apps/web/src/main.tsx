import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerDrawingDiagnostics } from './chart/drawings/diagnostics';
/*
 * The typefaces, self-hosted.
 *
 * Atlas named Inter and JetBrains Mono in its tokens and shipped neither, so
 * every machine drew the terminal in whatever its system font happened to be -
 * which is why a layout that was right on one screen was a pixel out on
 * another. These are the real faces, bundled with the application under the
 * SIL Open Font License, so Atlas looks the same everywhere and needs nothing
 * from a font CDN at runtime.
 */
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/jetbrains-mono';
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
