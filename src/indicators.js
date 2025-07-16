// RSI calculation
function calculateRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;

  let rs = gains / losses;
  let rsi = 100 - (100 / (1 + rs));

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    let gain = diff > 0 ? diff : 0;
    let loss = diff < 0 ? -diff : 0;

    gains = (gains * (period - 1) + gain) / period;
    losses = (losses * (period - 1) + loss) / period;

    if (losses === 0) rsi = 100;
    else {
      rs = gains / losses;
      rsi = 100 - (100 / (1 + rs));
    }
  }

  return +rsi.toFixed(2);
}

// MACD placeholder
function calculateMACD(prices, symbol) {
  // Implement your MACD calculation or use a library
  return { macd: 0.5, signal: 0.3 };
}

// Bollinger Bands
function calculateBollingerBands(prices) {
  if (!prices || prices.length === 0) return null;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
  const stdDev = Math.sqrt(variance);
  return {
    lower: mean - 2 * stdDev,
    upper: mean + 2 * stdDev,
  };
}

// ATR placeholder
function calculateATR(prices) {
  // Implement your ATR calculation or use a library
  return 1;
}

// Volatility proxy (rolling std dev)
function calculateVolatilityProxy(prices, lookback) {
  if (!prices || prices.length < lookback) return 0;
  const slice = prices.slice(-lookback);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

module.exports = {
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  calculateVolatilityProxy,
};