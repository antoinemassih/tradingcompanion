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

  // Try to extract symbol from URL
  function getSymbolFromUrl() {
    try {
      const url = window.location.href;
      // TradingView URLs often have symbol in format: /chart/xxx/EXCHANGE:SYMBOL/
      const match = url.match(/\/chart\/[^\/]+\/([A-Z0-9]+:[A-Z0-9]+)/i);
      if (match) return match[1];
      // Also check for symbol=xxx in query string
      const params = new URLSearchParams(window.location.search);
      const sym = params.get('symbol');
      if (sym) return sym;
    } catch (e) {}
    return '';
  }

  // Get the best available symbol
  function getCurrentSymbol() {
    if (lastSymbol) return lastSymbol;
    const urlSymbol = getSymbolFromUrl();
    if (urlSymbol) return urlSymbol;
    return '';
  }

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
    // Ensure URL is a string
    this._tvUrl = typeof url === 'string' ? url : (url?.toString?.() || '');
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    const xhr = this;
    const url = this._tvUrl || '';

    // Safety check - ensure url is a string
    if (typeof url !== 'string') {
      return originalXHRSend.apply(this, args);
    }

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

    log('WebSocket created:', url.substring(0, 80));

    // Only intercept TradingView WebSocket
    if (url.includes('tradingview.com') || url.includes('data.tradingview')) {
      // Use event listener to capture messages
      ws.addEventListener('message', function(event) {
        try {
          const msg = event.data;
          if (typeof msg !== 'string') return;

          // TradingView uses ~m~LENGTH~m~PAYLOAD format
          // Split by ~m~ and process each packet
          const packets = msg.split(/~m~\d+~m~/);

          packets.forEach(packet => {
            if (!packet || packet.length < 2) return;

            // Try to parse as JSON
            try {
              // Find JSON object in packet
              const jsonStart = packet.indexOf('{');
              const jsonEnd = packet.lastIndexOf('}');
              if (jsonStart === -1 || jsonEnd === -1) return;

              const jsonStr = packet.substring(jsonStart, jsonEnd + 1);
              const data = JSON.parse(jsonStr);

              // Capture symbol from symbol_resolved message
              if (data.m === 'symbol_resolved' && data.p) {
                const symbolData = data.p[1];
                if (symbolData) {
                  // Try different properties that might contain the symbol
                  const sym = symbolData.name || symbolData.symbol || symbolData.full_name || symbolData.short_name;
                  if (sym) {
                    lastSymbol = sym;
                    log('Symbol resolved:', lastSymbol);
                  }
                }
              }

              // Also capture from resolve_symbol requests
              if (data.m === 'resolve_symbol' && data.p && data.p.length >= 2) {
                const sym = data.p[1];
                if (typeof sym === 'string' && sym.length > 0) {
                  lastSymbol = sym;
                  log('Symbol from resolve_symbol:', lastSymbol);
                }
              }

              // Capture resolution from create_series or modify_series
              if ((data.m === 'create_series' || data.m === 'modify_series') && data.p) {
                // Resolution is usually in the parameters
                const params = data.p;
                if (Array.isArray(params) && params.length >= 4) {
                  const res = params[3]; // Resolution often at index 3
                  if (typeof res === 'string' || typeof res === 'number') {
                    lastResolution = String(res);
                    log('Resolution set:', lastResolution);
                  }
                }
                // Also try to extract symbol from create_series if present
                if (params.length >= 2 && typeof params[1] === 'string' && !lastSymbol) {
                  // Sometimes symbol is in params[1]
                  lastSymbol = params[1];
                  log('Symbol from create_series:', lastSymbol);
                }
              }

              // Look for timescale_update messages (historical data)
              if (data.m === 'timescale_update' && data.p) {
                log('Found timescale_update message');
                processTimescaleUpdate(data.p);
              }

              // Look for du (data update) messages (real-time)
              if (data.m === 'du' && data.p) {
                processDataUpdate(data.p);
              }

              // Look for series data in various formats
              if (data.p && Array.isArray(data.p)) {
                data.p.forEach(item => {
                  // Check for series data with 's' array (candles)
                  if (item.s && Array.isArray(item.s)) {
                    log('Found series data, length:', item.s.length);
                    processSeriesData(item);
                  }
                  // Check for 'sds_1' or similar series data
                  if (item.sds_1 && item.sds_1.s) {
                    log('Found sds_1 series data');
                    processSeriesData(item.sds_1);
                  }
                });
              }
            } catch (e) {
              // Not valid JSON, skip
            }
          });
        } catch (e) {
          // Silent fail for non-matching messages
        }
      });
    }

    return ws;
  };

  // Process timescale_update messages (historical bars)
  function processTimescaleUpdate(payload) {
    if (!Array.isArray(payload)) return;

    payload.forEach(item => {
      // Try to extract symbol from the payload item keys
      // Keys like "sds_sym_1" may contain symbol info
      Object.keys(item).forEach(key => {
        if (key.startsWith('sds_') || key.startsWith('st_')) {
          const seriesData = item[key];
          if (seriesData && seriesData.s && Array.isArray(seriesData.s)) {
            processSeriesData(seriesData, false, key);
          }
        }
      });

      // Also check direct s array
      if (item.s && Array.isArray(item.s)) {
        processSeriesData(item, false, '');
      }
    });
  }

  // Process data update messages (real-time)
  function processDataUpdate(payload) {
    if (!Array.isArray(payload)) return;

    payload.forEach(item => {
      if (item.sds_1 && item.sds_1.s) {
        processSeriesData(item.sds_1, true);
      }
      if (item.s && Array.isArray(item.s)) {
        processSeriesData(item, true);
      }
    });
  }

  // Process series data (OHLCV candles)
  function processSeriesData(seriesObj, isRealtime = false, seriesName = '') {
    if (!seriesObj || !seriesObj.s || !Array.isArray(seriesObj.s)) return;

    // Try to extract symbol from series name (e.g., "sds_sym_1" sometimes has symbol info)
    let symbol = getCurrentSymbol();

    // Also check if there's a symbol in the series object
    if (seriesObj.ns && seriesObj.ns.d) {
      // Sometimes the symbol is in ns.d
      symbol = seriesObj.ns.d || symbol;
    }

    const candles = [];
    seriesObj.s.forEach(bar => {
      // Bar format: { i: index, v: [timestamp, open, high, low, close, volume] }
      if (bar.v && bar.v.length >= 5) {
        candles.push({
          timestamp: bar.v[0] * 1000,
          open: bar.v[1],
          high: bar.v[2],
          low: bar.v[3],
          close: bar.v[4],
          volume: bar.v[5] || 0,
          symbol: symbol,
          timeframe: lastResolution,
          isRealtime: isRealtime
        });
      }
    });

    if (candles.length > 0) {
      log('Processed', candles.length, 'candles for', symbol || '(unknown)', 'realtime:', isRealtime);
      relayToContentScript({
        candles: candles,
        symbol: symbol,
        timeframe: lastResolution,
        isRealtime: isRealtime
      });
    }
  }

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
