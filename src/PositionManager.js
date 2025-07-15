const config = require('./config');

class PositionManager {
  constructor(portfolioBalance = 100000) {
    this.positions = new Map();
    this.portfolioBalance = portfolioBalance;
  }

  openPosition(symbol, entryPrice, signalConfidence, atr) {
    if (this.positions.has(symbol)) return;

    const riskPerTrade = this.portfolioBalance * config.maxPortfolioRisk;
    const stopLossDistance = atr * 2;
    const positionSize = Math.floor(riskPerTrade / stopLossDistance);
    const takeProfitPrice = entryPrice * (1 + config.takeProfitRatio * 0.05);
    const stopLossPrice = entryPrice - stopLossDistance;

    this.positions.set(symbol, {
      entryPrice,
      positionSize,
      maxPrice: entryPrice,
      stopLossPrice,
      takeProfitPrice,
      signalConfidence,
    });

    console.log(`[POSITION OPENED] ${symbol} at ${entryPrice}, Size: ${positionSize}, Stop: ${stopLossPrice.toFixed(2)}, Take Profit: ${takeProfitPrice.toFixed(2)}, Confidence: ${(signalConfidence * 100).toFixed(0)}%`);
  }

  updatePrice(symbol, currentPrice) {
    const pos = this.positions.get(symbol);
    if (!pos) return;

    if (currentPrice > pos.maxPrice) {
      pos.maxPrice = currentPrice;
      pos.stopLossPrice = currentPrice - (pos.entryPrice - pos.stopLossPrice);
      console.log(`[POSITION UPDATED] ${symbol} maxPrice: ${pos.maxPrice.toFixed(2)}, stopLossPrice: ${pos.stopLossPrice.toFixed(2)}`);
    }

    if (currentPrice <= pos.stopLossPrice) {
      console.log(`[POSITION EXIT] ${symbol} at ${currentPrice.toFixed(2)} (stop loss triggered)`);
      this.positions.delete(symbol);
    } else if (currentPrice >= pos.takeProfitPrice) {
      console.log(`[POSITION EXIT] ${symbol} at ${currentPrice.toFixed(2)} (take profit triggered)`);
      this.positions.delete(symbol);
    }
  }

  closePosition(symbol) {
    if (this.positions.has(symbol)) {
      console.log(`[POSITION CLOSED] ${symbol}`);
      this.positions.delete(symbol);
    }
  }

  getPosition(symbol) {
    return this.positions.get(symbol) || null;
  }
}

module.exports = PositionManager;