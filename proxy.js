process.on('uncaughtException', err => { console.error('ERROR:', err); process.exit(1); });
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── YAHOO FINANCE: datos fundamentales reales ─────────────────────
function fetchYahooFundamentals(ticker) {
  return new Promise((resolve) => {
    const yTicker = ticker.replace('BTC', 'BTC-USD').replace('ETH', 'ETH-USD');
    const yPath = `/v10/finance/quoteSummary/${encodeURIComponent(yTicker)}?modules=defaultKeyStatistics,financialData,assetProfile`;
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path: yPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const result = data?.quoteSummary?.result?.[0] || {};
          const fin = result.financialData || {};
          const stats = result.defaultKeyStatistics || {};
          const profile = result.assetProfile || {};
          resolve({
            ticker,
            price:            fin.currentPrice?.raw           ?? null,
            pe_trailing:      stats.trailingPE?.raw           ?? null,
            pe_forward:       stats.forwardPE?.raw            ?? null,
            revenue_growth:   fin.revenueGrowth?.raw          ?? null,
            gross_margin:     fin.grossMargins?.raw           ?? null,
            operating_margin: fin.operatingMargins?.raw       ?? null,
            net_margin:       fin.profitMargins?.raw          ?? null,
            debt_to_equity:   stats.debtToEquity?.raw         ?? null,
            eps_growth_qtr:   stats.earningsQuarterlyGrowth?.raw ?? null,
            return_on_equity: fin.returnOnEquity?.raw         ?? null,
            sector:           profile.sector                  ?? null,
            industry:         profile.industry                ?? null,
          });
        } catch(e) {
          resolve({ ticker, error: 'parse_error' });
        }
      });
    });

    req.on('error', () => resolve({ ticker, error: 'fetch_error' }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ ticker, error: 'timeout' }); });
    req.end();
  });
}

// ── HELPER: formatea un número como porcentaje ───────────────────
function pct(v) { return v != null ? (v * 100).toFixed(1) + '%' : 'N/A'; }
function num(v, dec = 1) { return v != null ? v.toFixed(dec) : 'N/A'; }

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Servir el HTML ──────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // ── /api/fundamentals?tickers=NVDA,AAPL,... ────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/fundamentals')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const raw = (qs.get('tickers') || '').toUpperCase();
    const tickers = raw.split(',')
      .map(t => t.trim())
      .filter(t => /^[A-Z0-9.\-]{1,12}$/.test(t))
      .slice(0, 20);

    if (!tickers.length) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'No tickers' })); return;
    }

    try {
      const results = await Promise.all(tickers.map(fetchYahooFundamentals));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(results));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Proxy a Anthropic ──────────────────────────────────────────
  if (req.url === '/v1/messages' && req.method === 'POST') {
    const body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      const bodyData = Buffer.concat(body);
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': bodyData.length
        }
      };
      const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (err) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      });
      proxyReq.write(bodyData);
      proxyReq.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
});
