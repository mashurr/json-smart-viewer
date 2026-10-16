import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonIndex } from './index/query';
import { scan } from './index/scanner';
import { findTables, tableColumns, tableRows } from './table';

function index(value: unknown): JsonIndex {
    const text = JSON.stringify(value);
    const data = scan(text);
    if ('message' in data) { throw new Error(data.message); }
    return new JsonIndex(text, data, 1);
}

test('discovers nested single-row arrays alongside larger arrays', async () => {
    const ix = index({
        multiple: [{ name: 'first' }, { name: 'second' }],
        single: [{ name: 'only' }],
        empty: [],
        generatedAt: '2026-01-01',
    });
    const tables = await findTables(ix, () => true);
    assert.ok(tables);
    assert.deepEqual(tables.map(({ path, pointer, rows, shape }) => ({ path, pointer, rows, shape })), [
        { path: 'multiple', pointer: '/multiple', rows: 2, shape: 'rows' },
        { path: 'single', pointer: '/single', rows: 1, shape: 'rows' },
    ]);

    const single = tables[1];
    const { columns } = tableColumns(ix, single.id, single.shape);
    assert.deepEqual(columns, [{ label: 'name', key: 'name' }]);
    const rows = tableRows(ix, single.id, single.shape, columns, undefined, 0, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cells[0]?.text, 'only');
});

test('discovers nested single-entry maps of objects', async () => {
    const tables = await findTables(index({ records: { only: { name: 'one' } } }), () => true);
    assert.ok(tables);
    assert.deepEqual(tables.map(({ path, rows, shape }) => ({ path, rows, shape })), [
        { path: '$', rows: 1, shape: 'map' },
        { path: 'records', rows: 1, shape: 'map' },
    ]);
});

test('keeps single-row root arrays and maps discoverable', async () => {
    for (const value of [[{ name: 'one' }], { only: { name: 'one' } }]) {
        const tables = await findTables(index(value), () => true);
        assert.ok(tables);
        assert.equal(tables.length, 1);
        assert.equal(tables[0].path, '$');
        assert.equal(tables[0].rows, 1);
    }
});

test('excludes empty containers and containers without object rows', async () => {
    for (const value of [[], {}, [1], { name: 'one' }, { empty: [], scalar: [1], object: {} }]) {
        assert.deepEqual(await findTables(index(value), () => true), []);
    }
});

test('preserves mixed arrays and document-order ties when sorting by size', async () => {
    const tables = await findTables(index({
        first: [{ name: 'one' }],
        mixed: [{ name: 'two' }, 3],
        last: [{ name: 'four' }],
    }), () => true);
    assert.ok(tables);
    assert.deepEqual(tables.map(({ path, shape }) => ({ path, shape })), [
        { path: 'mixed', shape: 'mixed' },
        { path: 'first', shape: 'rows' },
        { path: 'last', shape: 'rows' },
    ]);
});

test('retains the 200-table discovery limit with single-row arrays', async () => {
    const value = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`items${i}`, [{ name: 'one' }]]));
    const tables = await findTables(index(value), () => true);
    assert.ok(tables);
    assert.equal(tables.length, 200);
    assert.equal(tables[0].path, 'items0');
    assert.equal(tables[199].path, 'items199');
});
