import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/core.css';
import App from './App';
import { ToastProvider } from './components/toast';
import { DialogProvider } from './components/dialog';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <DialogProvider>
        <App />
      </DialogProvider>
    </ToastProvider>
  </React.StrictMode>,
);
