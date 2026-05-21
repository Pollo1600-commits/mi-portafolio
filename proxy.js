process.on('uncaughtException', err => { console.error('ERROR:', err); process.exit(1); });
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3000;

// ── FINANCIAL MODELING PREP: fundamentales reales TTM ─────────────
// Requiere FMP_API_KEY en Render (gratis en financialmodelingprep.com)
function fetchFMP(ticker, apiKey) {
  return new Promise((resolve) => {
    const t = ticker.replace('-USD', '');           // BTC-USD → BTC (FMP format)
    const reqPath = `/api/v3/ratios-ttm/${encodeURIComponent(t)}?apikey=${apiKey}`;
    const reqGrowth = `/api/v3/financial-growth/${encodeURIComponent(t)}?limit=1&apikey=${apiKey}`;

    let ratiosData = null, growthData = null, done = 0;

    function tryResolve() {
      if (++done < 2) return;
      try {
        const r = Array.isArray(ratiosData) && ratiosData[0] ? ratiosData[0] : {};
        const g = Array.isArray(growthData)  && growthData[0]  ? growthData[0]  : {};
        resolve({
          ticker,
          pe_trailing:      r.peRatioTTM             ?? null,
          net_margin:       r.netProfitMarginTTM      ?? null,
          gross_margin:     r.grossProfitMarginTTM    ?? null,
          return_on_equity: r.returnOnEquityTTM       ?? null,
          debt_to_equity:   r.debtEquityRatioTTM      ?? null,
          revenue_growth:   g.revenueGrowth           ?? null,   // decimal, ej: 0.22 = +22%
          net_income_growth:g.netIncomeGrowth         ?? null,
        });
      } catch(e) { resolve({ ticker, error: 'parse' }); }
    }

    function get(p, cb) {
      const req = https.request(
        { hostname: 'financialmodelingprep.com', path: p, method: 'GET',
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } },
        (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try { cb(JSON.parse(Buffer.concat(chunks).toString())); }
            catch(e) { cb(null); }
          });
        }
      );
      req.on('error', () => cb(null));
      req.setTimeout(7000, () => { req.destroy(); cb(null); });
      req.end();
    }

    get(reqPath,   d => { ratiosData = d; tryResolve(); });
    get(reqGrowth, d => { growthData = d; tryResolve(); });
  });
}

// ── YAHOO FINANCE FALLBACK (si no hay FMP key) ────────────────────
function fetchYahoo(ticker) {
  return new Promise((resolve) => {
    // Intenta con v7/finance/quote (más simple, no requiere crumb)
    const symbols = ticker.replace('BTC', 'BTC-USD').replace('ETH', 'ETH-USD');
    const reqPath = `/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=trailingPE,forwardPE,epsTrailingTwelveMonths,regularMarketPrice,profitMargins,revenueGrowth,debtToEquity,returnOnEquity`;
    const req = https.request(
      { hostname: 'query1.finance.yahoo.com', path: reqPath, method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://finance.yahoo.com',
          'Origin': 'https://finance.yahoo.com',
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            const q = data?.quoteResponse?.result?.[0] || {};
            resolve({
              ticker,
              pe_trailing:      q.trailingPE             ?? null,
              net_margin:       q.profitMargins           ?? null,
              return_on_equity: q.returnOnEquity          ?? null,
              debt_to_equity:   q.debtToEquity            ?? null,
              revenue_growth:   q.revenueGrowth           ?? null,
              price:            q.regularMarketPrice      ?? null,
            });
          } catch(e) { resolve({ ticker, error: 'yahoo_parse' }); }
        });
      }
    );
    req.on('error', () => resolve({ ticker, error: 'yahoo_error' }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ ticker, error: 'yahoo_timeout' }); });
    req.end();
  });
}

// ── HELPER formatters ─────────────────────────────────────────────
const pct = v => v != null ? (v * 100).toFixed(1) + '%' : null;
const fix = (v, d = 1) => v != null ? v.toFixed(d) : null;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Servir el HTML ───────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // ── /api/fundamentals?tickers=NVDA,AMD,... ───────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/fundamentals')) {
    const qs       = new URLSearchParams(req.url.split('?')[1] || '');
    const raw      = (qs.get('tickers') || '').toUpperCase();
    const tickers  = raw.split(',').map(t => t.trim())
                        .filter(t => /^[A-Z0-9.\-]{1,12}$/.test(t))
                        .slice(0, 25);
    const fmpKey   = process.env.FMP_API_KEY || '';
    const source   = fmpKey ? 'fmp' : 'yahoo';

    if (!tickers.length) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'No tickers' })); return;
    }

    try {
      const fetcher = fmpKey
        ? t => fetchFMP(t, fmpKey)
        : t => fetchYahoo(t);

      const results = await Promise.all(tickers.map(fetcher));

      // Normalizar campos para que index.html reciba siempre el mismo formato
      const normalized = results.map(d => ({
        ticker:          d.ticker,
        error:           d.error || null,
        price:           d.price           ?? null,
        pe_trailing:     d.pe_trailing     ?? null,
        net_margin:      d.net_margin      ?? null,
        gross_margin:    d.gross_margin    ?? null,
        return_on_equity:d.return_on_equity?? null,
        debt_to_equity:  d.debt_to_equity  ?? null,
        revenue_growth:  d.revenue_growth  ?? null,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ source, date: new Date().toISOString().split('T')[0], data: normalized }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Proxy a Anthropic ────────────────────────────────────────────
  if (req.url === '/v1/messages' && req.method === 'POST') {
    const body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      const bodyData = Buffer.concat(body);
      const options  = {
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers:  {
          'Content-Type':    'application/json',
          'x-api-key':       process.env.ANTHROPIC_API_KEY,
          'anthropic-version':'2023-06-01',
          'Content-Length':  bodyData.length,
        }
      };
      const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', err => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
      proxyReq.write(bodyData);
      proxyReq.end();
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const hasFMP   = !!process.env.FMP_API_KEY;
  const hasAnth  = !!process.env.ANTHROPIC_API_KEY;
  console.log(`✅ Servidor en puerto ${PORT} | Anthropic: ${hasAnth ? '✓' : '✗ FALTA'} | FMP: ${hasFMP ? '✓' : '✗ sin clave (fallback Yahoo)'}`);
});
