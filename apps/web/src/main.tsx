import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Placeholder entry point. The UI is built in a later session.
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <p>Pharmacy POS</p>
  </StrictMode>,
);
