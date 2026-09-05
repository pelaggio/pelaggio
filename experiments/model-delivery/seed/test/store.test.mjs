import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, matchingItems, pageOf } from '../src/store.mjs';
test('the fixture has 23 open items over three pages',()=>{const items=matchingItems(fixture,'open');assert.equal(items.length,23);assert.equal(pageOf(items,1).length,10);assert.equal(pageOf(items,3).length,3)});
