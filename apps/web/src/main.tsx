import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/core.css';
import App from './App';
import { ToastProvider } from './components/toast';
import { DialogProvider } from './components/dialog';
import { DOWNLOAD } from './lib/download';

// The download build keeps its typefaces on the computer (no Google Fonts
// request); the website build folds this away and never carries the files.
if (DOWNLOAD) void import('./assets/fonts/download-fonts.css');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <DialogProvider>
        <App />
      </DialogProvider>
    </ToastProvider>
  </React.StrictMode>,
);
