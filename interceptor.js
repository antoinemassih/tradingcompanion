// TradingView Network Interceptor
// Runs in MAIN world at document_start to capture candle data
// Communicates with content.js via postMessage

(function() {
  'use strict';

  const DEBUG = true;
  const log = (...args) => console.log('[TV-Interceptor]', ...args);

  // Store original functions
  const originalFetch = window.fetch;
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  // Track active symbol and resolution
  let lastSymbol = '';
  let lastResolution = '';

  // Parse TradingView candle data from response
  function parseCandleData(url, data) {
    try {
      // Check if it's a history endpoint
      if (!url.includes('/history') && !url.includes('tradingview.com')) {
        return null;
      }

      // Parse URL parameters
      const urlObj = new URL(url, window.location.origin);
      const symbol = urlObj.searchParams.get('symbol') || lastSymbol;
      const resolution = urlObj.searchParams.get('resolution') || lastResolution;

      if (symbol) lastSymbol = symbol;
      if (resolution) lastResolution = resolution;

      // TradingView returns data in format: { t: [], o: [], h: [], l: [], c: [], v: [], s: "ok" }
      if (data && data.s === 'ok' && Array.isArray(data.t)) {
        const candles = [];
        for (let i = 0; i < data.t.length; i++) {
          candles.push({
            timestamp: data.t[i] * 1000, // Convert to milliseconds
            open: data.o[i],
            high: data.h[i],
            low: data.l[i],
            close: data.c[i],
            volume: data.v ? data.v[i] : 0,
            symbol: symbol,
            timeframe: resolution
          });
        }
        return { candles, symbol, timeframe: resolution };
      }

      return null;
    } catch (e) {
      log('Parse error:', e);
      return null;
    }
  }

  // Send candle data to content script
  function relayToContentScript(candleData) {
    if (!candleData || !candleData.candles || candleData.candles.length === 0) return;

    log('Relaying', candleData.candles.length, 'candles for', candleData.symbol, candleData.timeframe);

    window.postMessage({
      type: 'TV_CANDLE_DATA',
      source: 'tv-interceptor',
      data: candleData
    }, '*');
  }

  // Override fetch
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

      // Log all fetch requests for debugging
      if (url.includes('tradingview')) {
        log('Fetch request:', url.substring(0, 150));
      }

      // Intercept TradingView data endpoints - broader matching
      if (url.includes('tradingview') && (url.includes('/history') || url.includes('chart') || url.includes('data'))) {
        // Clone response to read it without consuming
        const clone = response.clone();
        clone.json().then(data => {
          log('Fetch response data keys:', Object.keys(data || {}));
          const candleData = parseCandleData(url, data);
          if (candleData) {
            relayToContentScript(candleData);
          }
        }).catch(() => {});
      }
    } catch (e) {
      log('Fetch intercept error:', e);
    }

    return response;
  };

  // Override XMLHttpRequest
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._tvUrl = url;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    const xhr = this;
    const url = this._tvUrl || '';

    // Only intercept TradingView data endpoints
    if (url.includes('tradingview.com') && (url.includes('/history') || url.includes('symbols'))) {
      const originalOnReadyStateChange = xhr.onreadystatechange;

      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4 && xhr.status === 200) {
          try {
            const data = JSON.parse(xhr.responseText);
            const candleData = parseCandleData(url, data);
            if (candleData) {
              relayToContentScript(candleData);
            }
          } catch (e) {
            log('XHR parse error:', e);
          }
        }
        if (originalOnReadyStateChange) {
          originalOnReadyStateChange.apply(this, arguments);
        }
      };

      // Also handle onload
      const originalOnLoad = xhr.onload;
      xhr.onload = function() {
        try {
          const data = JSON.parse(xhr.responseText);
          const candleData = parseCandleData(url, data);
          if (candleData) {
            relayToContentScript(candleData);
          }
        } catch (e) {}
        if (originalOnLoad) {
          originalOnLoad.apply(this, arguments);
        }
      };
    }

    return originalXHRSend.apply(this, args);
  };

  // Also try to intercept WebSocket for real-time updates
  const originalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const ws = protocols
      ? new originalWebSocket(url, protocols)
      : new originalWebSocket(url);

    // Only intercept TradingView WebSocket
    if (url.includes('tradingview.com') || url.includes('data.tradingview')) {
      const originalOnMessage = ws.onmessage;

      // Use event listener to capture messages
      ws.addEventListener('message', function(event) {
        try {
          // TradingView WebSocket sends various message types
          // Real-time candle updates often come as JSON with specific prefixes
          const msg = event.data;

          if (typeof msg === 'string' && msg.startsWith('~')) {
            // TradingView uses ~ prefix for data messages
            const jsonPart = msg.substring(msg.indexOf('{'));
            if (jsonPart) {
              const data = JSON.parse(jsonPart);
              // Look for candle update patterns
              if (data.p && Array.isArray(data.p)) {
                // Real-time bar update
                data.p.forEach(item => {
                  if (item.v && item.v.length >= 6) {
                    // Format: [timestamp, open, high, low, close, volume]
                    const candle = {
                      timestamp: item.v[0] * 1000,
                      open: item.v[1],
                      high: item.v[2],
                      low: item.v[3],
                      close: item.v[4],
                      volume: item.v[5] || 0,
                      symbol: lastSymbol,
                      timeframe: lastResolution,
                      isRealtime: true
                    };
                    relayToContentScript({
                      candles: [candle],
                      symbol: lastSymbol,
                      timeframe: lastResolution,
                      isRealtime: true
                    });
                  }
                });
              }
            }
          }
        } catch (e) {
          // Silent fail for non-matching messages
        }
      });
    }

    return ws;
  };
  // Copy static properties
  Object.keys(originalWebSocket).forEach(key => {
    window.WebSocket[key] = originalWebSocket[key];
  });
  window.WebSocket.prototype = originalWebSocket.prototype;

  log('Interceptor installed successfully');
  log('Hooked: fetch, XMLHttpRequest, WebSocket');

  // Test that we're in MAIN world by checking window
  log('Window location:', window.location.hostname);
})();
