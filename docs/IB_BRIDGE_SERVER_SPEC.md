# TONYC Bridge Server Specification

## Overview
A local HTTP server that connects to IB Gateway/TWS and exposes REST endpoints for the Chrome extension to consume options data and submit orders.

## Connection Details
- **Server URL**: `http://localhost:5000` (configurable)
- **Protocol**: REST + optional WebSocket for real-time updates
- **IB Connection**: TWS API / IB Gateway on port 7496 (live) or 7497 (paper)

---

## Endpoints Required

### 1. Health Check
```
GET /health
```
**Response:**
```json
{
  "status": "connected",
  "ibConnected": true,
  "accountId": "DU123456",
  "serverTime": 1706889600000
}
```

---

### 2. Get Options Chain
```
GET /options/{symbol}
```
**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `expiration` | string | Optional. ISO date (2024-02-16) or "nearest" |
| `strikeCount` | int | Optional. Number of strikes around ATM (default: 20) |

**Response:**
```json
{
  "symbol": "AAPL",
  "underlying": {
    "price": 185.50,
    "bid": 185.49,
    "ask": 185.51
  },
  "expirationDate": 1708041600,
  "expirationDates": [1708041600, 1708646400, 1709251200],
  "strikes": [180, 182.5, 185, 187.5, 190],
  "calls": [
    {
      "strike": 185,
      "bid": 2.45,
      "ask": 2.50,
      "lastPrice": 2.47,
      "volume": 1523,
      "openInterest": 8420,
      "iv": 0.25,
      "delta": 0.52,
      "gamma": 0.08,
      "theta": -0.12,
      "vega": 0.18,
      "conId": 123456789
    }
  ],
  "puts": [
    {
      "strike": 185,
      "bid": 2.30,
      "ask": 2.35,
      "lastPrice": 2.32,
      "volume": 982,
      "openInterest": 6150,
      "iv": 0.24,
      "delta": -0.48,
      "gamma": 0.08,
      "theta": -0.11,
      "vega": 0.17,
      "conId": 987654321
    }
  ]
}
```

**Note:** `conId` is IB's contract ID - needed for order submission.

---

### 3. Submit Order
```
POST /orders
```
**Request Body:**
```json
{
  "symbol": "AAPL",
  "strike": 185,
  "optionType": "C",
  "side": "BUY",
  "quantity": 5,
  "orderType": "limit",
  "limitPrice": 2.48,
  "tif": "day",
  "conId": 123456789
}
```

| Field | Type | Values |
|-------|------|--------|
| `symbol` | string | Underlying ticker |
| `strike` | number | Strike price |
| `optionType` | string | "C" (call) or "P" (put) |
| `side` | string | "BUY" or "SELL" |
| `quantity` | int | Number of contracts |
| `orderType` | string | "limit", "market", "stop", "stop_limit" |
| `limitPrice` | number | Required for limit orders |
| `stopPrice` | number | Required for stop orders |
| `tif` | string | "day", "gtc", "ioc", "fok" |
| `conId` | int | IB contract ID (from options chain) |

**Response:**
```json
{
  "orderId": "ib-12345",
  "status": "submitted",
  "message": "Order submitted successfully"
}
```

**Error Response:**
```json
{
  "error": true,
  "code": "INSUFFICIENT_MARGIN",
  "message": "Insufficient margin for this order"
}
```

---

### 4. Get Orders
```
GET /orders
```
**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `status` | string | "active", "filled", "cancelled", "all" |

**Response:**
```json
{
  "orders": [
    {
      "orderId": "ib-12345",
      "symbol": "AAPL",
      "strike": 185,
      "optionType": "C",
      "side": "BUY",
      "quantity": 5,
      "filledQty": 0,
      "orderType": "limit",
      "limitPrice": 2.48,
      "status": "submitted",
      "submittedAt": 1706889600000
    }
  ]
}
```

---

### 5. Cancel Order
```
DELETE /orders/{orderId}
```
**Response:**
```json
{
  "orderId": "ib-12345",
  "status": "cancelled"
}
```

---

### 6. Get Positions (Optional but useful)
```
GET /positions
```
**Response:**
```json
{
  "positions": [
    {
      "symbol": "AAPL",
      "strike": 185,
      "optionType": "C",
      "expiration": "2024-02-16",
      "quantity": 10,
      "avgCost": 2.35,
      "marketValue": 2480.00,
      "unrealizedPnL": 130.00
    }
  ]
}
```

---

### 7. WebSocket (Optional - for real-time)
```
WS /ws
```
**Server pushes:**
```json
{"type": "quote", "symbol": "AAPL", "conId": 123456789, "bid": 2.46, "ask": 2.51}
{"type": "order", "orderId": "ib-12345", "status": "filled", "filledQty": 5, "avgPrice": 2.47}
{"type": "position", "symbol": "AAPL", "strike": 185, "optionType": "C", "quantity": 10}
```

---

## CORS Configuration
The server must allow requests from the Chrome extension:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-API-Key
```

---

## Error Codes
| Code | Description |
|------|-------------|
| `IB_DISCONNECTED` | Not connected to IB Gateway |
| `INVALID_SYMBOL` | Symbol not found |
| `INVALID_CONTRACT` | Option contract not found |
| `INSUFFICIENT_MARGIN` | Not enough margin |
| `MARKET_CLOSED` | Market is closed |
| `ORDER_REJECTED` | IB rejected the order |
| `RATE_LIMITED` | Too many requests |

---

## Tech Stack Suggestions
- **Python**: `ib_insync` library (easiest IB integration)
- **Node.js**: `@stoqey/ib` or `ib-tws-api`
- **Framework**: Flask/FastAPI (Python) or Express (Node)

---

## Extension Configuration

The extension will need these settings configured (via the Settings modal):

| Setting | Default | Description |
|---------|---------|-------------|
| `API URL` | `http://localhost:5000` | Bridge server base URL |
| `API Key` | (optional) | For authentication if needed |

The extension will call:
- `GET {API_URL}/options/{symbol}` for options chain data
- `POST {API_URL}/orders` when Auto is ON or "Send" is clicked
- `GET {API_URL}/orders` to sync order status
- `DELETE {API_URL}/orders/{id}` to cancel orders
