// TradingView Price Alert Extension - Side Panel Script

document.addEventListener('DOMContentLoaded', async () => {
  // Elements - Header
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const currentPriceEl = document.getElementById('currentPrice');
  const currentSymbolEl = document.getElementById('currentSymbol');

  // Elements - Alerts Tab
  const priceInput = document.getElementById('priceInput');
  const colorInput = document.getElementById('colorInput');
  const directionInput = document.getElementById('directionInput');
  const addBtn = document.getElementById('addBtn');
  const alertList = document.getElementById('alertList');
  const alertBadge = document.getElementById('alertBadge');

  // Elements - Trades Tab
  const tradeList = document.getElementById('tradeList');
  const totalTradesEl = document.getElementById('totalTrades');
  const buyCountEl = document.getElementById('buyCount');
  const sellCountEl = document.getElementById('sellCount');

  // Elements - Settings Tab
  const apiUrlInput = document.getElementById('apiUrlInput');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const apiHeaderInput = document.getElementById('apiHeaderInput');
  const saveApiSettingsBtn = document.getElementById('saveApiSettings');
  const testApiBtn = document.getElementById('testApiBtn');
  const apiTestResult = document.getElementById('apiTestResult');

  // Elements - Footer
  const clearAlertsBtn = document.getElementById('clearAlerts');
  const clearTradesBtn = document.getElementById('clearTrades');
  const exportTradesBtn = document.getElementById('exportTrades');

  // Elements - Tabs
  const navTabs = document.querySelectorAll('.nav-tab');
  const tabContents = document.querySelectorAll('.tab-content');

  let currentPrice = null;
  let currentSymbol = '';

  // Initialize
  await loadAlerts();
  await loadTrades();
  await loadApiSettings();
  await checkConnection();
  setupTabs();

  // Poll for price updates
  setInterval(checkConnection, 2000);

  // Setup tab switching
  function setupTabs() {
    navTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;

        // Update tab buttons
        navTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // Update tab content
        tabContents.forEach(content => {
          content.classList.remove('active');
          if (content.id === `${targetTab}-tab`) {
            content.classList.add('active');
          }
        });

        // Refresh data when switching tabs
        if (targetTab === 'trades') {
          loadTrades();
        }
      });
    });
  }

  // Check connection to TradingView tab
  async function checkConnection() {
    try {
      const tabs = await chrome.tabs.query({
        url: ['https://www.tradingview.com/chart/*', 'https://tradingview.com/chart/*'],
        active: true,
        currentWindow: true
      });

      if (tabs.length === 0) {
        const allTvTabs = await chrome.tabs.query({
          url: ['https://www.tradingview.com/chart/*', 'https://tradingview.com/chart/*']
        });

        if (allTvTabs.length > 0) {
          await getPriceFromTab(allTvTabs[0].id);
        } else {
          setDisconnected();
        }
      } else {
        await getPriceFromTab(tabs[0].id);
      }
    } catch (e) {
      console.error('Connection check error:', e);
      setDisconnected();
    }
  }

  async function getPriceFromTab(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PRICE' });

      if (response && response.price) {
        currentPrice = response.price;
        currentSymbol = response.symbol || '';
        setConnected(currentPrice, currentSymbol);
      } else {
        setDisconnected();
      }
    } catch (e) {
      setDisconnected();
    }
  }

  function setConnected(price, symbol) {
    statusDot.classList.add('active');
    statusText.textContent = 'Connected';
    currentPriceEl.textContent = formatPrice(price);
    currentSymbolEl.textContent = symbol || '--';
  }

  function setDisconnected() {
    statusDot.classList.remove('active');
    statusText.textContent = 'Open TradingView';
    currentPriceEl.textContent = '--';
    currentSymbolEl.textContent = '--';
  }

  function formatPrice(price) {
    if (price >= 1000) {
      return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (price >= 1) {
      return price.toFixed(2);
    } else {
      return price.toFixed(4);
    }
  }

  // ============ ALERTS TAB ============

  async function loadAlerts() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_LEVELS' });
      renderAlerts(response.levels || []);
    } catch (e) {
      console.error('Failed to load alerts:', e);
      renderAlerts([]);
    }
  }

  function renderAlerts(levels) {
    alertBadge.textContent = levels.length;

    if (levels.length === 0) {
      alertList.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24">
            <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
          </svg>
          <p>No alert levels set</p>
          <p class="hint">Add a price level above to get started</p>
        </div>
      `;
      return;
    }

    alertList.innerHTML = levels.map(level => `
      <div class="alert-item" data-id="${level.id}">
        <div class="alert-color" style="background: ${level.color}"></div>
        <div class="alert-info">
          <div class="alert-price">${formatPrice(level.price)}</div>
          <div class="alert-meta">
            ${getDirectionText(level.direction)} ${level.enabled ? '• Active' : '• Paused'}
          </div>
        </div>
        <div class="alert-actions">
          <button class="action-btn ${level.enabled ? 'enabled' : ''}" data-action="toggle" title="${level.enabled ? 'Disable' : 'Enable'}">
            <svg viewBox="0 0 24 24">
              ${level.enabled
                ? '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>'
                : '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/>'
              }
            </svg>
          </button>
          <button class="action-btn delete" data-action="delete" title="Delete">
            <svg viewBox="0 0 24 24">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
      </div>
    `).join('');

    // Add event listeners
    alertList.querySelectorAll('[data-action="toggle"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const alertId = e.target.closest('.alert-item').dataset.id;
        await chrome.runtime.sendMessage({ type: 'TOGGLE_LEVEL', id: alertId });
        loadAlerts();
      });
    });

    alertList.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const alertId = e.target.closest('.alert-item').dataset.id;
        await chrome.runtime.sendMessage({ type: 'DELETE_LEVEL', id: alertId });
        loadAlerts();
      });
    });
  }

  function getDirectionText(direction) {
    switch (direction) {
      case 'above': return 'Cross above';
      case 'below': return 'Cross below';
      default: return 'Cross both';
    }
  }

  // Add new alert
  addBtn.addEventListener('click', async () => {
    const price = parseFloat(priceInput.value);

    if (!price || price <= 0) {
      priceInput.style.borderColor = '#ef5350';
      priceInput.style.boxShadow = '0 0 0 3px rgba(239, 83, 80, 0.2)';
      setTimeout(() => {
        priceInput.style.borderColor = '';
        priceInput.style.boxShadow = '';
      }, 1000);
      return;
    }

    try {
      await chrome.runtime.sendMessage({
        type: 'ADD_LEVEL',
        price: price,
        symbol: currentSymbol,
        direction: directionInput.value,
        color: colorInput.value
      });

      priceInput.value = '';
      await loadAlerts();

      // Success feedback
      addBtn.style.background = 'linear-gradient(135deg, #26a69a 0%, #2e7d32 100%)';
      setTimeout(() => {
        addBtn.style.background = '';
      }, 500);
    } catch (e) {
      console.error('Failed to add alert:', e);
    }
  });

  // Allow Enter key to add alert
  priceInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addBtn.click();
    }
  });

  // Set current price as default placeholder
  priceInput.addEventListener('focus', () => {
    if (!priceInput.value && currentPrice) {
      priceInput.placeholder = formatPrice(currentPrice);
    }
  });

  // Clear all alerts
  clearAlertsBtn.addEventListener('click', async () => {
    if (confirm('Clear all alert levels?')) {
      await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
      loadAlerts();
    }
  });

  // ============ TRADES TAB ============

  async function loadTrades() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_TRADES' });
      const trades = response.trades || [];
      renderTrades(trades);
      updateTradeStats(trades);
    } catch (e) {
      console.error('Failed to load trades:', e);
      renderTrades([]);
      updateTradeStats([]);
    }
  }

  function updateTradeStats(trades) {
    const buyTrades = trades.filter(t => t.side === 'BUY');
    const sellTrades = trades.filter(t => t.side === 'SELL');

    totalTradesEl.textContent = trades.length;
    buyCountEl.textContent = buyTrades.length;
    sellCountEl.textContent = sellTrades.length;
  }

  function renderTrades(trades) {
    if (trades.length === 0) {
      tradeList.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24">
            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
          </svg>
          <p>No trades recorded</p>
          <p class="hint">Click Buy or Sell on the chart</p>
        </div>
      `;
      return;
    }

    tradeList.innerHTML = trades.map(trade => {
      const date = new Date(trade.timestamp);
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });

      return `
        <div class="trade-item">
          <div class="trade-side ${trade.side.toLowerCase()}">${trade.side}</div>
          <div class="trade-info">
            <div class="trade-symbol">${trade.symbol}</div>
            <div class="trade-price">@ ${formatPrice(trade.price)}</div>
          </div>
          <div class="trade-time">
            <div>${timeStr}</div>
            <div class="trade-date">${dateStr}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // Clear trades
  clearTradesBtn.addEventListener('click', async () => {
    if (confirm('Clear all trade history?')) {
      await chrome.runtime.sendMessage({ type: 'CLEAR_TRADES' });
      loadTrades();
    }
  });

  // Export trades to CSV
  exportTradesBtn.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_TRADES' });
      const trades = response.trades || [];

      if (trades.length === 0) {
        alert('No trades to export');
        return;
      }

      // Create CSV content
      const headers = ['Date', 'Time', 'Side', 'Symbol', 'Price'];
      const rows = trades.map(trade => {
        const date = new Date(trade.timestamp);
        return [
          date.toLocaleDateString(),
          date.toLocaleTimeString(),
          trade.side,
          trade.symbol,
          trade.price.toFixed(2)
        ];
      });

      const csvContent = [headers, ...rows]
        .map(row => row.join(','))
        .join('\n');

      // Download CSV
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trades_${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export trades:', e);
    }
  });

  // Auto-refresh trades when tab is active
  setInterval(() => {
    const tradesTab = document.querySelector('.nav-tab[data-tab="trades"]');
    if (tradesTab.classList.contains('active')) {
      loadTrades();
    }
  }, 5000);

  // ============ SETTINGS TAB ============

  async function loadApiSettings() {
    try {
      const result = await chrome.storage.local.get(['optionsApiSettings']);
      const settings = result.optionsApiSettings || {};

      if (settings.apiUrl) apiUrlInput.value = settings.apiUrl;
      if (settings.apiKey) apiKeyInput.value = settings.apiKey;
      if (settings.apiHeader) apiHeaderInput.value = settings.apiHeader;
    } catch (e) {
      console.error('Failed to load API settings:', e);
    }
  }

  // Save API settings
  saveApiSettingsBtn.addEventListener('click', async () => {
    const settings = {
      apiUrl: apiUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      apiHeader: apiHeaderInput.value.trim() || 'X-API-Key'
    };

    try {
      await chrome.storage.local.set({ optionsApiSettings: settings });

      // Notify content script to reload options with new settings
      const tvTabs = await chrome.tabs.query({
        url: ['https://www.tradingview.com/chart/*', 'https://tradingview.com/chart/*']
      });

      tvTabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          type: 'API_SETTINGS_UPDATED',
          settings: settings
        }).catch(() => {});
      });

      // Show success feedback
      saveApiSettingsBtn.textContent = 'Saved!';
      saveApiSettingsBtn.style.background = 'linear-gradient(135deg, #26a69a 0%, #2e7d32 100%)';
      setTimeout(() => {
        saveApiSettingsBtn.textContent = 'Save Settings';
        saveApiSettingsBtn.style.background = '';
      }, 2000);

    } catch (e) {
      console.error('Failed to save API settings:', e);
    }
  });

  // Test API connection
  testApiBtn.addEventListener('click', async () => {
    const apiUrl = apiUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const apiHeader = apiHeaderInput.value.trim() || 'X-API-Key';

    if (!apiUrl) {
      showApiTestResult('error', 'Please enter an API URL');
      return;
    }

    // Use current symbol or default to AAPL for testing
    const testSymbol = currentSymbol ? currentSymbol.replace(/^[A-Z]+:/, '').toUpperCase() : 'AAPL';
    const testUrl = apiUrl.replace('{symbol}', testSymbol);

    testApiBtn.textContent = 'Testing...';
    testApiBtn.disabled = true;

    try {
      const headers = {};
      if (apiKey) {
        headers[apiHeader] = apiKey;
      }

      const response = await fetch(testUrl, { headers });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // Validate response format
      if (!data.strikes && !data.calls && !data.puts) {
        throw new Error('Invalid response format - missing strikes/calls/puts');
      }

      showApiTestResult('success',
        `Connected successfully!\n` +
        `Symbol: ${data.symbol || testSymbol}\n` +
        `Strikes: ${data.strikes?.length || 0}\n` +
        `Calls: ${data.calls?.length || 0}\n` +
        `Puts: ${data.puts?.length || 0}`
      );

    } catch (e) {
      showApiTestResult('error', `Connection failed: ${e.message}`);
    } finally {
      testApiBtn.textContent = 'Test API Connection';
      testApiBtn.disabled = false;
    }
  });

  function showApiTestResult(type, message) {
    apiTestResult.className = `api-test-result ${type}`;
    apiTestResult.textContent = message;
    apiTestResult.style.display = 'block';
  }
});
