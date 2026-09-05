import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export const fixture = Array.from({length: 30}, (_, i) => ({id: `W-${i+1}`, title: i === 0 ? 'Read "notes", then\nship' : `Work item ${i+1}`, status: i < 23 ? 'open' : 'done'}));
export function readItems(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fixture); throw error; }
}
export function writeItems(path, items) {
  mkdirSync(dirname(path), {recursive:true});
  writeFileSync(`${path}.tmp`, JSON.stringify(items));
  renameSync(`${path}.tmp`, path);
}
export function matchingItems(items, status = '') { return items.filter(item => !status || item.status === status); }
export function pageOf(items, page = 1) { return items.slice((page-1)*10, page*10); }
