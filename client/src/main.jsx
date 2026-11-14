import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { applyTheme, watchSystemTheme } from './utils/theme';
import { installBridgeAuth } from './utils/bridgeAuth';

installBridgeAuth();
applyTheme();
watchSystemTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
