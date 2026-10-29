// Test servers for the DoH client (native/android/KrDoh.java): a resolver (RFC 8484, POST /dns-query) that
// answers every A question with 127.0.0.1, and a site on HTTPS that tells back the name the TLS handshake gave
// (SNI) and the Host header. Both with a certificate made for the test (CERT, KEY). Prints the two ports.
const https = require('https'); const fs = require('fs');
const opts = { cert: fs.readFileSync(process.env.CERT), key: fs.readFileSync(process.env.KEY) };
const doh = https.createServer(opts, (req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const q = Buffer.concat(chunks); let p = 12; while (q[p]) p += q[p] + 1; p += 1; const type = q.readUInt16BE(p);
    const head = Buffer.from(q.subarray(0, 12)); head[2] = 0x81; head[3] = 0x80; head.writeUInt16BE(type === 1 ? 1 : 0, 6);
    const ans = type === 1 ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 120, 0, 4, 127, 0, 0, 1]) : Buffer.alloc(0);
    res.writeHead(200, { 'Content-Type': 'application/dns-message' }); res.end(Buffer.concat([head, q.subarray(12, p + 4), ans]));
  });
});
const site = https.createServer(opts, (req, res) => {
  if (req.url === '/hop') { res.writeHead(302, { Location: '/end' }); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`sni=${req.socket.servername} host=${req.headers.host} path=${req.url}`);
});
doh.listen(0, () => site.listen(0, () => console.log(doh.address().port, site.address().port)));
