module.exports = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'],

  // Large trade thresholds set realistically for whales/institutions
  largeTradeThresholds: {
    BTCUSDT: 0.5,    // ~0.5 BTC is a large trade
    ETHUSDT: 10,     // 10 ETH
    BNBUSDT: 50,     // 50 BNB
    SOLUSDT: 500,    // 500 SOL
  },

  tradeWindowsMs: {
    short: 60 * 1000,          // 1 minute
    main: 3 * 60 * 1000,       // 3 minutes
    long: 5 * 60 * 1000,       // 5 minutes
    extended: 15 * 60 * 1000,  // 15 minutes
    ultraLong: 30 * 60 * 1000, // 30 minutes
  },

  rsiPeriods: {
    short: 1,
    main: 3,
    long: 5,
    extended: 15,
    ultraLong: 30,
  },

  rsiOverbought: 70,
  rsiOversold: 30,

  signalPersistenceMs: 30 * 1000,  // 30 seconds persistence before confirming signal
  signalCooldownMs: 60 * 1000,     // 1 minute cooldown between signals

  volatilityLookback: 14,           // periods for volatility proxy

  telegram: {
    enabled: false,
    botToken: '',
    chatId: '',
  },

  netVolumeThresholds: {
    BTCUSDT: 1,    // 1 BTC net volume threshold for signal boost
    ETHUSDT: 20,
    BNBUSDT: 100,
    SOLUSDT: 1000,
  },

  maxPortfolioRisk: 0.01,           // 1% risk per trade
  takeProfitRatio: 2,               // 2x risk reward ratio
  telegram: {
    enabled: true,
    botToken: '7509629296:AAGeyh69fa526FWZXs7F04l_vbiNtKfny4w',
    chatId: '214027079',
  },
};