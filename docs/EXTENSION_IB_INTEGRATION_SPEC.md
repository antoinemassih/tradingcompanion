# Extension IB Integration Specification

## Overview
This document specifies the changes needed to integrate the TONYC extension with the IB Bridge Server once it becomes available.

---

## Configuration Changes

### Settings Modal Updates
Add new fields to the settings modal in `sidepanel.html`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| Bridge URL | text | `http://localhost:5000` | IB Bridge server URL |
| Auto-connect | toggle | true | Connect to bridge on extension load |
| Paper Trading | toggle | true | Use paper trading port (safety) |

### Storage Schema
```javascript
// chrome.storage.local
{
  "ibBridgeSettings": {
    "bridgeUrl": "http://localhost:5000",
    "autoConnect": true,
    "paperTrading": true
  }
}
```

---

## Connection Management

### New File: `ibBridge.js`
Create a dedicated module for IB Bridge communication.

```javascript
// ibBridge.js - Connection manager for IB Bridge Server

class IBBridge {
  constructor(baseUrl = 'http://localhost:5000') {
    this.baseUrl = baseUrl;
    this.connected = false;
    this.accountId = null;
    this.ws = null;
  }

  // Check connection status
  async checkHealth() {
    // GET /health
    // Update this.connected and this.accountId
    // Return { connected, ibConnected, accountId }
  }

  // Fetch options chain
  async getOptionsChain(symbol, options = {}) {
    // GET /options/{symbol}?expiration=nearest&strikeCount=20
    // Return normalized options data
  }

  // Submit order to IB
  async submitOrder(order) {
    // POST /orders
    // Return { orderId, status, message }
  }

  // Get active orders from IB
  async getOrders(status = 'active') {
    // GET /orders?status={status}
    // Return orders array
  }

  // Cancel order
  async cancelOrder(orderId) {
    // DELETE /orders/{orderId}
    // Return { orderId, status }
  }

  // Get positions
  async getPositions() {
    // GET /positions
    // Return positions array
  }

  // WebSocket connection for real-time updates
  connectWebSocket(onMessage) {
    // WS /ws
    // Handle quote, order, position updates
  }

  disconnectWebSocket() {
    // Close WS connection
  }
}
```

---

## Content Script Changes (`content.js`)

### 1. Options Chain Fetching
Update `fetchOptionsData()` to prioritize IB Bridge:

```javascript
async function fetchOptionsData(symbol) {
  const cleanSymbol = symbol.replace(/^[A-Z]+:/, '').toUpperCase();

  // Priority 1: IB Bridge (if configured and connected)
  if (ibBridgeSettings.bridgeUrl) {
    try {
      const data = await ibBridge.getOptionsChain(cleanSymbol);
      if (data && data.calls) {
        optionsData = normalizeIBData(data);
        optionsDataSource = 'ib';  // New source indicator
        renderOptionsChain();
        return;
      }
    } catch (e) {
      console.log('[TV-Alert] IB Bridge failed:', e.message);
    }
  }

  // Priority 2: Custom API (existing)
  // Priority 3: Yahoo Finance (existing)
  // Priority 4: Mock data (existing)
}
```

### 2. Data Source Indicator
Add IB to the source indicator:

```javascript
const sources = {
  ib: { letter: 'IB', color: '#e91e63', tooltip: 'Live data from Interactive Brokers' },
  api: { letter: 'A', color: '#26a69a', tooltip: 'Data from Custom API' },
  yahoo: { letter: 'Y', color: '#2196f3', tooltip: 'Data from Yahoo Finance' },
  mock: { letter: 'M', color: '#ff9800', tooltip: 'Mock/Simulated Data' }
};
```

### 3. Order Window Updates
Store `conId` from options data for order submission:

```javascript
// When rendering options, store conId
const callMap = {};
optionsData.calls.forEach(c => {
  callMap[c.strike] = c;  // c now includes conId from IB
});

// In createOrderWindow, pass conId
function createOrderWindow(optionData, isCall, strike) {
  const conId = optionData?.conId;  // IB contract ID
  // ... rest of window creation
}
```

### 4. Order Submission
Update submit handler to route to IB when Auto is ON:

```javascript
submitBtn.onclick = async () => {
  const order = {
    symbol: symbol,
    strike: strike,
    optionType: optType,
    side: currentSide.toUpperCase(),
    quantity: qty,
    orderType: orderType,
    limitPrice: price,
    tif: tif,
    conId: conId  // Required for IB
  };

  if (autoSubmit && ibBridge.connected) {
    // Submit directly to IB
    try {
      const result = await ibBridge.submitOrder(order);
      order.ibOrderId = result.orderId;
      order.status = 'active';
      showToast(`<strong style="color:#26a69a">SENT TO IB</strong><br>Order ID: ${result.orderId}`, 'above', 3000);
    } catch (e) {
      showToast(`<strong style="color:#ef5350">IB ERROR</strong><br>${e.message}`, 'below', 4000);
      return;
    }
  } else {
    // Save locally (existing behavior)
    order.status = autoSubmit ? 'active' : 'saved';
  }

  // Save to local storage for Orders tab
  await saveOrderToStorage(order);
  win.remove();
};
```

---

## Sidepanel Changes (`sidepanel.js`)

### 1. Connection Status in Header
Add IB connection indicator near the status dot:

