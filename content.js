// TradingView Price Alert Extension - Content Script
// Reads price data from TradingView and draws alert lines on the chart

(function() {
  'use strict';

  let currentSymbol = '';
  let currentPrice = null;
  let previousPrice = null;
  let alertLevels = [];
  let priceLineElements = [];
  let pollInterval = null;
  let chartInfo = { minPrice: 0, maxPrice: 0, chartTop: 0, chartHeight: 0, chartLeft: 0, chartWidth: 0 };
  let optionsData = null;
  let optionsPanel = null;
  let lastOptionsSymbol = '';
  let optionsVisible = true;
  let apiSettings = { apiUrl: '', apiKey: '', apiHeader: 'X-API-Key' };
  let optionsDataSource = null; // 'api', 'yahoo', or 'mock'
  let orderWindowCounter = 0; // For unique order window IDs

  // Candle pattern detection state
  let candleStore = {}; // { "AAPL:60": [candles], "AAPL:D": [candles] }
  const MAX_CANDLES = 100;
  let patternDetector = null;
  let lastPatternCheck = 0;
  let detectedPatterns = [];
  let patternSettings = {
    enabled: true,
    minConfidence: 70,
    showToast: true,
    enabledPatterns: null // null = all enabled
  };

  // Dual column options chain state
  let dualColumnMode = false;
  let availableExpirations = [];
  let optionsDataCol1 = null;
  let optionsDataCol2 = null;
  let selectedExpiryIdx1 = 0;
  let selectedExpiryIdx2 = 1;

  // Initialize the extension
  function init() {
    console.log('[TV-Alert] Content script initialized');

    // Load API settings first
    loadApiSettings();
    loadPatternSettings();

    // Initialize pattern detector
    if (typeof PatternDetector !== 'undefined') {
      patternDetector = new PatternDetector({
        minConfidence: patternSettings.minConfidence,
        enabledPatterns: patternSettings.enabledPatterns
      });
      console.log('[TV-Alert] Pattern detector initialized');
    }

    // Listen for candle data from interceptor
    setupCandleInterceptListener();

    // Wait for chart to load
    waitForChart().then(() => {
      console.log('[TV-Alert] Chart detected, starting price monitoring');
      startPriceMonitoring();
      loadAlertLevels();
      setupMessageListener();
      createToastContainer();
      createTradingButtons();
      createOptionsPanel();
    });
  }

  // Load pattern detection settings
  function loadPatternSettings() {
    chrome.storage.local.get(['patternSettings'], (result) => {
      if (result.patternSettings) {
        patternSettings = { ...patternSettings, ...result.patternSettings };
        console.log('[TV-Alert] Loaded pattern settings');
      }
    });
  }

  // Listen for candle data from interceptor (via postMessage)
  function setupCandleInterceptListener() {
    window.addEventListener('message', (event) => {
      // Only accept messages from same window
      if (event.source !== window) return;

      const msg = event.data;
      if (msg && msg.type === 'TV_CANDLE_DATA' && msg.source === 'tv-interceptor') {
        console.log('[TV-Alert] Received candle data:', msg.data?.candles?.length, 'candles for', msg.data?.symbol);
        handleCandleData(msg.data);
      }
    });
    console.log('[TV-Alert] Candle intercept listener ready');
  }

  // Handle incoming candle data
  function handleCandleData(data) {
    if (!data || !data.candles || data.candles.length === 0) return;

    const { timeframe, candles, isRealtime } = data;
    // Use provided symbol or fall back to currentSymbol from page
    const symbol = data.symbol || currentSymbol || 'UNKNOWN';
    const key = `${symbol}:${timeframe}`;

    // Update candles with symbol if it was missing
    if (!data.symbol && symbol !== 'UNKNOWN') {
      candles.forEach(c => c.symbol = symbol);
    }

    console.log('[TV-Alert] Processing candles for key:', key, 'count:', candles.length);

    // Initialize store for this symbol/timeframe if needed
    if (!candleStore[key]) {
      candleStore[key] = [];
    }

    if (isRealtime) {
      // Real-time update: update or append the last candle
      const lastCandle = candles[0];
      const store = candleStore[key];

      if (store.length > 0) {
        const existing = store[store.length - 1];
        if (existing.timestamp === lastCandle.timestamp) {
          // Update existing candle
          store[store.length - 1] = lastCandle;
        } else {
          // New candle
          store.push(lastCandle);
          if (store.length > MAX_CANDLES) store.shift();
        }
      } else {
        store.push(lastCandle);
      }
    } else {
      // Historical data: replace or merge
      const store = candleStore[key];
      candles.forEach(candle => {
        const idx = store.findIndex(c => c.timestamp === candle.timestamp);
        if (idx >= 0) {
          store[idx] = candle;
        } else {
          store.push(candle);
        }
      });
      // Sort by timestamp and limit
      store.sort((a, b) => a.timestamp - b.timestamp);
      while (store.length > MAX_CANDLES) store.shift();
    }

    // Run pattern detection (debounced)
    runPatternDetection(key);
  }

  // Run pattern detection with debouncing
  function runPatternDetection(storeKey) {
    if (!patternSettings.enabled) {
      console.log('[TV-Alert] Pattern detection disabled');
      return;
    }
    if (!patternDetector) {
      console.log('[TV-Alert] Pattern detector not initialized');
      return;
    }

    const now = Date.now();
    if (now - lastPatternCheck < 1000) return; // Max once per second
    lastPatternCheck = now;

    const candles = candleStore[storeKey];
    if (!candles || candles.length < 3) {
      console.log('[TV-Alert] Not enough candles for pattern detection:', candles?.length || 0);
      return;
    }

    console.log('[TV-Alert] Running pattern detection on', candles.length, 'candles for', storeKey);
    const patterns = patternDetector.detect(candles);
    console.log('[TV-Alert] Detected', patterns.length, 'patterns');

    // Check for new patterns (not already detected)
    patterns.forEach(pattern => {
      const patternKey = `${pattern.name}-${pattern.timestamp}`;
      const alreadyDetected = detectedPatterns.some(p =>
        p.name === pattern.name && p.timestamp === pattern.timestamp
      );

      if (!alreadyDetected) {
        // Add to detected list
        detectedPatterns.push(pattern);
        if (detectedPatterns.length > 50) detectedPatterns.shift();

        // Show toast notification
        if (patternSettings.showToast) {
          showPatternToast(pattern);
        }

        // Notify sidepanel
        chrome.runtime.sendMessage({
          type: 'PATTERN_DETECTED',
          pattern: pattern
        }).catch(() => {});

        console.log('[TV-Alert] Pattern detected:', pattern.name, pattern.confidence + '%');
      }
    });
  }

  // Show toast for detected pattern
  function showPatternToast(pattern) {
    const icon = pattern.direction === 'bullish' ? '📈' : (pattern.direction === 'bearish' ? '📉' : '⚖️');
    const color = pattern.direction === 'bullish' ? '#26a69a' : (pattern.direction === 'bearish' ? '#ef5350' : '#ff9800');
    const toastType = pattern.direction === 'bullish' ? 'above' : (pattern.direction === 'bearish' ? 'below' : 'alert');

    showToast(
      `<strong style="color:${color}">${icon} ${pattern.name}</strong><br>` +
      `${pattern.symbol || currentSymbol} (${formatTimeframe(pattern.timeframe)})<br>` +
      `<span style="opacity:0.8">Confidence: ${pattern.confidence}%</span>`,
      toastType,
      5000
    );
  }

  // Format timeframe for display
  function formatTimeframe(tf) {
    if (!tf) return '';
    const map = {
      '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
      '60': '1h', '120': '2h', '240': '4h', '360': '6h', '480': '8h', '720': '12h',
      'D': 'Daily', '1D': 'Daily', 'W': 'Weekly', '1W': 'Weekly', 'M': 'Monthly', '1M': 'Monthly'
    };
    return map[tf] || tf;
  }

  // Load API settings from storage
  function loadApiSettings() {
    chrome.storage.local.get(['optionsApiSettings'], (result) => {
      if (result.optionsApiSettings) {
        apiSettings = result.optionsApiSettings;
        console.log('[TV-Alert] Loaded API settings:', apiSettings.apiUrl ? 'Custom API' : 'Mock data');
      }
    });
  }

  // ============ OPTIONS CHAIN PANEL ============

  function createOptionsPanel() {
    if (document.getElementById('tv-options-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'tv-options-panel';
    panel.style.cssText = `
      position: fixed;
      top: 100px;
      right: 60px;
      width: 180px;
      max-height: calc(100vh - 200px);
      background: rgba(20, 23, 31, 0.97);
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      z-index: 9998;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    `;

    // Header
    const header = document.createElement('div');
    header.id = 'options-header';
    header.style.cssText = `
      padding: 6px 8px;
      background: linear-gradient(135deg, rgba(41, 98, 255, 0.3), rgba(156, 39, 176, 0.2));
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: move;
    `;
    header.innerHTML = `
      <div style="display: flex; align-items: center; gap: 6px;">
        <span style="font-size: 11px; font-weight: 600; color: #fff;">TONYC</span>
        <span id="options-source" style="font-size: 8px; padding: 1px 4px; border-radius: 3px; cursor: help; display: none;"></span>
      </div>
      <div style="display: flex; align-items: center; gap: 4px;">
        <button id="dual-mode-toggle" title="Toggle dual expiry view" style="background: rgba(255,255,255,0.1); border: none; color: #808080; cursor: pointer; font-size: 10px; padding: 2px 5px; border-radius: 3px; font-weight: 600;">2x</button>
        <button id="options-toggle" style="background: none; border: none; color: #fff; cursor: pointer; font-size: 14px; padding: 0 2px; line-height: 1;">−</button>
      </div>
    `;
    panel.appendChild(header);

    // Date selector row (for column 1, or single mode)
    const dateRow1 = document.createElement('div');
    dateRow1.id = 'date-row-1';
    dateRow1.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px 6px;
      background: rgba(0, 0, 0, 0.2);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      gap: 4px;
    `;
    dateRow1.innerHTML = `
      <button class="date-nav prev-date" data-col="1" style="background:none;border:none;color:#606060;cursor:pointer;font-size:12px;padding:2px 4px;">◀</button>
      <select id="expiry-select-1" style="flex:1;padding:2px 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);border-radius:3px;color:#d1d4dc;font-size:9px;cursor:pointer;text-align:center;"></select>
      <button class="date-nav next-date" data-col="1" style="background:none;border:none;color:#606060;cursor:pointer;font-size:12px;padding:2px 4px;">▶</button>
    `;
    panel.appendChild(dateRow1);

    // Date selector row 2 (for dual mode only)
    const dateRow2 = document.createElement('div');
    dateRow2.id = 'date-row-2';
    dateRow2.style.cssText = `
      display: none;
      align-items: center;
      justify-content: center;
      padding: 4px 6px;
      background: rgba(156, 39, 176, 0.1);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      gap: 4px;
    `;
    dateRow2.innerHTML = `
      <button class="date-nav prev-date" data-col="2" style="background:none;border:none;color:#606060;cursor:pointer;font-size:12px;padding:2px 4px;">◀</button>
      <select id="expiry-select-2" style="flex:1;padding:2px 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);border-radius:3px;color:#d1d4dc;font-size:9px;cursor:pointer;text-align:center;"></select>
      <button class="date-nav next-date" data-col="2" style="background:none;border:none;color:#606060;cursor:pointer;font-size:12px;padding:2px 4px;">▶</button>
    `;
    panel.appendChild(dateRow2);

    // Column headers
    const colHeaders = document.createElement('div');
    colHeaders.id = 'options-col-headers';
    colHeaders.style.cssText = `
      display: flex;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.05);
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 8px;
      color: #a0a0a0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    `;
    colHeaders.innerHTML = `
      <div style="flex: 1; text-align: center; color: #26a69a;">C</div>
      <div style="width: 44px; text-align: center;">Strike</div>
      <div style="flex: 1; text-align: center; color: #ef5350;">P</div>
    `;
    panel.appendChild(colHeaders);

    // Options list container
    const listContainer = document.createElement('div');
    listContainer.id = 'options-list';
    listContainer.style.cssText = `
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
    `;
    listContainer.innerHTML = `<div id="options-loading" style="padding: 20px; text-align: center; color: #787b86; font-size: 11px;">Loading options...</div>`;
    panel.appendChild(listContainer);

    document.body.appendChild(panel);
    optionsPanel = panel;

    // Toggle collapse button
    document.getElementById('options-toggle').onclick = () => {
      optionsVisible = !optionsVisible;
      document.getElementById('date-row-1').style.display = optionsVisible ? 'flex' : 'none';
      document.getElementById('date-row-2').style.display = optionsVisible && dualColumnMode ? 'flex' : 'none';
      document.getElementById('options-col-headers').style.display = optionsVisible ? 'flex' : 'none';
      document.getElementById('options-list').style.display = optionsVisible ? 'block' : 'none';
      document.getElementById('options-toggle').textContent = optionsVisible ? '−' : '+';
    };

    // Dual mode toggle
    document.getElementById('dual-mode-toggle').onclick = () => {
      dualColumnMode = !dualColumnMode;
      const btn = document.getElementById('dual-mode-toggle');
      btn.style.background = dualColumnMode ? '#2962ff' : 'rgba(255,255,255,0.1)';
      btn.style.color = dualColumnMode ? '#fff' : '#808080';
      document.getElementById('date-row-2').style.display = dualColumnMode ? 'flex' : 'none';
      panel.style.width = dualColumnMode ? '320px' : '180px';
      updateColumnHeaders();
      renderOptionsChain();
    };

    // Date navigation buttons
    panel.querySelectorAll('.prev-date').forEach(btn => {
      btn.onclick = () => {
        const col = btn.dataset.col;
        if (col === '1' && selectedExpiryIdx1 > 0) {
          selectedExpiryIdx1--;
          document.getElementById('expiry-select-1').selectedIndex = selectedExpiryIdx1;
          fetchOptionsForExpiry(1);
        } else if (col === '2' && selectedExpiryIdx2 > 0) {
          selectedExpiryIdx2--;
          document.getElementById('expiry-select-2').selectedIndex = selectedExpiryIdx2;
          fetchOptionsForExpiry(2);
        }
      };
      btn.onmouseover = function() { this.style.color = '#fff'; };
      btn.onmouseout = function() { this.style.color = '#606060'; };
    });

    panel.querySelectorAll('.next-date').forEach(btn => {
      btn.onclick = () => {
        const col = btn.dataset.col;
        if (col === '1' && selectedExpiryIdx1 < availableExpirations.length - 1) {
          selectedExpiryIdx1++;
          document.getElementById('expiry-select-1').selectedIndex = selectedExpiryIdx1;
          fetchOptionsForExpiry(1);
        } else if (col === '2' && selectedExpiryIdx2 < availableExpirations.length - 1) {
          selectedExpiryIdx2++;
          document.getElementById('expiry-select-2').selectedIndex = selectedExpiryIdx2;
          fetchOptionsForExpiry(2);
        }
      };
      btn.onmouseover = function() { this.style.color = '#fff'; };
      btn.onmouseout = function() { this.style.color = '#606060'; };
    });

    // Make draggable
    makeDraggable(panel, header);

    // Load options after delay
    setTimeout(() => {
      if (currentSymbol) fetchOptionsData(currentSymbol);
    }, 2000);

    // Refresh on symbol change
    setInterval(() => {
      if (currentSymbol && currentSymbol !== lastOptionsSymbol) {
        fetchOptionsData(currentSymbol);
      }
    }, 3000);
  }

  function updateColumnHeaders() {
    const colHeaders = document.getElementById('options-col-headers');
    if (dualColumnMode) {
      // C2 (next) | C1 (today) | Strike | P1 (today) | P2 (next)
      colHeaders.innerHTML = `
        <div style="flex: 1; text-align: center; color: #26a69a;">C2</div>
        <div style="flex: 1; text-align: center; color: #26a69a;">C1</div>
        <div style="width: 44px; text-align: center;">Strike</div>
        <div style="flex: 1; text-align: center; color: #ef5350;">P1</div>
        <div style="flex: 1; text-align: center; color: #ef5350;">P2</div>
      `;
    } else {
      colHeaders.innerHTML = `
        <div style="flex: 1; text-align: center; color: #26a69a;">C</div>
        <div style="width: 44px; text-align: center;">Strike</div>
        <div style="flex: 1; text-align: center; color: #ef5350;">P</div>
      `;
    }
  }

  function populateExpirySelects() {
    const select1 = document.getElementById('expiry-select-1');
    const select2 = document.getElementById('expiry-select-2');
    if (!select1) return;

    const options = availableExpirations.map((exp, idx) => {
      const d = new Date(exp * 1000);
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
      return `<option value="${idx}">${label}</option>`;
    }).join('');

    select1.innerHTML = options;
    select2.innerHTML = options;

    select1.selectedIndex = selectedExpiryIdx1;
    select2.selectedIndex = Math.min(selectedExpiryIdx2, availableExpirations.length - 1);

    select1.onchange = () => {
      selectedExpiryIdx1 = parseInt(select1.value);
      fetchOptionsForExpiry(1);
    };

    select2.onchange = () => {
      selectedExpiryIdx2 = parseInt(select2.value);
      fetchOptionsForExpiry(2);
    };
  }

  function makeDraggable(el, handle) {
    let offsetX, offsetY, isDragging = false;
    handle.onmousedown = (e) => {
      isDragging = true;
      offsetX = e.clientX - el.getBoundingClientRect().left;
      offsetY = e.clientY - el.getBoundingClientRect().top;
    };
    document.onmousemove = (e) => {
      if (!isDragging) return;
      el.style.left = (e.clientX - offsetX) + 'px';
      el.style.top = (e.clientY - offsetY) + 'px';
      el.style.right = 'auto';
    };
    document.onmouseup = () => isDragging = false;
  }

  async function fetchOptionsData(symbol) {
    const cleanSymbol = symbol.replace(/^[A-Z]+:/, '').toUpperCase();
    if (cleanSymbol === lastOptionsSymbol) return;
    lastOptionsSymbol = cleanSymbol;

    const loading = document.getElementById('options-loading');
    if (loading) {
      loading.style.display = 'block';
      loading.textContent = `Loading ${cleanSymbol}...`;
    }

    // Try custom API if configured
    if (apiSettings.apiUrl) {
      try {
        const apiUrl = apiSettings.apiUrl.replace('{symbol}', cleanSymbol);
        const headers = {};
        if (apiSettings.apiKey) {
          headers[apiSettings.apiHeader || 'X-API-Key'] = apiSettings.apiKey;
        }

        console.log('[TV-Alert] Fetching from custom API:', apiUrl);
        const resp = await fetch(apiUrl, { headers });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        // Handle direct format (expected from custom API)
        if (data.strikes || data.calls || data.puts) {
          availableExpirations = data.expirationDates || [data.expirationDate];
          selectedExpiryIdx1 = 0;
          selectedExpiryIdx2 = Math.min(1, availableExpirations.length - 1);
          populateExpirySelects();

          optionsDataCol1 = {
            symbol: data.symbol || cleanSymbol,
            expirationDate: data.expirationDate,
            strikes: data.strikes || [],
            calls: data.calls || [],
            puts: data.puts || []
          };
          optionsData = optionsDataCol1;
          optionsDataSource = 'api';
          renderOptionsChain();
          console.log('[TV-Alert] Loaded options from custom API');
          return;
        }
      } catch (e) {
        console.log('[TV-Alert] Custom API failed:', e.message);
      }
    }

    // Try Yahoo Finance as fallback
    try {
      const resp = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${cleanSymbol}`);
      if (!resp.ok) throw new Error('Fetch failed');
      const data = await resp.json();

      if (data.optionChain?.result?.[0]) {
        const result = data.optionChain.result[0];
        availableExpirations = result.expirationDates || [];
        selectedExpiryIdx1 = 0;
        selectedExpiryIdx2 = Math.min(1, availableExpirations.length - 1);
        populateExpirySelects();

        optionsDataCol1 = {
          symbol: cleanSymbol,
          expirationDate: result.expirationDates?.[0],
          strikes: result.strikes || [],
          calls: result.options?.[0]?.calls || [],
          puts: result.options?.[0]?.puts || []
        };
        optionsData = optionsDataCol1;
        optionsDataSource = 'yahoo';

        // If dual mode, fetch second expiry
        if (dualColumnMode && availableExpirations.length > 1) {
          await fetchOptionsForExpiry(2);
        }

        renderOptionsChain();
        return;
      }
    } catch (e) {
      console.log('[TV-Alert] Yahoo Finance failed, using mock data');
    }

    // Generate mock data as last resort
    generateMockOptions(cleanSymbol);
  }

  async function fetchOptionsForExpiry(column) {
    const cleanSymbol = lastOptionsSymbol;
    const expiryIdx = column === 1 ? selectedExpiryIdx1 : selectedExpiryIdx2;
    const expiry = availableExpirations[expiryIdx];

    if (!expiry) return;

    try {
      // Yahoo Finance with specific expiration
      const resp = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${cleanSymbol}?date=${expiry}`);
      if (!resp.ok) throw new Error('Fetch failed');
      const data = await resp.json();

      if (data.optionChain?.result?.[0]) {
        const result = data.optionChain.result[0];
        const colData = {
          symbol: cleanSymbol,
          expirationDate: expiry,
          strikes: result.strikes || [],
          calls: result.options?.[0]?.calls || [],
          puts: result.options?.[0]?.puts || []
        };

        if (column === 1) {
          optionsDataCol1 = colData;
          optionsData = colData;
        } else {
          optionsDataCol2 = colData;
        }

        renderOptionsChain();
      }
    } catch (e) {
      console.log(`[TV-Alert] Failed to fetch expiry for column ${column}:`, e.message);
    }
  }

  function generateMockOptions(symbol) {
    if (!currentPrice) return;

    const strikes = [], calls = [], puts = [];
    const base = Math.round(currentPrice);
    const step = currentPrice > 100 ? 5 : (currentPrice > 10 ? 1 : 0.5);

    for (let i = -12; i <= 12; i++) {
      const strike = base + (i * step);
      if (strike <= 0) continue;
      strikes.push(strike);

      const diff = currentPrice - strike;
      const intrinsicCall = Math.max(0, diff);
      const intrinsicPut = Math.max(0, -diff);
      const tv = (Math.random() * 1.5 + 0.3) * (1 + Math.abs(i) * 0.08);

      calls.push({
        strike,
        lastPrice: +(intrinsicCall + tv).toFixed(2),
        bid: +(intrinsicCall + tv - 0.05).toFixed(2),
        ask: +(intrinsicCall + tv + 0.05).toFixed(2),
        inTheMoney: diff > 0
      });
      puts.push({
        strike,
        lastPrice: +(intrinsicPut + tv).toFixed(2),
        bid: +(intrinsicPut + tv - 0.05).toFixed(2),
        ask: +(intrinsicPut + tv + 0.05).toFixed(2),
        inTheMoney: -diff > 0
      });
    }

    const exp = new Date();
    exp.setDate(exp.getDate() + 30);
    optionsData = { symbol, expirationDate: Math.floor(exp.getTime() / 1000), strikes, calls, puts, isMock: true };
    optionsDataSource = 'mock';
    renderOptionsChain();
  }

  function updateSourceIndicator() {
    const sourceEl = document.getElementById('options-source');
    if (!sourceEl) return;

    const sources = {
      api: { letter: 'A', color: '#26a69a', tooltip: 'Data from Custom API' },
      yahoo: { letter: 'Y', color: '#2196f3', tooltip: 'Data from Yahoo Finance' },
      mock: { letter: 'M', color: '#ff9800', tooltip: 'Mock/Simulated Data' }
    };

    const src = sources[optionsDataSource];
    if (src) {
      sourceEl.textContent = src.letter;
      sourceEl.style.backgroundColor = src.color;
      sourceEl.style.color = '#fff';
      sourceEl.title = src.tooltip;
      sourceEl.style.display = 'inline';
    } else {
      sourceEl.style.display = 'none';
    }
  }

  function renderOptionsChain() {
    const data1 = optionsDataCol1 || optionsData;
    if (!data1) return;
    updateSourceIndicator();

    const list = document.getElementById('options-list');
    const loading = document.getElementById('options-loading');
    if (loading) loading.style.display = 'none';

    // Build maps for column 1
    const callMap1 = {}, putMap1 = {};
    data1.calls.forEach(c => callMap1[c.strike] = c);
    data1.puts.forEach(p => putMap1[p.strike] = p);

    // Build maps for column 2 (dual mode)
    const callMap2 = {}, putMap2 = {};
    if (dualColumnMode && optionsDataCol2) {
      optionsDataCol2.calls.forEach(c => callMap2[c.strike] = c);
      optionsDataCol2.puts.forEach(p => putMap2[p.strike] = p);
    }

    // Get all unique strikes from both columns
    let allStrikes = [...data1.strikes];
    if (dualColumnMode && optionsDataCol2) {
      optionsDataCol2.strikes.forEach(s => {
        if (!allStrikes.includes(s)) allStrikes.push(s);
      });
    }

    const visible = allStrikes.filter(s => {
      if (!currentPrice) return true;
      return Math.abs(s - currentPrice) / currentPrice < 0.12;
    }).sort((a, b) => b - a);

    let html = '';

    if (dualColumnMode) {
      // Dual column layout
      visible.forEach(strike => {
        const call1 = callMap1[strike];
        const put1 = putMap1[strike];
        const call2 = callMap2[strike];
        const put2 = putMap2[strike];
        const isATM = currentPrice && Math.abs(strike - currentPrice) < currentPrice * 0.008;
        const itmCall = currentPrice && strike < currentPrice;
        const itmPut = currentPrice && strike > currentPrice;

        // Order: C2 (next) | C1 (today) | Strike | P1 (today) | P2 (next)
        html += `
          <div class="opt-row" data-strike="${strike}" style="
            display: flex; align-items: center;
            padding: 4px 6px;
            border-bottom: 1px solid rgba(255,255,255,0.05);
            ${isATM ? 'background: linear-gradient(90deg, rgba(41,98,255,0.15), rgba(156,39,176,0.1)); border-left: 3px solid #2962ff;' : ''}
          ">
            <div class="opt-cell opt-call" data-type="call" data-col="2" style="
              flex: 1; text-align: center;
              padding: 3px 4px; margin: 1px;
              border-radius: 4px;
              font-size: 11px; font-weight: 500;
              cursor: pointer;
              background: ${itmCall ? 'rgba(38,166,154,0.25)' : 'rgba(38,166,154,0.1)'};
              color: #26a69a;
            " title="C2 ${strike}: ${call2?.bid?.toFixed(2) || '-'}/${call2?.ask?.toFixed(2) || '-'}">${call2 ? fmtOpt(call2.lastPrice) : '-'}</div>
            <div class="opt-cell opt-call" data-type="call" data-col="1" style="
              flex: 1; text-align: center;
              padding: 3px 4px; margin: 1px;
              border-radius: 4px;
              font-size: 11px; font-weight: 500;
              cursor: pointer;
              background: ${itmCall ? 'rgba(38,166,154,0.25)' : 'rgba(38,166,154,0.1)'};
              color: #26a69a;
            " title="C1 ${strike}: ${call1?.bid?.toFixed(2) || '-'}/${call1?.ask?.toFixed(2) || '-'}">${call1 ? fmtOpt(call1.lastPrice) : '-'}</div>
            <div style="
              width: 44px; text-align: center;
              font-size: 11px; font-weight: 600;
              color: ${isATM ? '#fff' : '#d1d4dc'};
            ">${strike}</div>
            <div class="opt-cell opt-put" data-type="put" data-col="1" style="
              flex: 1; text-align: center;
              padding: 3px 4px; margin: 1px;
              border-radius: 4px;
              font-size: 11px; font-weight: 500;
              cursor: pointer;
              background: ${itmPut ? 'rgba(239,83,80,0.25)' : 'rgba(239,83,80,0.1)'};
              color: #ef5350;
            " title="P1 ${strike}: ${put1?.bid?.toFixed(2) || '-'}/${put1?.ask?.toFixed(2) || '-'}">${put1 ? fmtOpt(put1.lastPrice) : '-'}</div>
            <div class="opt-cell opt-put" data-type="put" data-col="2" style="
              flex: 1; text-align: center;
              padding: 3px 4px; margin: 1px;
              border-radius: 4px;
              font-size: 11px; font-weight: 500;
              cursor: pointer;
              background: ${itmPut ? 'rgba(239,83,80,0.25)' : 'rgba(239,83,80,0.1)'};
              color: #ef5350;
            " title="P2 ${strike}: ${put2?.bid?.toFixed(2) || '-'}/${put2?.ask?.toFixed(2) || '-'}">${put2 ? fmtOpt(put2.lastPrice) : '-'}</div>
          </div>
        `;
      });
    } else {
      // Single column layout
      visible.forEach(strike => {
        const call = callMap1[strike];
        const put = putMap1[strike];
        const isATM = currentPrice && Math.abs(strike - currentPrice) < currentPrice * 0.008;
        const itmCall = currentPrice && strike < currentPrice;
        const itmPut = currentPrice && strike > currentPrice;

        html += `
          <div class="opt-row" data-strike="${strike}" style="
            display: flex; align-items: center;
            padding: 4px 6px;
            border-bottom: 1px solid rgba(255,255,255,0.05);
            ${isATM ? 'background: linear-gradient(90deg, rgba(41,98,255,0.15), rgba(156,39,176,0.1)); border-left: 3px solid #2962ff;' : ''}
            transition: background 0.15s;
          " data-atm="${isATM}">
            <div class="opt-cell opt-call" data-type="call" data-col="1" style="
              flex: 1; text-align: center;
              padding: 3px 4px; margin: 1px;
              border-radius: 4px;
              font-size: 11px; font-weight: 500;
              cursor: pointer;
              background: ${itmCall ? 'rgba(38,166,154,0.25)' : 'rgba(38,166,154,0.1)'};
              color: #26a69a;
              transition: all 0.15s;
            " title="C ${strike}: ${call?.bid?.toFixed(2) || '-'} / ${call?.ask?.toFixed(2) || '-'}">${call ? fmtOpt(call.lastPrice) : '-'}</div>
            <div style="
              width: 48px; text-align: center;
              font-size: 11px; font-weight: 600;
              color: ${isATM ? '#fff' : '#d1d4dc'};
            ">${strike}</div>
            <div class="opt-cell opt-put" data-type="put" data-col="1" style="
              flex: 1; text-align: center;
              padding: 3px 4px; margin: 1px;
              border-radius: 4px;
              font-size: 11px; font-weight: 500;
              cursor: pointer;
              background: ${itmPut ? 'rgba(239,83,80,0.25)' : 'rgba(239,83,80,0.1)'};
              color: #ef5350;
              transition: all 0.15s;
            " title="P ${strike}: ${put?.bid?.toFixed(2) || '-'} / ${put?.ask?.toFixed(2) || '-'}">${put ? fmtOpt(put.lastPrice) : '-'}</div>
          </div>
        `;
      });
    }

    list.innerHTML = html;

    // Row hover handlers (for single column mode)
    list.querySelectorAll('.opt-row').forEach(row => {
      const isATM = row.dataset.atm === 'true';
      const defaultBg = isATM ? 'linear-gradient(90deg, rgba(41,98,255,0.15), rgba(156,39,176,0.1))' : '';
      row.addEventListener('mouseenter', () => {
        row.style.background = 'rgba(255,255,255,0.08)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = defaultBg;
      });
    });

    // Click handlers
    list.querySelectorAll('.opt-cell').forEach(el => {
      el.onclick = (e) => {
        const row = e.target.closest('.opt-row');
        const strike = +row.dataset.strike;
        const isCall = e.target.dataset.type === 'call';
        const col = e.target.dataset.col;

        // Get option from correct column
        let opt;
        if (col === '2' && dualColumnMode) {
          opt = isCall ? callMap2[strike] : putMap2[strike];
        } else {
          opt = isCall ? callMap1[strike] : putMap1[strike];
        }

        if (opt) {
          // Pass expiration date for the order window
          const expDate = col === '2' ? optionsDataCol2?.expirationDate : data1.expirationDate;
          createOrderWindow(opt, isCall, strike, expDate);
        }
      };
      el.addEventListener('mouseenter', () => { el.style.transform = 'scale(1.03)'; });
      el.addEventListener('mouseleave', () => { el.style.transform = 'scale(1)'; });
    });

    // Scroll to ATM
    setTimeout(() => {
      const rows = list.querySelectorAll('.opt-row');
      let closest = null, minD = Infinity;
      rows.forEach(r => {
        const d = Math.abs(+r.dataset.strike - currentPrice);
        if (d < minD) { minD = d; closest = r; }
      });
      if (closest) closest.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 100);
  }

  function fmtOpt(p) {
    if (!p || p === 0) return '-';
    return p >= 10 ? p.toFixed(1) : p.toFixed(2);
  }

  function createOrderWindow(optionData, isCall, strike, expirationDate) {
    orderWindowCounter++;
    const windowId = `order-window-${orderWindowCounter}`;
    const symbol = optionsData?.symbol || currentSymbol;
    const optType = isCall ? 'C' : 'P';
    const optColor = isCall ? '#26a69a' : '#ef5350';

    const bid = optionData?.bid || 0;
    const ask = optionData?.ask || 0;
    const mid = ((bid + ask) / 2) || optionData?.lastPrice || 0;

    // Format expiration date
    let expLabel = '';
    if (expirationDate) {
      const d = new Date(expirationDate * 1000);
      expLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    const win = document.createElement('div');
    win.id = windowId;
    win.className = 'tv-order-window';
    win.style.cssText = `
      position: fixed;
      top: ${100 + (orderWindowCounter % 5) * 25}px;
      left: ${150 + (orderWindowCounter % 5) * 25}px;
      width: 420px;
      background: linear-gradient(145deg, #1e222d, #252932);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 6px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      z-index: 10001;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #d1d4dc;
    `;

    // Add style to hide number input spinners
    const style = document.createElement('style');
    style.textContent = `
      .tv-order-window input[type=number]::-webkit-inner-spin-button,
      .tv-order-window input[type=number]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .tv-order-window input[type=number] {
        -moz-appearance: textfield;
      }
    `;
    if (!document.getElementById('tv-order-window-styles')) {
      style.id = 'tv-order-window-styles';
      document.head.appendChild(style);
    }

    win.innerHTML = `
      <div class="order-header" style="
        padding: 5px 8px;
        background: rgba(0,0,0,0.3);
        cursor: move;
        display: flex;
        justify-content: space-between;
        align-items: center;
      ">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="font-size: 11px; font-weight: 600; color: #fff;">${symbol}</span>
          <span style="font-size: 10px; color: ${optColor}; font-weight: 600;">${strike}${optType}</span>
          ${expLabel ? `<span style="font-size: 9px; color: #a0a0a0;">${expLabel}</span>` : ''}
        </div>
        <button class="order-close" style="background:none;border:none;color:#606060;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;">&times;</button>
      </div>

      <div style="padding: 8px; display: flex; gap: 8px;">
        <!-- Left: Large Bid/Ask buttons -->
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <button class="bid-btn" style="
            padding: 8px 12px;
            border: none;
            border-radius: 4px;
            background: rgba(38,166,154,0.2);
            color: #26a69a;
            font-weight: 700;
            font-size: 14px;
            cursor: pointer;
            min-width: 70px;
            transition: all 0.15s;
          " title="Click to set price to bid">
            <div style="font-size: 9px; font-weight: 500; opacity: 0.7;">BID</div>
            ${bid.toFixed(2)}
          </button>
          <button class="ask-btn" style="
            padding: 8px 12px;
            border: none;
            border-radius: 4px;
            background: rgba(239,83,80,0.2);
            color: #ef5350;
            font-weight: 700;
            font-size: 14px;
            cursor: pointer;
            min-width: 70px;
            transition: all 0.15s;
          " title="Click to set price to ask">
            <div style="font-size: 9px; font-weight: 500; opacity: 0.7;">ASK</div>
            ${ask.toFixed(2)}
          </button>
        </div>

        <!-- Right: Order controls -->
        <div style="flex: 1; display: flex; flex-direction: column; gap: 6px;">
          <!-- Row 1: Buy/Sell toggle + Order Type + TIF -->
          <div style="display: flex; gap: 6px; align-items: center;">
            <div class="order-side-toggle" style="display:flex; border-radius:3px; overflow:hidden; border:1px solid rgba(255,255,255,0.1);">
              <button class="side-btn buy-btn active" data-side="buy" style="padding:4px 10px;border:none;cursor:pointer;font-weight:600;font-size:10px;background:#26a69a;color:#fff;">BUY</button>
              <button class="side-btn sell-btn" data-side="sell" style="padding:4px 10px;border:none;cursor:pointer;font-weight:600;font-size:10px;background:rgba(255,255,255,0.05);color:#606060;">SELL</button>
            </div>
            <select class="order-type-select" style="flex:1;padding:4px 6px;border:1px solid rgba(255,255,255,0.1);border-radius:3px;background:rgba(0,0,0,0.3);color:#d1d4dc;font-size:10px;cursor:pointer;">
              <option value="limit">Limit</option>
              <option value="market">Market</option>
              <option value="stop">Stop</option>
              <option value="stop_limit">Stop Lmt</option>
            </select>
            <select class="order-tif-select" style="width:50px;padding:4px 6px;border:1px solid rgba(255,255,255,0.1);border-radius:3px;background:rgba(0,0,0,0.3);color:#d1d4dc;font-size:10px;cursor:pointer;">
              <option value="day">Day</option>
              <option value="gtc">GTC</option>
              <option value="ioc">IOC</option>
              <option value="fok">FOK</option>
            </select>
          </div>

          <!-- Row 2: Price + Qty + Presets -->
          <div style="display: flex; gap: 6px; align-items: center;">
            <div class="price-row" style="display:flex;align-items:center;gap:2px;">
              <button class="price-btn price-down" style="width:22px;height:24px;border:1px solid rgba(255,255,255,0.1);border-radius:3px;background:rgba(0,0,0,0.3);color:#d1d4dc;cursor:pointer;font-size:14px;font-weight:bold;">−</button>
              <input type="text" class="price-input" value="${mid.toFixed(2)}" style="width:58px;padding:4px 6px;border:1px solid rgba(255,255,255,0.1);border-radius:3px;background:rgba(0,0,0,0.3);color:#fff;font-size:11px;font-weight:600;text-align:center;">
              <button class="price-btn price-up" style="width:22px;height:24px;border:1px solid rgba(255,255,255,0.1);border-radius:3px;background:rgba(0,0,0,0.3);color:#d1d4dc;cursor:pointer;font-size:14px;font-weight:bold;">+</button>
            </div>
            <div style="display:flex;align-items:center;gap:2px;">
              <button class="qty-btn qty-down" style="width:22px;height:24px;border:1px solid rgba(255,255,255,0.1);border-radius:3px;background:rgba(0,0,0,0.3);color:#d1d4dc;cursor:pointer;font-size:14px;font-weight:bold;">−</button>
              <input type="text" class="qty-input" value="1" style="width:36px;padding:4px 6px;border:1px solid rgba(255,255,255,0.1);border-radius:3px;background:rgba(0,0,0,0.3);color:#fff;font-size:11px;font-weight:600;text-align:center;">
              <button class="qty-btn qty-up" style="width:22px;height:24px;border:1px solid rgba(255,255,255,0.1);border-radius:3px;background:rgba(0,0,0,0.3);color:#d1d4dc;cursor:pointer;font-size:14px;font-weight:bold;">+</button>
            </div>
            <div style="display:flex;gap:2px;">
              <button class="qty-preset" data-qty="1" style="padding:4px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:2px;background:rgba(0,0,0,0.2);color:#606060;cursor:pointer;font-size:9px;">1</button>
              <button class="qty-preset" data-qty="5" style="padding:4px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:2px;background:rgba(0,0,0,0.2);color:#606060;cursor:pointer;font-size:9px;">5</button>
              <button class="qty-preset" data-qty="10" style="padding:4px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:2px;background:rgba(0,0,0,0.2);color:#606060;cursor:pointer;font-size:9px;">10</button>
              <button class="qty-preset" data-qty="25" style="padding:4px 6px;border:1px solid rgba(255,255,255,0.08);border-radius:2px;background:rgba(0,0,0,0.2);color:#606060;cursor:pointer;font-size:9px;">25</button>
            </div>
          </div>

          <!-- Row 3: Auto toggle + Total + Submit -->
          <div style="display: flex; gap: 6px; align-items: center;">
            <div class="auto-toggle" style="display:flex;align-items:center;gap:4px;padding:4px 6px;background:rgba(0,0,0,0.2);border-radius:3px;cursor:pointer;" title="Auto: Submit order immediately">
              <span style="font-size:9px;color:#606060;">AUTO</span>
              <div class="toggle-switch" style="width:24px;height:14px;background:rgba(255,255,255,0.1);border-radius:7px;position:relative;transition:background 0.2s;">
                <div class="toggle-knob" style="width:10px;height:10px;background:#606060;border-radius:50%;position:absolute;top:2px;left:2px;transition:all 0.2s;"></div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:4px;padding:4px 6px;background:rgba(0,0,0,0.2);border-radius:3px;">
              <span style="font-size:9px;color:#606060;">$</span>
              <span class="order-total" style="font-size:11px;font-weight:600;color:#fff;">${(mid * 100).toFixed(2)}</span>
            </div>
            <button class="order-submit" style="flex:1;padding:6px 12px;border:none;border-radius:3px;background:#26a69a;color:#fff;font-weight:600;font-size:11px;cursor:pointer;text-transform:uppercase;">Buy</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const header = win.querySelector('.order-header');
    let offsetX, offsetY, isDragging = false;
    header.onmousedown = (e) => {
      if (e.target.classList.contains('order-close')) return;
      isDragging = true;
      offsetX = e.clientX - win.getBoundingClientRect().left;
      offsetY = e.clientY - win.getBoundingClientRect().top;
      win.style.zIndex = 10002;
      document.querySelectorAll('.tv-order-window').forEach(w => {
        if (w !== win) w.style.zIndex = 10001;
      });
    };
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      win.style.left = (e.clientX - offsetX) + 'px';
      win.style.top = (e.clientY - offsetY) + 'px';
    });
    document.addEventListener('mouseup', () => isDragging = false);

    // Close button
    win.querySelector('.order-close').onclick = () => win.remove();
    win.querySelector('.order-close').onmouseover = function() { this.style.color = '#fff'; };
    win.querySelector('.order-close').onmouseout = function() { this.style.color = '#808080'; };

    // Buy/Sell toggle
    const buyBtn = win.querySelector('.buy-btn');
    const sellBtn = win.querySelector('.sell-btn');
    const submitBtn = win.querySelector('.order-submit');
    let currentSide = 'buy';

    const updateSide = (side) => {
      currentSide = side;
      if (side === 'buy') {
        buyBtn.style.background = '#26a69a';
        buyBtn.style.color = '#fff';
        sellBtn.style.background = 'rgba(255,255,255,0.05)';
        sellBtn.style.color = '#606060';
        submitBtn.style.background = '#26a69a';
        submitBtn.textContent = 'Buy';
      } else {
        sellBtn.style.background = '#ef5350';
        sellBtn.style.color = '#fff';
        buyBtn.style.background = 'rgba(255,255,255,0.05)';
        buyBtn.style.color = '#606060';
        submitBtn.style.background = '#ef5350';
        submitBtn.textContent = 'Sell';
      }
    };
    buyBtn.onclick = () => updateSide('buy');
    sellBtn.onclick = () => updateSide('sell');

    // Auto toggle
    const autoToggle = win.querySelector('.auto-toggle');
    const toggleSwitch = win.querySelector('.toggle-switch');
    const toggleKnob = win.querySelector('.toggle-knob');
    let autoSubmit = false;

    autoToggle.onclick = () => {
      autoSubmit = !autoSubmit;
      if (autoSubmit) {
        toggleSwitch.style.background = '#26a69a';
        toggleKnob.style.left = '12px';
        toggleKnob.style.background = '#fff';
      } else {
        toggleSwitch.style.background = 'rgba(255,255,255,0.1)';
        toggleKnob.style.left = '2px';
        toggleKnob.style.background = '#606060';
      }
    };

    // Order type change - show/hide price input for market orders
    const orderTypeSelect = win.querySelector('.order-type-select');
    const priceRow = win.querySelector('.price-row');
    orderTypeSelect.onchange = () => {
      priceRow.style.display = orderTypeSelect.value === 'market' ? 'none' : 'flex';
      updateTotal();
    };

    // Price input and +/- buttons
    const priceInput = win.querySelector('.price-input');
    priceInput.oninput = updateTotal;

    // Helper to get valid price
    const getPrice = () => {
      const val = parseFloat(priceInput.value);
      return isNaN(val) ? mid : val;
    };

    win.querySelector('.price-down').onclick = () => {
      priceInput.value = Math.max(0.01, getPrice() - 0.05).toFixed(2);
      updateTotal();
    };
    win.querySelector('.price-up').onclick = () => {
      priceInput.value = (getPrice() + 0.05).toFixed(2);
      updateTotal();
    };

    // Bid/Ask buttons - click to set price
    const bidBtn = win.querySelector('.bid-btn');
    const askBtn = win.querySelector('.ask-btn');
    bidBtn.onclick = () => {
      priceInput.value = bid.toFixed(2);
      updateTotal();
    };
    askBtn.onclick = () => {
      priceInput.value = ask.toFixed(2);
      updateTotal();
    };
    bidBtn.onmouseover = function() { this.style.background = 'rgba(38,166,154,0.35)'; };
    bidBtn.onmouseout = function() { this.style.background = 'rgba(38,166,154,0.2)'; };
    askBtn.onmouseover = function() { this.style.background = 'rgba(239,83,80,0.35)'; };
    askBtn.onmouseout = function() { this.style.background = 'rgba(239,83,80,0.2)'; };

    // Quantity input and +/- buttons
    const qtyInput = win.querySelector('.qty-input');
    qtyInput.oninput = updateTotal;

    // Helper to get valid quantity
    const getQty = () => {
      const val = parseInt(qtyInput.value);
      return isNaN(val) || val < 1 ? 1 : val;
    };

    win.querySelector('.qty-down').onclick = () => {
      qtyInput.value = Math.max(1, getQty() - 1);
      updateTotal();
    };
    win.querySelector('.qty-up').onclick = () => {
      qtyInput.value = getQty() + 1;
      updateTotal();
    };

    // +/- button hover effects
    win.querySelectorAll('.price-btn, .qty-btn').forEach(btn => {
      btn.onmouseover = function() { this.style.background = 'rgba(255,255,255,0.15)'; };
      btn.onmouseout = function() { this.style.background = 'rgba(0,0,0,0.3)'; };
    });

    // Quantity presets
    win.querySelectorAll('.qty-preset').forEach(btn => {
      btn.onclick = () => {
        qtyInput.value = btn.dataset.qty;
        updateTotal();
      };
      btn.onmouseover = function() { this.style.background = 'rgba(255,255,255,0.15)'; this.style.color = '#fff'; };
      btn.onmouseout = function() { this.style.background = 'rgba(0,0,0,0.2)'; this.style.color = '#606060'; };
    });

    // Update total
    const totalEl = win.querySelector('.order-total');
    function updateTotal() {
      const price = orderTypeSelect.value === 'market' ? (currentSide === 'buy' ? ask : bid) : getPrice();
      const qty = getQty();
      const total = price * qty * 100; // Options are 100 shares per contract
      totalEl.textContent = total.toFixed(2);
    }

    // Submit button hover
    submitBtn.onmouseover = function() { this.style.filter = 'brightness(1.1)'; };
    submitBtn.onmouseout = function() { this.style.filter = 'brightness(1)'; };
    submitBtn.onclick = async () => {
      const orderType = orderTypeSelect.value;
      const tif = win.querySelector('.order-tif-select').value;
      const price = orderType === 'market' ? (currentSide === 'buy' ? ask : bid) : getPrice();
      const qty = getQty();

      // Create order object
      const order = {
        id: `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        symbol: symbol,
        strike: strike,
        optionType: optType,
        side: currentSide.toUpperCase(),
        orderType: orderType,
        tif: tif,
        price: price,
        qty: qty,
        total: price * qty * 100,
        status: autoSubmit ? 'active' : 'saved',
        timestamp: Date.now()
      };

      // Save to chrome storage
      try {
        const result = await chrome.storage.local.get(['optionOrders']);
        const orders = result.optionOrders || [];
        orders.unshift(order); // Add to beginning
        await chrome.storage.local.set({ optionOrders: orders });

        // Notify sidepanel
        chrome.runtime.sendMessage({ type: 'ORDER_CREATED', order: order }).catch(() => {});

        // Show toast
        const statusText = autoSubmit ? 'SUBMITTED' : 'SAVED';
        const statusColor = autoSubmit ? '#26a69a' : '#ff9800';
        showToast(
          `<strong style="color:${statusColor}">${statusText}</strong><br>${order.side} ${qty}x ${symbol} ${strike}${optType}<br>${orderType.toUpperCase()} @ $${price.toFixed(2)}`,
          currentSide === 'buy' ? 'above' : 'below',
          3000
        );

        // Close window after submit
        win.remove();
      } catch (e) {
        console.error('[TV-Alert] Failed to save order:', e);
        showToast('<strong style="color:#ef5350">Error</strong><br>Failed to save order', 'below', 3000);
      }
    };

    }

  // ============ END OPTIONS CHAIN ============

  // Create Buy/Sell trading buttons
  function createTradingButtons() {
    if (document.getElementById('tv-alert-trading-buttons')) return;

    const container = document.createElement('div');
    container.id = 'tv-alert-trading-buttons';
    container.style.cssText = `
      position: fixed;
      top: 60px;
      right: 320px;
      z-index: 9999;
      display: flex;
      gap: 8px;
      padding: 8px;
      background: rgba(30, 34, 45, 0.95);
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    // Price display
    const priceDisplay = document.createElement('div');
    priceDisplay.id = 'tv-trading-price';
    priceDisplay.style.cssText = `
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 0 12px;
      border-right: 1px solid rgba(255, 255, 255, 0.1);
      min-width: 80px;
    `;
    priceDisplay.innerHTML = `
      <div style="font-size: 10px; color: #787b86; text-transform: uppercase;">Price</div>
      <div id="tv-trading-price-value" style="font-size: 16px; font-weight: 600; color: #fff;">--</div>
    `;
    container.appendChild(priceDisplay);

    // Buy button
    const buyBtn = document.createElement('button');
    buyBtn.id = 'tv-buy-btn';
    buyBtn.innerHTML = `
      <div style="font-size: 10px; opacity: 0.8;">LONG</div>
      <div style="font-size: 14px; font-weight: 700;">BUY</div>
    `;
    buyBtn.style.cssText = `
      background: linear-gradient(135deg, #26a69a 0%, #2e7d32 100%);
      border: none;
      color: white;
      padding: 8px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.2s ease;
      min-width: 70px;
      box-shadow: 0 2px 8px rgba(38, 166, 154, 0.3);
    `;
    buyBtn.onmouseenter = () => {
      buyBtn.style.transform = 'scale(1.05)';
      buyBtn.style.boxShadow = '0 4px 15px rgba(38, 166, 154, 0.5)';
    };
    buyBtn.onmouseleave = () => {
      buyBtn.style.transform = 'scale(1)';
      buyBtn.style.boxShadow = '0 2px 8px rgba(38, 166, 154, 0.3)';
    };
    buyBtn.onclick = () => handleTradeClick('BUY');
    container.appendChild(buyBtn);

    // Sell button
    const sellBtn = document.createElement('button');
    sellBtn.id = 'tv-sell-btn';
    sellBtn.innerHTML = `
      <div style="font-size: 10px; opacity: 0.8;">SHORT</div>
      <div style="font-size: 14px; font-weight: 700;">SELL</div>
    `;
    sellBtn.style.cssText = `
      background: linear-gradient(135deg, #ef5350 0%, #c62828 100%);
      border: none;
      color: white;
      padding: 8px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.2s ease;
      min-width: 70px;
      box-shadow: 0 2px 8px rgba(239, 83, 80, 0.3);
    `;
    sellBtn.onmouseenter = () => {
      sellBtn.style.transform = 'scale(1.05)';
      sellBtn.style.boxShadow = '0 4px 15px rgba(239, 83, 80, 0.5)';
    };
    sellBtn.onmouseleave = () => {
      sellBtn.style.transform = 'scale(1)';
      sellBtn.style.boxShadow = '0 2px 8px rgba(239, 83, 80, 0.3)';
    };
    sellBtn.onclick = () => handleTradeClick('SELL');
    container.appendChild(sellBtn);

    document.body.appendChild(container);

    // Start updating price display
    setInterval(updateTradingPriceDisplay, 200);
  }

  // Update the price display in trading buttons
  function updateTradingPriceDisplay() {
    const priceEl = document.getElementById('tv-trading-price-value');
    if (priceEl && currentPrice) {
      priceEl.textContent = formatPrice(currentPrice);
    }
  }

  // Handle trade button click
  function handleTradeClick(side) {
    const price = currentPrice;
    const symbol = currentSymbol;

    console.log(`[TV-Alert] ${side} clicked - ${symbol} @ ${price}`);

    // Visual feedback
    const btn = document.getElementById(side === 'BUY' ? 'tv-buy-btn' : 'tv-sell-btn');
    if (btn) {
      btn.style.transform = 'scale(0.95)';
      setTimeout(() => {
        btn.style.transform = 'scale(1)';
      }, 100);
    }

    // Show confirmation toast
    const color = side === 'BUY' ? 'above' : 'below';
    showToast(
      `<strong>${side} ORDER</strong><br>${symbol} @ ${formatPrice(price)}`,
      color,
      3000
    );

    // Send message to background script
    chrome.runtime.sendMessage({
      type: 'TRADE_SIGNAL',
      data: {
        side: side,
        symbol: symbol,
        price: price,
        timestamp: Date.now()
      }
    }).catch(() => {});

    // Store trade in history
    storeTrade(side, symbol, price);
  }

  // Store trade in local storage
  function storeTrade(side, symbol, price) {
    chrome.storage.local.get(['tradeHistory'], (result) => {
      const history = result.tradeHistory || [];
      history.unshift({
        id: Date.now().toString(36),
        side: side,
        symbol: symbol,
        price: price,
        timestamp: Date.now()
      });
      // Keep last 100 trades
      if (history.length > 100) history.pop();
      chrome.storage.local.set({ tradeHistory: history });
    });
  }

  // Create toast notification container
  function createToastContainer() {
    if (document.getElementById('tv-alert-toast-container')) return;

    const container = document.createElement('div');
    container.id = 'tv-alert-toast-container';
    container.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    `;
    document.body.appendChild(container);
  }

  // Show toast notification on screen
  function showToast(message, type = 'alert', duration = 5000) {
    const container = document.getElementById('tv-alert-toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `tv-alert-toast ${type}`;

    const colors = {
      above: { bg: '#1b5e20', border: '#4caf50', icon: '📈' },
      below: { bg: '#b71c1c', border: '#f44336', icon: '📉' },
      alert: { bg: '#e65100', border: '#ff9800', icon: '🔔' }
    };

    const style = colors[type] || colors.alert;

    toast.style.cssText = `
      background: ${style.bg};
      border-left: 4px solid ${style.border};
      color: white;
      padding: 16px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      animation: tv-alert-slide-in 0.3s ease-out;
      pointer-events: auto;
      cursor: pointer;
      min-width: 280px;
    `;

    toast.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px;">
        <span style="font-size: 24px;">${style.icon}</span>
        <div>
          <div style="font-weight: 600; margin-bottom: 4px;">ALERT TRIGGERED!</div>
          <div style="opacity: 0.9;">${message}</div>
        </div>
      </div>
    `;

    toast.onclick = () => toast.remove();
    container.appendChild(toast);

    // Auto remove
    setTimeout(() => {
      toast.style.animation = 'tv-alert-slide-out 0.3s ease-in forwards';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // Play alert sound
  function playAlertSound() {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Create a beep sound
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = 800;
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);

      // Second beep
      setTimeout(() => {
        const osc2 = audioContext.createOscillator();
        const gain2 = audioContext.createGain();
        osc2.connect(gain2);
        gain2.connect(audioContext.destination);
        osc2.frequency.value = 1000;
        osc2.type = 'sine';
        gain2.gain.setValueAtTime(0.3, audioContext.currentTime);
        gain2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
        osc2.start(audioContext.currentTime);
        osc2.stop(audioContext.currentTime + 0.5);
      }, 200);
    } catch (e) {
      console.log('[TV-Alert] Could not play sound:', e);
    }
  }

  // Wait for the TradingView chart to be ready
  function waitForChart() {
    return new Promise((resolve) => {
      const checkChart = () => {
        const priceElement = document.querySelector('[class*="lastPrice"]') ||
                           document.querySelector('[class*="currentPrice"]') ||
                           document.querySelector('.tv-symbol-price-quote__value') ||
                           document.querySelector('[data-name="legend-source-item"]');

        if (priceElement || document.querySelector('.chart-container')) {
          resolve();
        } else {
          setTimeout(checkChart, 500);
        }
      };
      checkChart();
    });
  }

  // Extract current price from TradingView DOM
  function getCurrentPrice() {
    // Method 1: Try to get from the price axis (right side of chart)
    const priceAxisValue = document.querySelector('[class*="price-axis"] [class*="last"]');
    if (priceAxisValue) {
      const price = parsePrice(priceAxisValue.textContent);
      if (price) return price;
    }

    // Method 2: Look for the floating price label on the chart
    const priceLabels = document.querySelectorAll('[class*="priceLabel"], [class*="price-label"]');
    for (const label of priceLabels) {
      const price = parsePrice(label.textContent);
      if (price) return price;
    }

    // Method 3: Header price display (OHLC values)
    const headerPrice = document.querySelector('[class*="valuesWrapper"] [class*="value"]');
    if (headerPrice) {
      const price = parsePrice(headerPrice.textContent);
      if (price) return price;
    }

    // Method 4: Try to get from the legend source items (shows current close price)
    const legendItems = document.querySelectorAll('[data-name="legend-source-item"] [class*="value"]');
    if (legendItems.length >= 4) {
      const closePrice = parsePrice(legendItems[3].textContent);
      if (closePrice) return closePrice;
    }

    // Method 5: Look for any element containing the price near the chart
    const allPriceElements = document.querySelectorAll('[class*="price"]');
    for (const el of allPriceElements) {
      if (el.textContent && el.textContent.length < 20) {
        const price = parsePrice(el.textContent);
        if (price && price > 0) return price;
      }
    }

    // Method 6: Parse from URL or page title
    const titleMatch = document.title.match(/(\d+\.?\d*)/);
    if (titleMatch) {
      return parseFloat(titleMatch[1]);
    }

    return null;
  }

  // Parse price string to number
  function parsePrice(str) {
    if (!str) return null;
    const cleaned = str.replace(/[^0-9.-]/g, '');
    const price = parseFloat(cleaned);
    return isNaN(price) ? null : price;
  }

  // Get current symbol from TradingView
  function getCurrentSymbol() {
    const symbolElement = document.querySelector('[class*="title"] [class*="symbol"]') ||
                         document.querySelector('[data-name="legend-series-item"] [class*="title"]') ||
                         document.querySelector('.tv-symbol-header__short-name');

    if (symbolElement) {
      return symbolElement.textContent.trim();
    }

    const titleParts = document.title.split(' ');
    if (titleParts.length > 0) {
      return titleParts[0];
    }

    return 'UNKNOWN';
  }

  // Get chart price range from the price axis
  function getChartPriceRange() {
    // Find the price scale on the right side of the chart - try multiple selectors
    const priceScale = document.querySelector('[class*="price-axis"]') ||
                       document.querySelector('[class*="priceScale"]') ||
                       document.querySelector('[data-name="price-axis"]') ||
                       document.querySelector('.price-axis') ||
                       document.querySelector('[class*="rightArea"]');

    const prices = [];

    if (priceScale) {
      // Get all price labels from the scale
      const labels = priceScale.querySelectorAll('[class*="label"]') ||
                     priceScale.querySelectorAll('text') ||
                     priceScale.querySelectorAll('span');

      labels.forEach(label => {
        const p = parsePrice(label.textContent);
        if (p && p > 0) prices.push(p);
      });

      // Also try to get prices from any visible axis text
      const allText = priceScale.textContent;
      const priceMatches = allText.match(/[\d,]+\.?\d*/g);
      if (priceMatches) {
        priceMatches.forEach(m => {
          const cleaned = m.replace(/,/g, '');
          const p = parseFloat(cleaned);
          if (p > 0 && !isNaN(p)) prices.push(p);
        });
      }
    }

    // Fallback: estimate range based on current price
    if (prices.length < 2 && currentPrice) {
      const range = currentPrice * 0.05; // Assume 5% visible range
      prices.push(currentPrice - range, currentPrice + range);
    }

    if (prices.length >= 2) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      // Only return if we have a valid range
      if (max > min && max - min < currentPrice * 0.5) {
        return { min, max };
      }
    }

    // Last resort: use current price with 5% range
    if (currentPrice) {
      return {
        min: currentPrice * 0.975,
        max: currentPrice * 1.025
      };
    }

    return null;
  }

  // Get the main chart canvas/container dimensions
  function getChartDimensions() {
    // Try to find the main chart pane - use multiple selectors
    const chartPane = document.querySelector('.chart-markup-table') ||
                      document.querySelector('[class*="chart-markup-table"]') ||
                      document.querySelector('[data-name="pane-widget"]') ||
                      document.querySelector('.chart-container') ||
                      document.querySelector('.layout__area--center') ||
                      document.querySelector('[class*="chartContainer"]');

    // Also try to find via canvas element
    if (!chartPane) {
      const canvas = document.querySelector('canvas[class*="chart"]') ||
                     document.querySelector('.tv-chart canvas') ||
                     document.querySelector('canvas');
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        return {
          top: rect.top,
          height: rect.height,
          left: rect.left,
          width: rect.width
        };
      }
    }

    if (chartPane) {
      const rect = chartPane.getBoundingClientRect();
      return {
        top: rect.top,
        height: rect.height,
        left: rect.left,
        width: rect.width
      };
    }
    return null;
  }

  // Start monitoring price changes
  function startPriceMonitoring() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(() => {
      const newPrice = getCurrentPrice();
      const symbol = getCurrentSymbol();

      if (newPrice && newPrice !== currentPrice) {
        previousPrice = currentPrice;
        currentPrice = newPrice;
        currentSymbol = symbol;

        // Send price update to background script
        chrome.runtime.sendMessage({
          type: 'PRICE_UPDATE',
          data: {
            price: currentPrice,
            symbol: currentSymbol,
            timestamp: Date.now()
          }
        }).catch(() => {});

        // Update chart info for line positioning
        updateChartInfo();

        // Update line positions
        updateAllLinePositions();
      }
    }, 200);
  }

  // Update stored chart information
  function updateChartInfo() {
    const range = getChartPriceRange();
    const dims = getChartDimensions();

    if (range) {
      chartInfo.minPrice = range.min;
      chartInfo.maxPrice = range.max;
    }
    if (dims) {
      chartInfo.chartTop = dims.top;
      chartInfo.chartHeight = dims.height;
      chartInfo.chartLeft = dims.left;
      chartInfo.chartWidth = dims.width;
    }
  }

  // Load alert levels from storage
  function loadAlertLevels() {
    chrome.storage.local.get(['alertLevels'], (result) => {
      alertLevels = result.alertLevels || [];
      drawAlertLines();
    });
  }

  // Draw alert lines on the chart
  function drawAlertLines() {
    // Remove existing lines
    priceLineElements.forEach(el => el.remove());
    priceLineElements = [];

    // Find the chart container - try multiple selectors for different TradingView versions
    const chartContainer = document.querySelector('.chart-markup-table') ||
                          document.querySelector('[class*="chart-markup-table"]') ||
                          document.querySelector('[data-name="pane-widget"]') ||
                          document.querySelector('.chart-container') ||
                          document.querySelector('.layout__area--center') ||
                          document.querySelector('[class*="chartContainer"]') ||
                          document.querySelector('canvas')?.parentElement?.parentElement;

    if (!chartContainer) {
      console.log('[TV-Alert] Chart container not found, retrying...');
      setTimeout(drawAlertLines, 1000);
      return;
    }

    console.log('[TV-Alert] Found chart container:', chartContainer.className || chartContainer.tagName);

    // Remove old overlay if it exists in wrong place
    const oldOverlay = document.getElementById('tv-alert-overlay');
    if (oldOverlay) oldOverlay.remove();

    // Create fresh overlay
    const overlay = document.createElement('div');
    overlay.id = 'tv-alert-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 9990;
      overflow: visible;
    `;
    document.body.appendChild(overlay);

    // Update chart info before drawing
    updateChartInfo();

    console.log('[TV-Alert] Drawing', alertLevels.length, 'alert levels, chartInfo:', chartInfo);

    alertLevels.forEach(level => {
      if (level.enabled) {
        const line = createPriceLine(level);
        overlay.appendChild(line);
        priceLineElements.push(line);
      }
    });

    // Initial position update
    setTimeout(updateAllLinePositions, 100);
  }

  // Create a visual price line element
  function createPriceLine(level) {
    const line = document.createElement('div');
    line.id = `alert-line-${level.id}`;
    line.className = 'tv-alert-line';
    line.dataset.price = level.price;
    line.dataset.levelId = level.id;

    const color = level.color || '#ff9800';

    line.style.cssText = `
      position: fixed;
      height: 2px;
      background: repeating-linear-gradient(
        to right,
        ${color},
        ${color} 10px,
        transparent 10px,
        transparent 15px
      );
      pointer-events: none;
      z-index: 9991;
      transition: top 0.1s ease-out;
    `;

    // Add glow effect
    const glow = document.createElement('div');
    glow.className = 'tv-alert-line-glow';
    glow.style.cssText = `
      position: absolute;
      left: 0;
      right: 0;
      top: -3px;
      bottom: -3px;
      background: ${color};
      opacity: 0.3;
      filter: blur(4px);
    `;
    line.appendChild(glow);

    // Add price label
    const label = document.createElement('div');
    label.className = 'tv-alert-label';
    label.style.cssText = `
      position: absolute;
      right: 0;
      top: -9px;
      transform: translateX(100%);
      margin-left: 4px;
      background: ${color};
      color: white;
      padding: 3px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      white-space: nowrap;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      z-index: 9992;
    `;
    label.textContent = formatPrice(level.price);
    line.appendChild(label);

    // Add direction indicator
    const dirIndicator = document.createElement('div');
    dirIndicator.style.cssText = `
      position: absolute;
      left: 10px;
      top: -8px;
      font-size: 10px;
      color: ${color};
      text-shadow: 0 0 3px black;
    `;
    if (level.direction === 'above') {
      dirIndicator.textContent = '▲ CROSS ABOVE';
    } else if (level.direction === 'below') {
      dirIndicator.textContent = '▼ CROSS BELOW';
    } else {
      dirIndicator.textContent = '◆ CROSS BOTH';
    }
    line.appendChild(dirIndicator);

    return line;
  }

  // Format price for display
  function formatPrice(price) {
    if (price >= 1000) {
      return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (price >= 1) {
      return price.toFixed(2);
    } else {
      return price.toFixed(4);
    }
  }

  // Calculate Y position for a price level
  function calculateYPosition(price) {
    if (!chartInfo.maxPrice || !chartInfo.minPrice || chartInfo.maxPrice === chartInfo.minPrice) {
      // Fallback: use current price as reference
      if (currentPrice) {
        const priceDiff = (price - currentPrice) / currentPrice;
        const center = chartInfo.chartHeight / 2;
        return center - (priceDiff * chartInfo.chartHeight * 2);
      }
      return null;
    }

    const priceRange = chartInfo.maxPrice - chartInfo.minPrice;
    const priceFromTop = chartInfo.maxPrice - price;
    const percentFromTop = priceFromTop / priceRange;

    return percentFromTop * chartInfo.chartHeight;
  }

  // Update position of a single line
  function updateLinePosition(lineElement) {
    const price = parseFloat(lineElement.dataset.price);
    if (!price) return;

    const relativeY = calculateYPosition(price);

    // Convert relative Y to absolute position on page
    const absoluteY = chartInfo.chartTop + (relativeY || 0);

    // Set horizontal position to match chart area
    lineElement.style.left = `${chartInfo.chartLeft}px`;
    lineElement.style.width = `${chartInfo.chartWidth - 60}px`; // Leave space for price label

    if (relativeY !== null && relativeY >= -50 && relativeY <= chartInfo.chartHeight + 50) {
      lineElement.style.top = `${absoluteY}px`;
      lineElement.style.display = 'block';
      lineElement.style.opacity = '1';
    } else {
      // Line is outside visible range - show indicator at edge
      if (relativeY !== null) {
        if (relativeY < 0) {
          lineElement.style.top = `${chartInfo.chartTop}px`;
          lineElement.style.opacity = '0.4';
          lineElement.style.display = 'block';
        } else {
          lineElement.style.top = `${chartInfo.chartTop + chartInfo.chartHeight - 2}px`;
          lineElement.style.opacity = '0.4';
          lineElement.style.display = 'block';
        }
      } else {
        lineElement.style.display = 'none';
      }
    }
  }

  // Update all line positions
  function updateAllLinePositions() {
    updateChartInfo();
    priceLineElements.forEach(line => updateLinePosition(line));
  }

  // Flash a line when alert triggers
  function flashLine(levelId, direction) {
    const line = document.getElementById(`alert-line-${levelId}`);
    if (!line) return;

    // Add triggered class for animation
    line.classList.add('triggered');

    const color = direction === 'above' ? '#4caf50' : '#f44336';

    // Intense flash effect
    line.style.boxShadow = `0 0 20px 5px ${color}`;
    line.style.background = color;
    line.style.height = '4px';
    line.style.zIndex = '200';

    // Pulse animation
    let pulseCount = 0;
    const pulseInterval = setInterval(() => {
      pulseCount++;
      line.style.opacity = pulseCount % 2 === 0 ? '1' : '0.5';
      if (pulseCount >= 10) {
        clearInterval(pulseInterval);
        // Reset after animation
        setTimeout(() => {
          line.classList.remove('triggered');
          line.style.boxShadow = '';
          line.style.height = '2px';
          line.style.zIndex = '100';
          line.style.opacity = '1';
          // Restore original dashed pattern
          const levelData = alertLevels.find(l => l.id === levelId);
          if (levelData) {
            line.style.background = `repeating-linear-gradient(
              to right,
              ${levelData.color || '#ff9800'},
              ${levelData.color || '#ff9800'} 10px,
              transparent 10px,
              transparent 15px
            )`;
          }
        }, 500);
      }
    }, 150);
  }

  // Handle alert trigger from background
  function handleAlertTrigger(level, symbol, price, direction) {
    console.log(`[TV-Alert] TRIGGERED: ${symbol} crossed ${direction} ${level.price}`);

    // Play sound
    playAlertSound();

    // Flash the line
    flashLine(level.id, direction);

    // Show toast
    const dirText = direction === 'above' ? 'crossed ABOVE' : 'crossed BELOW';
    showToast(
      `${symbol} ${dirText} ${formatPrice(level.price)}<br>Current: ${formatPrice(price)}`,
      direction,
      8000
    );
  }

  // Listen for messages from popup/background
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message.type) {
        case 'GET_PRICE':
          sendResponse({
            price: currentPrice,
            symbol: currentSymbol
          });
          break;

        case 'LEVELS_UPDATED':
          alertLevels = message.levels || [];
          drawAlertLines();
          sendResponse({ success: true });
          break;

        case 'ALERT_TRIGGERED':
          handleAlertTrigger(message.level, message.symbol, message.price, message.direction);
          sendResponse({ received: true });
          break;

        case 'PING':
          sendResponse({ pong: true, price: currentPrice, symbol: currentSymbol });
          break;

        case 'API_SETTINGS_UPDATED':
          apiSettings = message.settings || { apiUrl: '', apiKey: '', apiHeader: 'X-API-Key' };
          console.log('[TV-Alert] API settings updated:', apiSettings.apiUrl ? 'Custom API' : 'Default');
          // Reset and reload options with new settings
          lastOptionsSymbol = '';
          if (currentSymbol) {
            fetchOptionsData(currentSymbol);
          }
          sendResponse({ success: true });
          break;

        case 'PATTERN_SETTINGS_UPDATED':
          patternSettings = { ...patternSettings, ...message.settings };
          if (patternDetector) {
            patternDetector = new PatternDetector({
              minConfidence: patternSettings.minConfidence,
              enabledPatterns: patternSettings.enabledPatterns
            });
          }
          console.log('[TV-Alert] Pattern settings updated');
          sendResponse({ success: true });
          break;

        case 'GET_PATTERNS':
          sendResponse({ patterns: detectedPatterns });
          break;

        case 'GET_CANDLES':
          sendResponse({ candles: candleStore });
          break;
      }
      return true;
    });
  }

  // Watch for chart navigation/updates
  function watchForChartChanges() {
    const observer = new MutationObserver((mutations) => {
      let shouldUpdate = false;
      mutations.forEach(mutation => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          shouldUpdate = true;
        }
      });

      if (shouldUpdate) {
        setTimeout(() => {
          updateChartInfo();
          updateAllLinePositions();
        }, 200);
      }
    });

    const chartContainer = document.querySelector('.chart-container') ||
                          document.querySelector('[class*="chart-markup-table"]');

    if (chartContainer) {
      observer.observe(chartContainer, {
        childList: true,
        subtree: true
      });
    }

    // Also watch for scroll/zoom changes
    window.addEventListener('wheel', () => {
      setTimeout(updateAllLinePositions, 100);
    });
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Start position updates after init
  setTimeout(() => {
    watchForChartChanges();
    // Update positions periodically
    setInterval(updateAllLinePositions, 500);
  }, 2000);

})();
