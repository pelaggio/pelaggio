import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readItems, writeItems } from './store.mjs';
const source = process.argv[2];
if (!source) throw new Error('Usage: node src/import.mjs <items.json>');
const path = process.env.DEMO_STORE || resolve('data/items.json');
const rows = JSON.parse(readFileSync(source, 'utf8'));
for (const row of rows) {
  const items = readItems(path);
  items.push(row);
  writeItems(path, items);
  console.log(`committed ${row.id}`);
  await new Promise(done => setTimeout(done, Number(process.env.DEMO_IMPORT_DELAY_MS || 0)));
}
