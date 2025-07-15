module.exports = {
  symbols: ['bnbusdt', 'ethusdt', 'btcusdt', 'solusdt'],
  largeTradeThresholds: {
    BNBUSDT: 1000000 / 705,
    ETHUSDT: 1000000 / 3041,
    BTCUSDT: 1000000 / 122189,
    SOLUSDT: 1000000 / 167.56,
  },
  serverPort: 3000,
  tradeWindowsMs: {
    short: 60 * 1000,
    main: 3 * 60 * 1000,
    long: 5 * 60 * 1000,
  },
  rsiPeriods: {
    short: 14,
    main: 20,
    long: 26,
  },
  emaShortPeriod: 12,
  emaLongPeriod: 26,
  macdSignalPeriod: 9,
  bbPeriod: 20,
  bbStdDev: 2,
  netVolumeThresholds: {
    BNBUSDT: 500,
    ETHUSDT: 200,
    BTCUSDT: 5,
    SOLUSDT: 3000,
  },
  rsiOverbought: 70,
  rsiOversold: 30,
  signalPersistenceMs: 5 * 60 * 1000, // 5 minutes, adjust for testing
  signalCooldownMs: 2 * 60 * 1000,    // 2 minutes
  takeProfitRatio: 2,
  maxPortfolioRisk: 0.02,
  volatilityLookback: 20,
  telegram: {
    enabled: true,
    botToken: '7509629296:AAGeyh69fa526FWZXs7F04l_vbiNtKfny4w',
    chatId: '214027079',
  },
};