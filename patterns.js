// Candlestick Pattern Detection Module
// Detects common candlestick patterns and returns confidence scores

(function(global) {
  'use strict';

  // ============ UTILITY FUNCTIONS ============

  function bodySize(candle) {
    return Math.abs(candle.close - candle.open);
  }

  function totalRange(candle) {
    return candle.high - candle.low;
  }

  function upperWick(candle) {
    return candle.high - Math.max(candle.open, candle.close);
  }

  function lowerWick(candle) {
    return Math.min(candle.open, candle.close) - candle.low;
  }

  function isBullish(candle) {
    return candle.close > candle.open;
  }

  function isBearish(candle) {
    return candle.close < candle.open;
  }

  function bodyTop(candle) {
    return Math.max(candle.open, candle.close);
  }

  function bodyBottom(candle) {
    return Math.min(candle.open, candle.close);
  }

  function bodyMidpoint(candle) {
    return (candle.open + candle.close) / 2;
  }

  // Check if price is approximately equal (within tolerance)
  function priceEqual(a, b, tolerance = 0.001) {
    const avg = (Math.abs(a) + Math.abs(b)) / 2;
    if (avg === 0) return true;
    return Math.abs(a - b) / avg < tolerance;
  }

  // Calculate average body size over N candles
  function avgBodySize(candles, n = 10) {
    const subset = candles.slice(-n);
    if (subset.length === 0) return 0;
    return subset.reduce((sum, c) => sum + bodySize(c), 0) / subset.length;
  }

  // Determine trend direction (1 = up, -1 = down, 0 = sideways)
  function getTrend(candles, lookback = 5) {
    if (candles.length < lookback) return 0;
    const subset = candles.slice(-lookback);
    const first = subset[0].close;
    const last = subset[subset.length - 1].close;
    const change = (last - first) / first;
    if (change > 0.01) return 1;  // Up trend
    if (change < -0.01) return -1; // Down trend
    return 0; // Sideways
  }

  // ============ SINGLE CANDLE PATTERNS ============

  function detectDoji(candle, avgBody) {
    const body = bodySize(candle);
    const range = totalRange(candle);
    if (range === 0) return null;

    const bodyRatio = body / range;

    // Doji: very small body relative to range
    if (bodyRatio < 0.1) {
      const upper = upperWick(candle);
      const lower = lowerWick(candle);

      // Determine doji type
      let subtype = 'Doji';
      if (upper > lower * 2) subtype = 'Gravestone Doji';
      else if (lower > upper * 2) subtype = 'Dragonfly Doji';
      else if (priceEqual(upper, lower, 0.1)) subtype = 'Long-Legged Doji';

      return {
        name: subtype,
        direction: 'neutral',
        confidence: Math.round((1 - bodyRatio) * 80 + 20),
        description: 'Indecision - potential reversal'
      };
    }
    return null;
  }

  function detectHammer(candle, avgBody, trend) {
    const body = bodySize(candle);
    const range = totalRange(candle);
    const lower = lowerWick(candle);
    const upper = upperWick(candle);

    if (range === 0 || body === 0) return null;

    // Hammer: long lower wick, small upper wick, appears in downtrend
    if (lower >= body * 2 && upper < body * 0.5) {
      const isHammer = trend === -1;
      const name = isHammer ? 'Hammer' : 'Hanging Man';
      const direction = isHammer ? 'bullish' : 'bearish';
      const confidence = Math.min(95, Math.round((lower / body) * 20 + 50));

      return {
        name,
        direction,
        confidence,
        description: isHammer ? 'Bullish reversal signal' : 'Bearish reversal signal'
      };
    }
    return null;
  }

  function detectShootingStar(candle, avgBody, trend) {
    const body = bodySize(candle);
    const range = totalRange(candle);
    const lower = lowerWick(candle);
    const upper = upperWick(candle);

    if (range === 0 || body === 0) return null;

    // Shooting Star: long upper wick, small lower wick, appears in uptrend
    if (upper >= body * 2 && lower < body * 0.5) {
      const isStar = trend === 1;
      const name = isStar ? 'Shooting Star' : 'Inverted Hammer';
      const direction = isStar ? 'bearish' : 'bullish';
      const confidence = Math.min(95, Math.round((upper / body) * 20 + 50));

      return {
        name,
        direction,
        confidence,
        description: isStar ? 'Bearish reversal signal' : 'Bullish reversal signal'
      };
    }
    return null;
  }

  function detectSpinningTop(candle, avgBody) {
    const body = bodySize(candle);
    const range = totalRange(candle);
    const lower = lowerWick(candle);
    const upper = upperWick(candle);

    if (range === 0) return null;

    const bodyRatio = body / range;

    // Spinning Top: small body, roughly equal wicks
    if (bodyRatio > 0.1 && bodyRatio < 0.35) {
      if (priceEqual(upper, lower, 0.3)) {
        return {
          name: 'Spinning Top',
          direction: 'neutral',
          confidence: Math.round(70 - bodyRatio * 100),
          description: 'Indecision in the market'
        };
      }
    }
    return null;
  }

  function detectMarubozu(candle, avgBody) {
    const body = bodySize(candle);
    const range = totalRange(candle);
    const lower = lowerWick(candle);
    const upper = upperWick(candle);

    if (range === 0) return null;

    const bodyRatio = body / range;

    // Marubozu: body is almost entire range (minimal wicks)
    if (bodyRatio > 0.9) {
      const direction = isBullish(candle) ? 'bullish' : 'bearish';
      const name = direction === 'bullish' ? 'Bullish Marubozu' : 'Bearish Marubozu';

      return {
        name,
        direction,
        confidence: Math.round(bodyRatio * 100),
        description: 'Strong ' + direction + ' momentum'
      };
    }
    return null;
  }

  // ============ TWO CANDLE PATTERNS ============

  function detectEngulfing(candles) {
    if (candles.length < 2) return null;

    const prev = candles[candles.length - 2];
    const curr = candles[candles.length - 1];

    const prevBody = bodySize(prev);
    const currBody = bodySize(curr);

    if (prevBody === 0 || currBody === 0) return null;

    // Bullish Engulfing: bearish candle followed by bullish that engulfs
    if (isBearish(prev) && isBullish(curr)) {
      if (bodyBottom(curr) < bodyBottom(prev) && bodyTop(curr) > bodyTop(prev)) {
        const engulfRatio = currBody / prevBody;
        return {
          name: 'Bullish Engulfing',
          direction: 'bullish',
          confidence: Math.min(95, Math.round(50 + engulfRatio * 20)),
          description: 'Strong bullish reversal pattern'
        };
      }
    }

    // Bearish Engulfing: bullish candle followed by bearish that engulfs
    if (isBullish(prev) && isBearish(curr)) {
      if (bodyTop(curr) > bodyTop(prev) && bodyBottom(curr) < bodyBottom(prev)) {
        const engulfRatio = currBody / prevBody;
        return {
          name: 'Bearish Engulfing',
          direction: 'bearish',
          confidence: Math.min(95, Math.round(50 + engulfRatio * 20)),
          description: 'Strong bearish reversal pattern'
        };
      }
    }

    return null;
  }

  function detectHarami(candles) {
    if (candles.length < 2) return null;

    const prev = candles[candles.length - 2];
    const curr = candles[candles.length - 1];

    const prevBody = bodySize(prev);
    const currBody = bodySize(curr);

    if (prevBody === 0) return null;

    // Current candle body is contained within previous body
    const contained = bodyTop(curr) < bodyTop(prev) && bodyBottom(curr) > bodyBottom(prev);

    if (!contained) return null;

    const sizeRatio = currBody / prevBody;

    // Bullish Harami: large bearish followed by small bullish inside
    if (isBearish(prev) && isBullish(curr) && sizeRatio < 0.5) {
      return {
        name: 'Bullish Harami',
        direction: 'bullish',
        confidence: Math.round(60 + (0.5 - sizeRatio) * 60),
        description: 'Potential bullish reversal'
      };
    }

    // Bearish Harami: large bullish followed by small bearish inside
    if (isBullish(prev) && isBearish(curr) && sizeRatio < 0.5) {
      return {
        name: 'Bearish Harami',
        direction: 'bearish',
        confidence: Math.round(60 + (0.5 - sizeRatio) * 60),
        description: 'Potential bearish reversal'
      };
    }

    return null;
  }

  function detectTweezer(candles) {
    if (candles.length < 2) return null;

    const prev = candles[candles.length - 2];
    const curr = candles[candles.length - 1];

    // Tweezer Top: equal highs
    if (priceEqual(prev.high, curr.high, 0.002)) {
      if (isBullish(prev) && isBearish(curr)) {
        return {
          name: 'Tweezer Top',
          direction: 'bearish',
          confidence: 70,
          description: 'Bearish reversal at resistance'
        };
      }
    }

    // Tweezer Bottom: equal lows
    if (priceEqual(prev.low, curr.low, 0.002)) {
      if (isBearish(prev) && isBullish(curr)) {
        return {
          name: 'Tweezer Bottom',
          direction: 'bullish',
          confidence: 70,
          description: 'Bullish reversal at support'
        };
      }
    }

    return null;
  }

  function detectPiercingDarkCloud(candles) {
    if (candles.length < 2) return null;

    const prev = candles[candles.length - 2];
    const curr = candles[candles.length - 1];

    const prevBody = bodySize(prev);
    const currBody = bodySize(curr);

    if (prevBody === 0) return null;

    // Piercing Line: bearish then bullish that closes above 50% of prev body
    if (isBearish(prev) && isBullish(curr)) {
      const midpoint = bodyMidpoint(prev);
      if (curr.open < prev.low && curr.close > midpoint && curr.close < prev.open) {
        const penetration = (curr.close - bodyBottom(prev)) / prevBody;
        return {
          name: 'Piercing Line',
          direction: 'bullish',
          confidence: Math.round(50 + penetration * 40),
          description: 'Bullish reversal pattern'
        };
      }
    }

    // Dark Cloud Cover: bullish then bearish that closes below 50% of prev body
    if (isBullish(prev) && isBearish(curr)) {
      const midpoint = bodyMidpoint(prev);
      if (curr.open > prev.high && curr.close < midpoint && curr.close > prev.open) {
        const penetration = (bodyTop(prev) - curr.close) / prevBody;
        return {
          name: 'Dark Cloud Cover',
          direction: 'bearish',
          confidence: Math.round(50 + penetration * 40),
          description: 'Bearish reversal pattern'
        };
      }
    }

    return null;
  }

  // ============ THREE CANDLE PATTERNS ============

  function detectMorningStar(candles) {
    if (candles.length < 3) return null;

    const first = candles[candles.length - 3];
    const second = candles[candles.length - 2];
    const third = candles[candles.length - 1];

    const firstBody = bodySize(first);
    const secondBody = bodySize(second);
    const thirdBody = bodySize(third);

    if (firstBody === 0) return null;

    // Morning Star: bearish, small body (gap down), bullish closes above first midpoint
    if (isBearish(first) && isBullish(third)) {
      const smallMiddle = secondBody < firstBody * 0.3;
      const gapDown = bodyTop(second) < bodyBottom(first);
      const strongClose = third.close > bodyMidpoint(first);

      if (smallMiddle && strongClose) {
        const confidence = gapDown ? 85 : 70;
        return {
          name: 'Morning Star',
          direction: 'bullish',
          confidence,
          description: 'Strong bullish reversal pattern'
        };
      }
    }

    return null;
  }

  function detectEveningStar(candles) {
    if (candles.length < 3) return null;

    const first = candles[candles.length - 3];
    const second = candles[candles.length - 2];
    const third = candles[candles.length - 1];

    const firstBody = bodySize(first);
    const secondBody = bodySize(second);
    const thirdBody = bodySize(third);

    if (firstBody === 0) return null;

    // Evening Star: bullish, small body (gap up), bearish closes below first midpoint
    if (isBullish(first) && isBearish(third)) {
      const smallMiddle = secondBody < firstBody * 0.3;
      const gapUp = bodyBottom(second) > bodyTop(first);
      const strongClose = third.close < bodyMidpoint(first);

      if (smallMiddle && strongClose) {
        const confidence = gapUp ? 85 : 70;
        return {
          name: 'Evening Star',
          direction: 'bearish',
          confidence,
          description: 'Strong bearish reversal pattern'
        };
      }
    }

    return null;
  }

  function detectThreeSoldiers(candles) {
    if (candles.length < 3) return null;

    const c1 = candles[candles.length - 3];
    const c2 = candles[candles.length - 2];
    const c3 = candles[candles.length - 1];

    // Three White Soldiers: 3 consecutive bullish candles, each opening within prior body
    if (isBullish(c1) && isBullish(c2) && isBullish(c3)) {
      const rising = c2.close > c1.close && c3.close > c2.close;
      const properOpens = c2.open > c1.open && c2.open < c1.close &&
                          c3.open > c2.open && c3.open < c2.close;
      const noLongWicks = upperWick(c1) < bodySize(c1) * 0.3 &&
                          upperWick(c2) < bodySize(c2) * 0.3 &&
                          upperWick(c3) < bodySize(c3) * 0.3;

      if (rising && properOpens && noLongWicks) {
        return {
          name: 'Three White Soldiers',
          direction: 'bullish',
          confidence: 85,
          description: 'Strong bullish continuation'
        };
      }
    }

    // Three Black Crows: 3 consecutive bearish candles
    if (isBearish(c1) && isBearish(c2) && isBearish(c3)) {
      const falling = c2.close < c1.close && c3.close < c2.close;
      const properOpens = c2.open < c1.open && c2.open > c1.close &&
                          c3.open < c2.open && c3.open > c2.close;
      const noLongWicks = lowerWick(c1) < bodySize(c1) * 0.3 &&
                          lowerWick(c2) < bodySize(c2) * 0.3 &&
                          lowerWick(c3) < bodySize(c3) * 0.3;

      if (falling && properOpens && noLongWicks) {
        return {
          name: 'Three Black Crows',
          direction: 'bearish',
          confidence: 85,
          description: 'Strong bearish continuation'
        };
      }
    }

    return null;
  }

  // ============ MAIN DETECTION CLASS ============

  class PatternDetector {
    constructor(options = {}) {
      this.minConfidence = options.minConfidence || 60;
      this.enabledPatterns = options.enabledPatterns || null; // null = all enabled
    }

    isEnabled(patternName) {
      if (!this.enabledPatterns) return true;
      return this.enabledPatterns.includes(patternName);
    }

    detect(candles) {
      if (!candles || candles.length === 0) return [];

      const patterns = [];
      const avgBody = avgBodySize(candles, 10);
      const trend = getTrend(candles, 5);
      const lastCandle = candles[candles.length - 1];

      // Single candle patterns (check last candle)
      const singlePatterns = [
        this.isEnabled('Doji') && detectDoji(lastCandle, avgBody),
        this.isEnabled('Hammer') && detectHammer(lastCandle, avgBody, trend),
        this.isEnabled('Shooting Star') && detectShootingStar(lastCandle, avgBody, trend),
        this.isEnabled('Spinning Top') && detectSpinningTop(lastCandle, avgBody),
        this.isEnabled('Marubozu') && detectMarubozu(lastCandle, avgBody)
      ];

      // Two candle patterns
      const twoPatterns = [
        this.isEnabled('Engulfing') && detectEngulfing(candles),
        this.isEnabled('Harami') && detectHarami(candles),
        this.isEnabled('Tweezer') && detectTweezer(candles),
        this.isEnabled('Piercing/Dark Cloud') && detectPiercingDarkCloud(candles)
      ];

      // Three candle patterns
      const threePatterns = [
        this.isEnabled('Morning Star') && detectMorningStar(candles),
        this.isEnabled('Evening Star') && detectEveningStar(candles),
        this.isEnabled('Three Soldiers/Crows') && detectThreeSoldiers(candles)
      ];

      // Collect all valid patterns above confidence threshold
      [...singlePatterns, ...twoPatterns, ...threePatterns].forEach(p => {
        if (p && p.confidence >= this.minConfidence) {
          p.timestamp = lastCandle.timestamp;
          p.symbol = lastCandle.symbol;
          p.timeframe = lastCandle.timeframe;
          patterns.push(p);
        }
      });

      // Sort by confidence descending
      return patterns.sort((a, b) => b.confidence - a.confidence);
    }
  }

  // Export to global scope
  global.PatternDetector = PatternDetector;
  global.CandlePatterns = {
    PatternDetector,
    utils: {
      bodySize,
      totalRange,
      upperWick,
      lowerWick,
      isBullish,
      isBearish,
      avgBodySize,
      getTrend
    }
  };

})(typeof window !== 'undefined' ? window : this);
