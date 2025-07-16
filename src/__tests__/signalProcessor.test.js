const {
  generateSignal,
  updateSignalWithWhaleTrades,
  signalPersistenceMs,
  signalCooldownMs,
} = require('../signalProcessor');

describe('Signal Processor', () => {
  let signalState;
  let tradesMap;
  const largeTradeThresholds = { BTCUSDT: 1000 };

  beforeEach(() => {
    signalState = {};
    tradesMap = new Map();
  });

  test('generateSignal returns NEUTRAL when no strong signals', () => {
    const summary = [{
      symbol: 'BTCUSDT',
      netVolume: 0,
      rsiMain: 50,
      rsiShort: 50,
      rsiLong: 50,
      macd: 0,
      signal: 0,
      bb: { lower: 100, upper: 200 },
      fundingRate: 0,
      openInterestTrend: 0,
      lastPrice: 150,
      volatilityProxy: 0,
    }];

    const config = {
      rsiOversold: 30,
      rsiOverbought: 70,
      netVolumeThresholds: { BTCUSDT: 100 },
    };

    const { signals } = generateSignal(summary, signalState, config);
    expect(signals.BTCUSDT).toBe('NEUTRAL');
  });

  test('generateSignal returns LONG when conditions met after persistence and cooldown', () => {
    const baseTime = Date.now();

    // Mock Date.now() to simulate time passage
    let now = baseTime;
    jest.spyOn(global.Date, 'now').mockImplementation(() => now);

    const summary = [{
      symbol: 'BTCUSDT',
      netVolume: 200,
      rsiMain: 25,
      rsiShort: 20,
      rsiLong: 22,
      macd: 1,
      signal: 0,
      bb: { lower: 100, upper: 200 },
      fundingRate: 0.01,
      openInterestTrend: 1,
      lastPrice: 90,
      volatilityProxy: 1,
    }];

    const config = {
      rsiOversold: 30,
      rsiOverbought: 70,
      netVolumeThresholds: { BTCUSDT: 100 },
    };

    // First call: signal changes to LONG but not confirmed yet
    let result = generateSignal(summary, signalState, config);
    expect(result.signals.BTCUSDT).toBe('NEUTRAL');

    // Advance time by signalPersistenceMs + signalCooldownMs + 1000ms
    now += signalPersistenceMs + signalCooldownMs + 1000;

    // Second call: signal should be confirmed LONG now
    result = generateSignal(summary, signalState, config);
    expect(result.signals.BTCUSDT).toBe('LONG');
    expect(result.signalConfidences.BTCUSDT).toBeGreaterThan(0);

    // Restore Date.now()
    global.Date.now.mockRestore();
  });

  test('updateSignalWithWhaleTrades boosts confidence or changes signal', () => {
    const symbol = 'BTCUSDT';
    signalState[symbol] = {
      currentSignal: 'NEUTRAL',
      lastChangeTimestamp: Date.now(),
      confirmedSignal: 'NEUTRAL',
      lastConfirmedTimestamp: 0,
      signalStartTimestamp: 0,
      lastConfidence: 0,
    };

    tradesMap.set(symbol, [
      { classification: 'WHALE', side: 'BUY', quantity: 1500, timestamp: Date.now() },
    ]);

    updateSignalWithWhaleTrades(symbol, tradesMap, signalState, largeTradeThresholds);

    expect(signalState[symbol].currentSignal).toBe('LONG');
    expect(signalState[symbol].lastConfidence).toBeGreaterThanOrEqual(0.5);
  });

  test('signal confirms only after persistence and cooldown', () => {
    const symbol = 'BTCUSDT';
    const now = Date.now();

    signalState[symbol] = {
      currentSignal: 'LONG',
      lastChangeTimestamp: now - signalPersistenceMs - 1000,
      confirmedSignal: 'NEUTRAL',
      lastConfirmedTimestamp: now - signalCooldownMs - 1000,
      signalStartTimestamp: 0,
      lastConfidence: 0.7,
    };

    const summary = [{
      symbol,
      netVolume: 200,
      rsiMain: 25,
      rsiShort: 20,
      rsiLong: 22,
      macd: 1,
      signal: 0,
      bb: { lower: 100, upper: 200 },
      fundingRate: 0.01,
      openInterestTrend: 1,
      lastPrice: 90,
      volatilityProxy: 1,
    }];

    const config = {
      rsiOversold: 30,
      rsiOverbought: 70,
      netVolumeThresholds: { BTCUSDT: 100 },
    };

    const { signals } = generateSignal(summary, signalState, config);

    expect(signals.BTCUSDT).toBe('LONG');
    expect(signalState[symbol].confirmedSignal).toBe('LONG');
  });
});