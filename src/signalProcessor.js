const signalPersistenceMs = 60 * 1000; // 1 minute
const signalCooldownMs = 2 * 60 * 1000; // 2 minutes

function generateSignal(summary, signalState, config) {
  const now = Date.now();

  summary.forEach(s => {
    const {
      symbol, netVolume, rsiMain, rsiShort, rsiLong,
      macd, signal, bb, fundingRate, openInterestTrend,
      lastPrice, volatilityProxy,
    } = s;

    let scoreLong = 0;
    let scoreShort = 0;

    const { rsiOversold, rsiOverbought, netVolumeThresholds } = config;

    // RSI scoring
    if (rsiMain !== null) {
      if (rsiMain < rsiOversold) scoreLong += 1;
      else if (rsiMain > rsiOverbought) scoreShort += 1;
    }
    if (rsiShort !== null) {
      if (rsiShort < rsiOversold) scoreLong += 0.5;
      else if (rsiShort > rsiOverbought) scoreShort += 0.5;
    }
    if (rsiLong !== null) {
      if (rsiLong < rsiOversold) scoreLong += 0.5;
      else if (rsiLong > rsiOverbought) scoreShort += 0.5;
    }

    // MACD scoring
    if (macd !== null && signal !== null) {
      if (macd > signal) scoreLong += 1;
      else if (macd < signal) scoreShort += 1;
    }

    // Bollinger Bands scoring
    if (bb) {
      if (lastPrice < bb.lower) scoreLong += 1;
      else if (lastPrice > bb.upper) scoreShort += 1;
    }

    // Net volume scoring
    if (netVolume !== null) {
      if (netVolume > (netVolumeThresholds[symbol] || 0)) scoreLong += 0.5;
      else if (netVolume < -(netVolumeThresholds[symbol] || 0)) scoreShort += 0.5;
    }

    // Funding rate scoring
    if (fundingRate !== null) {
      if (fundingRate > 0) scoreLong += 0.3;
      else if (fundingRate < 0) scoreShort += 0.3;
    }

    // Open interest trend scoring
    if (openInterestTrend !== null) {
      if (openInterestTrend > 0) scoreLong += 0.3;
      else if (openInterestTrend < 0) scoreShort += 0.3;
    }

    // Volatility proxy scoring
    if (volatilityProxy !== null && volatilityProxy > 0) {
      scoreLong += 0.2;
      scoreShort += 0.2;
    }

    // Determine new signal and confidence
    let newSignal = 'NEUTRAL';
    let confidence = 0;

    if (scoreLong > scoreShort && scoreLong >= 2) {
      newSignal = 'LONG';
      confidence = Math.min(scoreLong / 5, 1);
    } else if (scoreShort > scoreLong && scoreShort >= 2) {
      newSignal = 'SHORT';
      confidence = Math.min(scoreShort / 5, 1);
    }

    if (!signalState[symbol]) {
      signalState[symbol] = {
        currentSignal: 'NEUTRAL',
        lastChangeTimestamp: now,
        confirmedSignal: 'NEUTRAL',
        lastConfirmedTimestamp: 0,
        signalStartTimestamp: 0,
        lastConfidence: 0,
        lastTelegramSignal: null,
      };
    }

    const state = signalState[symbol];

    if (newSignal !== state.currentSignal) {
      state.currentSignal = newSignal;
      state.lastChangeTimestamp = now;
      state.lastConfidence = confidence;
    } else {
      state.lastConfidence = confidence;
    }

    const persistenceTime = now - state.lastChangeTimestamp;
    const cooldownTime = now - state.lastConfirmedTimestamp;

    if (
      newSignal !== state.confirmedSignal &&
      newSignal !== 'NEUTRAL' &&
      persistenceTime >= signalPersistenceMs &&
      cooldownTime >= signalCooldownMs
    ) {
      state.confirmedSignal = newSignal;
      state.lastConfirmedTimestamp = now;
      state.signalStartTimestamp = now;
      state.lastConfidence = confidence;
    }

    if (state.confirmedSignal === 'NEUTRAL') {
      state.signalStartTimestamp = 0;
      state.lastConfidence = 0;
    } else if (state.signalStartTimestamp === 0) {
      state.signalStartTimestamp = now;
    }
  });

  const signals = {};
  const signalDurations = {};
  const signalConfidences = {};
  for (const symbol in signalState) {
    const state = signalState[symbol];
    signals[symbol] = state.confirmedSignal;
    signalDurations[symbol] = state.signalStartTimestamp ? Math.floor((Date.now() - state.signalStartTimestamp) / 1000) : 0;
    signalConfidences[symbol] = state.lastConfidence;
  }

  return { signals, signalDurations, signalConfidences };
}

function updateSignalWithWhaleTrades(symbol, tradesMap, signalState, largeTradeThresholds) {
  const trades = tradesMap.get(symbol) || [];
  const now = Date.now();
  const recentWhaleTrades = trades.filter(t => t.classification === 'WHALE' && now - t.timestamp < 5 * 60 * 1000);
  const whaleBuyVol = recentWhaleTrades.filter(t => t.side === 'BUY').reduce((a, t) => a + t.quantity, 0);
  const whaleSellVol = recentWhaleTrades.filter(t => t.side === 'SELL').reduce((a, t) => a + t.quantity, 0);

  if (!signalState[symbol]) return;

  const state = signalState[symbol];

  if (whaleBuyVol > (largeTradeThresholds[symbol] || 0)) {
    if (state.currentSignal === 'LONG') {
      state.lastConfidence = Math.min(state.lastConfidence + 0.2, 1);
    } else {
      state.currentSignal = 'LONG';
      state.lastChangeTimestamp = now;
      state.lastConfidence = 0.5;
    }
  } else if (whaleSellVol > (largeTradeThresholds[symbol] || 0)) {
    if (state.currentSignal === 'SHORT') {
      state.lastConfidence = Math.min(state.lastConfidence + 0.2, 1);
    } else {
      state.currentSignal = 'SHORT';
      state.lastChangeTimestamp = now;
      state.lastConfidence = 0.5;
    }
  }
}

module.exports = {
  generateSignal,
  updateSignalWithWhaleTrades,
  signalPersistenceMs,
  signalCooldownMs,
};