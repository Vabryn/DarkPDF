const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
exports.start = async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer((req, res) => {
    let name;
    try { name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); return res.end(); }
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep) || name.includes('/.') || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end();
    }
    const headersFile = path.join(root, '_headers');
    if (fs.existsSync(headersFile)) for (const line of fs.readFileSync(headersFile, 'utf8').split('\n')) {
      const index = line.indexOf(':');
      if (line.startsWith('  ') && index > 0) res.setHeader(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
    const types = {'.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.svg':'image/svg+xml', '.png':'image/png', '.json':'application/json'};
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: 'http://127.0.0.1:' + server.address().port + '/', close: () => server.close()};
};
