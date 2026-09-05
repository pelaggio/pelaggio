import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchingItems, pageOf, readItems } from './store.mjs';
const store = process.env.DEMO_STORE || resolve('data/items.json');
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/items') {
    const items = matchingItems(readItems(store), url.searchParams.get('status') || '');
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({items: pageOf(items, page), total: items.length, page, pageSize:10}));
  } else if (url.pathname === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(readFileSync(new URL('../public/index.html', import.meta.url)));
  } else { response.writeHead(404).end('Not found'); }
});
server.listen(Number(process.env.PORT || 4325), '127.0.0.1', () => console.log(`listening ${server.address().port}`));
