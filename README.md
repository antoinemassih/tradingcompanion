# TONYC - TradingView Options Companion

A Chrome extension that adds an options chain panel and order window overlay to TradingView charts.

## Features

### Options Chain Panel
- Displays real-time options data alongside your TradingView chart
- Shows calls and puts with strike prices centered around current price
- Color-coded ITM/OTM options
- ATM strike highlighted
- Draggable and collapsible panel

### Data Sources
- **Custom API** - Configure your own options data provider
- **Yahoo Finance** - Free fallback data source
- **Mock Data** - Simulated data when APIs are unavailable

A small indicator next to the title shows the current data source:
- `A` (green) - Custom API
- `Y` (blue) - Yahoo Finance
- `M` (orange) - Mock/Simulated

### Order Window
Click any option to open a compact order entry window:
- Buy/Sell toggle
- Order types: Limit, Market, Stop, Stop Limit
- Time in force: Day, GTC, IOC, FOK
- Price input with +/- controls
- Quantity input with quick presets (1, 5, 10, 25, 50)
- Auto-calculated estimated total
- Multiple windows can be open simultaneously
- Fully draggable

## Installation

1. Clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" and select the extension folder
5. Navigate to TradingView and open any chart

## Configuration

Access the extension popup to configure:
- Custom API URL (use `{symbol}` as placeholder)
- API Key and Header name
- Alert levels for price notifications

## Files

- `manifest.json` - Extension configuration
- `content.js` - Main script injected into TradingView
- `content.css` - Styles for injected elements
- `popup.html/js` - Extension popup UI
- `sidepanel.html/js` - Side panel interface
- `background.js` - Service worker for background tasks

## License

MIT
