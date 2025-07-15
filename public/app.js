const socket = io();

const summaryBody = document.getElementById('summaryBody');
const largeTradesDiv = document.getElementById('largeTrades');
const insightsDiv = document.getElementById('insights');
const newsContainer = document.getElementById('newsContainer');

const MAX_LARGE_TRADES = 50;

const config = {
  netVolumeThreshold: 50,
  rsiOverbought: 70,
  rsiOversold: 30,
};

const largeTrades = [];

function formatNumber(num, decimals = 2) {
  return num !== null && num !== undefined ? num.toFixed(decimals) : 'N/A';
}

function formatDuration(seconds) {
  if (seconds < 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function renderSummary(data) {
  const { summary, signals, signalDurations, signalConfidences } = data;
  summaryBody.innerHTML = '';
  summary.forEach(s => {
    const {
      symbol, lastPrice, buyVolume, sellVolume, netVolume,
      rsiShort, rsiMain, rsiLong, macd, signal, bb,
      openInterest, fundingRate, atr,
    } = s;

    const netClass = netVolume > 0 ? 'positive' : netVolume < 0 ? 'negative' : '';
    const rsiClassShort = rsiShort > config.rsiOverbought ? 'rsi-high' : rsiShort < config.rsiOversold ? 'rsi-low' : '';
    const rsiClassMain = rsiMain > config.rsiOverbought ? 'rsi-high' : rsiMain < config.rsiOversold ? 'rsi-low' : '';
    const rsiClassLong = rsiLong > config.rsiOverbought ? 'rsi-high' : rsiLong < config.rsiOversold ? 'rsi-low' : '';

    const signalText = signals[symbol] || 'NEUTRAL';
    const signalColor = signalText === 'LONG' ? 'positive' : signalText === 'SHORT' ? 'negative' : '';
    const duration = signalDurations[symbol] || 0;
    const confidence = signalConfidences[symbol] || 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${symbol}</td>
      <td>${formatNumber(lastPrice, 4)}</td>
      <td>${formatNumber(buyVolume)}</td>
      <td>${formatNumber(sellVolume)}</td>
      <td class="${netClass}">${formatNumber(netVolume)}</td>
      <td class="${rsiClassShort}">${formatNumber(rsiShort)}</td>
      <td class="${rsiClassMain}">${formatNumber(rsiMain)}</td>
      <td class="${rsiClassLong}">${formatNumber(rsiLong)}</td>
      <td>${formatNumber(macd)}</td>
      <td>${formatNumber(signal)}</td>
      <td>${bb ? formatNumber(bb.lower) : 'N/A'}</td>
      <td>${bb ? formatNumber(bb.middle) : 'N/A'}</td>
      <td>${bb ? formatNumber(bb.upper) : 'N/A'}</td>
      <td>${formatNumber(atr, 4)}</td>
      <td>${openInterest !== undefined && openInterest !== null ? formatNumber(openInterest, 0) : 'N/A'}</td>
      <td>${fundingRate !== undefined && fundingRate !== null ? (fundingRate * 100).toFixed(4) + '%' : 'N/A'}</td>
      <td class="${signalColor}">${signalText} (${formatDuration(duration)}, Confidence: ${(confidence * 100).toFixed(0)}%)</td>
    `;
    summaryBody.appendChild(tr);
  });
}

function addLargeTradeAlert({ symbol, side, price, quantity, time }) {
  const div = document.createElement('div');
  div.classList.add('alert', side.toLowerCase());
  div.textContent = `${time} - ${symbol} ${side} ${quantity.toFixed(2)} @ ${price.toFixed(4)}`;
  largeTradesDiv.prepend(div);

  largeTrades.unshift(div);
  if (largeTrades.length > MAX_LARGE_TRADES) {
    const last = largeTrades.pop();
    largeTradesDiv.removeChild(last);
  }
}

function generateInsights(data) {
  const { summary, signals, signalDurations, signalConfidences } = data;
  if (!summary.length) {
    insightsDiv.textContent = 'No data available.';
    return;
  }

  const lines = summary.map(s => {
    const sig = signals[s.symbol] || 'NEUTRAL';
    const dur = signalDurations[s.symbol] || 0;
    const conf = signalConfidences[s.symbol] || 0;
    let advice = 'Caution advised. Monitor for stronger signals.';
    if (sig === 'LONG') {
      advice = `Consider LONG position (Confidence: ${(conf * 100).toFixed(0)}%).`;
    } else if (sig === 'SHORT') {
      advice = `Consider SHORT position (Confidence: ${(conf * 100).toFixed(0)}%).`;
    }
    return `${s.symbol}: ${sig} signal (active ${formatDuration(dur)}). ${advice}`;
  });

  insightsDiv.textContent = lines.join('\n\n');
}

socket.on('connect', () => {
  console.log('Socket connected');
  insightsDiv.textContent = 'Connected. Waiting for data...';
});

socket.on('summary', (data) => {
  console.log('Summary received:', data);
  renderSummary(data);
  generateInsights(data);
});

socket.on('largeTrade', (data) => {
  console.log('Large trade received:', data);
  addLargeTradeAlert(data);
});

socket.on('news', (data) => {
  console.log('News received:', data);
  updateNews(data); // if you have a function to update news
});

socket.on('disconnect', () => {
  console.log('Socket disconnected');
  insightsDiv.textContent = 'Disconnected from server.';
});