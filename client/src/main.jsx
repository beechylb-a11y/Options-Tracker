import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { applyTheme, watchSystemTheme } from './utils/theme';
import { installBridgeAuth } from './utils/bridgeAuth';
import { startLiveFeed } from './live/liveFeed';

installBridgeAuth();
startLiveFeed();   // after the fetch wrapper, so the stream carries the bridge key
applyTheme();
watchSystemTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
