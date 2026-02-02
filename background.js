// TradingView Price Alert Extension - Background Service Worker
// Handles price crossing detection and notifications

let alertLevels = [];
let lastPrices = {}; // Store last price per symbol for crossing detection
let triggeredAlerts = new Set(); // Track which alerts have been triggered

// Initialize
chrome.runtime.onInstalled.addListener(() => {
  console.log('[TV-Alert] Extension installed');
  loadAlertLevels();

  // Enable side panel to open on action click
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('[TV-Alert] Side panel error:', error));
});

// Handle extension icon click - open side panel
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.log('[TV-Alert] Could not open side panel:', e);
  }
});

// Load alert levels from storage
async function loadAlertLevels() {
  const result = await chrome.storage.local.get(['alertLevels']);
  alertLevels = result.alertLevels || [];
  console.log('[TV-Alert] Loaded alert levels:', alertLevels.length);
}

// Save alert levels to storage
async function saveAlertLevels() {
  await chrome.storage.local.set({ alertLevels });

  // Notify content script to update visual lines
  const tabs = await chrome.tabs.query({ url: ['https://www.tradingview.com/chart/*', 'https://tradingview.com/chart/*'] });
  tabs.forEach(tab => {
    chrome.tabs.sendMessage(tab.id, {
      type: 'LEVELS_UPDATED',
      levels: alertLevels
    }).catch(() => {});
  });
}

// Generate unique ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Check if price crossed any alert levels
function checkPriceCrossings(symbol, currentPrice) {
  const lastPrice = lastPrices[symbol];

  if (!lastPrice) {
    lastPrices[symbol] = currentPrice;
    return;
  }

  alertLevels.forEach(level => {
    if (!level.enabled) return;

    const alertKey = `${level.id}-${level.direction}`;

    // Check for crossing
    let crossed = false;
    let direction = '';

    if (level.direction === 'above' || level.direction === 'both') {
      // Price crossed from below to above
      if (lastPrice < level.price && currentPrice >= level.price) {
        crossed = true;
        direction = 'above';
      }
    }

    if (level.direction === 'below' || level.direction === 'both') {
      // Price crossed from above to below
      if (lastPrice > level.price && currentPrice <= level.price) {
        crossed = true;
        direction = 'below';
      }
    }

    if (crossed && !triggeredAlerts.has(alertKey)) {
      triggerAlert(level, symbol, currentPrice, direction);

      // For one-time alerts, mark as triggered
      if (!level.repeating) {
        triggeredAlerts.add(alertKey);
      }
    }

    // Reset triggered state if price moved away from level
    if (triggeredAlerts.has(alertKey)) {
      const distance = Math.abs(currentPrice - level.price);
      const percentDistance = (distance / level.price) * 100;

      // Reset if price moved more than 0.5% away
      if (percentDistance > 0.5) {
        triggeredAlerts.delete(alertKey);
      }
    }
  });

  lastPrices[symbol] = currentPrice;
}

// Handle trade signal from content script
async function handleTradeSignal(data) {
  const { side, symbol, price, timestamp } = data;
  console.log(`[TV-Alert] Trade signal: ${side} ${symbol} @ ${price}`);

  // Show browser notification for trade
  const icon = side === 'BUY' ? '🟢' : '🔴';
  const title = side === 'BUY' ? 'BUY Order' : 'SELL Order';

  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `${icon} ${title} - ${symbol}`,
      message: `${side} @ ${price.toFixed(2)}\nTime: ${new Date(timestamp).toLocaleTimeString()}`,
      priority: 2
    });
  } catch (e) {
    console.error('[TV-Alert] Trade notification error:', e);
  }
}

// Trigger an alert
async function triggerAlert(level, symbol, price, direction) {
  console.log(`[TV-Alert] ALERT! ${symbol} crossed ${level.price} (${direction})`);

  // Show browser notification
  const directionText = direction === 'above' ? 'crossed above' : 'crossed below';
  const iconColor = direction === 'above' ? '📈' : '📉';

  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `${iconColor} Price Alert - ${symbol}`,
      message: `Price ${directionText} ${level.price.toFixed(2)}!\nCurrent: ${price.toFixed(2)}`,
      priority: 2,
      requireInteraction: true
    });
  } catch (e) {
    console.error('[TV-Alert] Notification error:', e);
  }

  // Send message to content script for visual notification
  const tabs = await chrome.tabs.query({ url: ['https://www.tradingview.com/chart/*', 'https://tradingview.com/chart/*'] });
  tabs.forEach(tab => {
    chrome.tabs.sendMessage(tab.id, {
      type: 'ALERT_TRIGGERED',
      level,
      symbol,
      price,
      direction
    }).catch(() => {});
  });

  // Play sound if enabled
  if (level.sound) {
    // Note: Sound playback in service workers is limited
    // Would need to use offscreen document or content script
  }
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'PRICE_UPDATE':
      const { price, symbol } = message.data;
      if (price && symbol) {
        checkPriceCrossings(symbol, price);
      }
      sendResponse({ received: true });
      break;

    case 'GET_LEVELS':
      sendResponse({ levels: alertLevels });
      break;

    case 'ADD_LEVEL':
      const newLevel = {
        id: generateId(),
        price: message.price,
        symbol: message.symbol || 'ALL',
        direction: message.direction || 'both',
        color: message.color || '#ff9800',
        enabled: true,
        repeating: message.repeating || false,
        sound: message.sound || true,
        createdAt: Date.now()
      };
      alertLevels.push(newLevel);
      saveAlertLevels();
      sendResponse({ success: true, level: newLevel });
      break;

    case 'UPDATE_LEVEL':
      const levelIndex = alertLevels.findIndex(l => l.id === message.id);
      if (levelIndex !== -1) {
        alertLevels[levelIndex] = { ...alertLevels[levelIndex], ...message.updates };
        saveAlertLevels();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Level not found' });
      }
      break;

    case 'DELETE_LEVEL':
      alertLevels = alertLevels.filter(l => l.id !== message.id);
      triggeredAlerts.delete(message.id + '-above');
      triggeredAlerts.delete(message.id + '-below');
      saveAlertLevels();
      sendResponse({ success: true });
      break;

    case 'TOGGLE_LEVEL':
      const toggleIndex = alertLevels.findIndex(l => l.id === message.id);
      if (toggleIndex !== -1) {
        alertLevels[toggleIndex].enabled = !alertLevels[toggleIndex].enabled;
        saveAlertLevels();
        sendResponse({ success: true, enabled: alertLevels[toggleIndex].enabled });
      }
      break;

    case 'CLEAR_ALL':
      alertLevels = [];
      triggeredAlerts.clear();
      lastPrices = {};
      saveAlertLevels();
      sendResponse({ success: true });
      break;

    case 'TRADE_SIGNAL':
      handleTradeSignal(message.data);
      sendResponse({ received: true });
      break;

    case 'GET_TRADES':
      chrome.storage.local.get(['tradeHistory'], (result) => {
        sendResponse({ trades: result.tradeHistory || [] });
      });
      return true; // Keep channel open for async

    case 'CLEAR_TRADES':
      chrome.storage.local.set({ tradeHistory: [] });
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ error: 'Unknown message type' });
  }

  return true; // Keep message channel open for async response
});

// Listen for storage changes (sync across windows)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.alertLevels) {
    alertLevels = changes.alertLevels.newValue || [];
  }
});

// Initial load
loadAlertLevels();