```html
<div class="ib-status" id="ibStatus" title="IB Gateway Status">
  <span class="ib-dot"></span>
  <span class="ib-text">IB: Disconnected</span>
</div>
```

### 2. Orders Tab Sync
Sync orders with IB Bridge periodically:

```javascript
async function syncOrdersWithIB() {
  if (!ibBridge.connected) return;

  try {
    const ibOrders = await ibBridge.getOrders('active');
    // Merge with local orders
    // Update status for filled/cancelled orders
    // Remove orders that no longer exist in IB
  } catch (e) {
    console.error('Failed to sync orders with IB:', e);
  }
}

// Sync every 5 seconds when Orders tab is active
setInterval(() => {
  if (ordersTabActive && ibBridge.connected) {
    syncOrdersWithIB();
  }
}, 5000);
```

### 3. Send Button for Saved Orders
Update "Send" button to submit to IB:

```javascript
async function sendOrder(orderId) {
  const order = getOrderById(orderId);

  if (ibBridge.connected) {
    try {
      const result = await ibBridge.submitOrder(order);
      order.ibOrderId = result.orderId;
      order.status = 'active';
      order.sentAt = Date.now();
      showNotification(`Order sent to IB: ${result.orderId}`);
    } catch (e) {
      showNotification(`Failed to send: ${e.message}`, 'error');
      return;
    }
  } else {
    // Just update local status
    order.status = 'active';
  }

  await updateOrderInStorage(order);
  loadOrders();
}
```

### 4. Cancel Button
Route cancellations to IB:

```javascript
async function cancelOrder(orderId) {
  const order = getOrderById(orderId);

  if (order.ibOrderId && ibBridge.connected) {
    try {
      await ibBridge.cancelOrder(order.ibOrderId);
    } catch (e) {
      showNotification(`Failed to cancel in IB: ${e.message}`, 'error');
      // Still remove locally
    }
  }

  await removeOrderFromStorage(orderId);
  loadOrders();
}
```

### 5. Settings Modal Updates
Add IB Bridge configuration section:

```html
<div class="settings-group">
  <h3>IB Gateway Connection</h3>

  <div class="form-group">
    <label class="form-label">Bridge Server URL</label>
    <input type="text" id="bridgeUrlInput" placeholder="http://localhost:5000">
  </div>

  <div class="form-group">
    <label class="toggle-label">
      <input type="checkbox" id="autoConnectToggle" checked>
      <span>Auto-connect on startup</span>
    </label>
  </div>

  <div class="form-group">
    <label class="toggle-label">
      <input type="checkbox" id="paperTradingToggle" checked>
      <span>Paper Trading Mode (recommended)</span>
    </label>
  </div>

  <button class="btn btn-secondary" id="testBridgeBtn">Test Connection</button>
  <div id="bridgeTestResult" class="api-test-result"></div>
</div>
```

---

## New Features to Add

### 1. Positions Panel (Optional)
Add a Positions tab or section showing current option positions from IB:

```javascript
async function loadPositions() {
  if (!ibBridge.connected) return;

  const positions = await ibBridge.getPositions();
  renderPositions(positions);
}
```

### 2. Real-time Quote Updates via WebSocket
When connected, update bid/ask in real-time:

```javascript
ibBridge.connectWebSocket((message) => {
  if (message.type === 'quote') {
    updateOptionQuote(message.conId, message.bid, message.ask);
  } else if (message.type === 'order') {
    updateOrderStatus(message.orderId, message.status);
  }
});
```

### 3. Order Status Colors in Orders Tab
```css
.order-item.submitted { border-left-color: #2962ff; }
.order-item.filled { border-left-color: #26a69a; }
.order-item.cancelled { border-left-color: #ef5350; }
.order-item.partial { border-left-color: #ff9800; }
```

---

## Error Handling

### Connection Errors
```javascript
async function handleBridgeError(error) {
  if (error.code === 'IB_DISCONNECTED') {
    showToast('IB Gateway disconnected. Reconnecting...', 'below', 3000);
    await ibBridge.checkHealth();
  } else if (error.code === 'MARKET_CLOSED') {
    showToast('Market is closed', 'below', 2000);
  } else {
    showToast(`Error: ${error.message}`, 'below', 4000);
  }
}
```

### Fallback Behavior
- If IB Bridge unavailable → Fall back to Yahoo Finance for quotes
- If order submission fails → Keep order as "saved" with error message
- If WebSocket disconnects → Poll REST endpoints instead

---

## Testing Checklist

- [ ] Settings modal saves/loads bridge URL correctly
- [ ] Health check shows IB connection status
- [ ] Options chain loads from IB with conId
- [ ] Source indicator shows "IB" when connected
- [ ] Order submission with Auto ON sends to IB
- [ ] Order submission with Auto OFF saves locally
- [ ] "Send" button routes saved orders to IB
- [ ] "Cancel" button cancels in IB and locally
- [ ] Orders tab syncs with IB order status
- [ ] Graceful fallback when IB unavailable
- [ ] WebSocket updates quotes in real-time
- [ ] Paper trading mode works correctly

---

## Migration Notes

When IB Bridge becomes available:
1. Add `ibBridge.js` to manifest.json content_scripts
2. Update settings modal HTML in sidepanel.html
3. Add IB connection status to header
4. Update fetchOptionsData() priority order
5. Update order submission logic
6. Add order sync functionality
7. Test thoroughly with paper trading first!
