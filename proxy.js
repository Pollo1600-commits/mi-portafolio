const http = require('http');
const https = require('https');

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

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
        'x-api-key': req.headers['x-api-key'],
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        'Content-Length': bodyData.length
      }
    };

    console.log('Enviando a Anthropic...');
console.log('API Key:', req.headers['x-api-key']?.substring(0,15) + '...');
    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('Error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });

    proxyReq.write(bodyData);
    proxyReq.end();
  });
});

server.listen(3000, () => {
  console.log('✅ Proxy corriendo en http://127.0.0.1:3000');
});
