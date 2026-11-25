#!/usr/bin/env node
// Servidor estático local para preview em http://localhost:PORT/dash-medclinic/ (mesmo base path do Pages).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { dir: { type: 'string', default: 'dist' }, port: { type: 'string', default: '8787' } } });
const ROOT = resolve(values.dir);
const BASE = '/dash-medclinic/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/dash-medclinic') {
      res.writeHead(302, { Location: BASE });
      return res.end();
    }
    if (!url.pathname.startsWith(BASE)) {
      res.writeHead(404);
      return res.end('not found');
    }
    let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
    const file = normalize(join(ROOT, rel));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403);
      return res.end();
    }
    const st = await stat(file).catch(() => null);
    const target = st?.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(Number(values.port), () => console.log(`preview: http://localhost:${values.port}${BASE} (servindo ${ROOT})`));
