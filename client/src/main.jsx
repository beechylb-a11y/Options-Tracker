import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './styles/glass.css';   // after index.css: same-specificity selectors win on order
import './styles/vision.css';  // after glass.css: Vision only overrides
import { applyTheme, watchSystemTheme, applyGlass } from './utils/theme';
import { installBridgeAuth } from './utils/bridgeAuth';
import { startLiveFeed } from './live/liveFeed';

installBridgeAuth();
startLiveFeed();   // after the fetch wrapper, so the stream carries the bridge key
applyTheme();
applyGlass();
watchSystemTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
