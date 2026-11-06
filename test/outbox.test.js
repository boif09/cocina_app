const assert = require('assert');
const { applyOps, createOutbox, newTempId, isTempId } = require('../public/outbox');
const { ingredientKey } = require('../public/ingredient-key');

const memoryStorage = () => {
  const data = new Map();
  return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, value), data };
};

const base = () => ({
  id: 1,
  items: [
    { id: 10, ingredient_name: 'Tomate', category: 'Verduras y hortalizas', quantity: 2, unit: 'kg', is_purchased: 0, sort_order: 0 },
    { id: 11, ingredient_name: 'Leche', category: 'Lácteos y huevos', quantity: null, unit: null, is_purchased: 1, sort_order: 1 }
  ]
});

// --- applyOps
{
  const list = base();
  const view = applyOps(list, [
    { type: 'toggle', listId: 1, itemId: 10, purchased: true },
    { type: 'edit', listId: 1, itemId: 11, quantity: 3, unit: ' l ' },
    { type: 'add', listId: 1, tempId: 'tmp-a', name: 'Pan', quantity: null, unit: '' },
    { type: 'add', listId: 1, tempId: 'tmp-b', name: 'tomates', quantity: 5, unit: '' } // mismo ingrediente que Tomate
  ]);
  assert.strictEqual(list.items[0].is_purchased, 0, 'no modifica la original');
  assert.strictEqual(view.items.find(i => i.id === 10).is_purchased, 0, 'añadir un ingrediente existente lo deja pendiente');
  assert.strictEqual(view.items.find(i => i.id === 10).quantity, 5);
  assert.strictEqual(view.items.find(i => i.id === 11).unit, 'l');
  assert.strictEqual(view.items.find(i => i.id === 'tmp-a').pending, true);
  assert.strictEqual(view.items.length, 3, 'tomates no duplica Tomate');
  const cleared = applyOps(base(), [{ type: 'clear', listId: 1 }, { type: 'delete', listId: 1, itemId: 10 }]);
  assert.strictEqual(cleared.items.length, 0);
  // operaciones de otra lista se ignoran
  assert.strictEqual(applyOps(base(), [{ type: 'clear', listId: 99 }]).items.length, 2);
}

// --- Cola: orden, persistencia y sustitución de ids temporales
(async () => {
  const storage = memoryStorage();
  const sent = [];
  const send = async op => { sent.push({ ...op }); return op.type === 'add' ? { id: 500 } : null; };

  const outbox = createOutbox({ storage });
  const tmp = newTempId();
  assert(isTempId(tmp));
  outbox.enqueue({ type: 'add', listId: 1, tempId: tmp, name: 'Pan' });
  outbox.enqueue({ type: 'toggle', listId: 1, itemId: tmp, purchased: true });
  assert.strictEqual(createOutbox({ storage }).count(), 2, 'la cola sobrevive a recargar la página');

  const result = await outbox.flush(send);
  assert.strictEqual(result.offline, false);
  assert.strictEqual(outbox.count(), 0);
  assert.strictEqual(sent[1].itemId, 500, 'el id temporal se sustituye por el real');

  // Sin conexión: se detiene y conserva todo
  const offlineOutbox = createOutbox({ storage: memoryStorage() });
  offlineOutbox.enqueue({ type: 'toggle', listId: 1, itemId: 10, purchased: true });
  offlineOutbox.enqueue({ type: 'toggle', listId: 1, itemId: 11, purchased: false });
  let calls = 0;
  const down = async () => { calls += 1; const e = new Error('offline'); e.offline = true; throw e; };
  const r2 = await offlineOutbox.flush(down);
  assert.strictEqual(r2.offline, true);
  assert.strictEqual(offlineOutbox.count(), 2);
  assert.strictEqual(calls, 1, 'no insiste con el resto si no hay red');

  // Rechazo definitivo (400): se descarta esa operación y sigue con la siguiente
  const rej = createOutbox({ storage: memoryStorage() });
  rej.enqueue({ type: 'add', listId: 1, tempId: 'tmp-x', name: '' });
  rej.enqueue({ type: 'toggle', listId: 1, itemId: 'tmp-x', purchased: true });
  rej.enqueue({ type: 'toggle', listId: 1, itemId: 10, purchased: true });
  const okSent = [];
  const r3 = await rej.flush(async op => {
    if (op.type === 'add') { const e = new Error('Nombre obligatorio'); e.status = 400; throw e; }
    okSent.push(op); return null;
  });
  assert.strictEqual(r3.dropped.length, 2, 'se descarta el añadir y lo que dependía de él');
  assert.strictEqual(okSent.length, 1);
  assert.strictEqual(rej.count(), 0);

  // 5xx y sesión caducada se reintentan; 404 lo decide quien envía
  const retry = createOutbox({ storage: memoryStorage() });
  retry.enqueue({ type: 'clear', listId: 1 });
  for (const status of [500, 502, 503, 401, 403]) {
    const r = await retry.flush(async () => { const e = new Error('x'); e.status = status; throw e; });
    assert.strictEqual(r.offline, true, `estado ${status} debe reintentarse`);
  }
  assert.strictEqual(retry.count(), 1);

  // Una sola sincronización a la vez
  const once = createOutbox({ storage: memoryStorage() });
  once.enqueue({ type: 'clear', listId: 1 });
  let concurrent = 0; let maxConcurrent = 0;
  const slow = async () => { concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent); await new Promise(r => setTimeout(r, 20)); concurrent -= 1; return null; };
  await Promise.all([once.flush(slow), once.flush(slow), once.flush(slow)]);
  assert.strictEqual(maxConcurrent, 1);

  // Almacenamiento roto: no explota
  const broken = createOutbox({ storage: { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('lleno'); } } });
  assert.strictEqual(broken.enqueue({ type: 'clear', listId: 1 }), false, 'avisa de que no se pudo guardar');
  assert.strictEqual(broken.count(), 1, 'pero el cambio sigue en memoria');
  assert.strictEqual(createOutbox({ storage: memoryStorage() }).enqueue({ type: 'clear', listId: 1 }), true);

  // --- Propiedad: con cortes y respuestas perdidas al azar, el servidor acaba igual que lo que se veía
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const names = ['Tomate', 'tomates', 'Leche', 'Pan', 'Pan integral', 'Huevos', 'Huevo', 'Aguacate'];

  for (let round = 0; round < 300; round += 1) {
    const server = base();
    let nextId = 1000;
    const serverOp = op => {
      const find = id => server.items.find(i => String(i.id) === String(id));
      if (op.type === 'add') {
        const key = ingredientKey(op.name);
        const existing = server.items.find(i => ingredientKey(i.ingredient_name) === key);
        const unit = (op.unit || '').trim() || null;
        if (existing) {
          existing.is_purchased = 0;
          if (op.quantity !== null && op.quantity !== undefined) existing.quantity = op.quantity;
          if (unit) existing.unit = unit;
          return { id: existing.id };
        }
        nextId += 1;
        server.items.push({ id: nextId, ingredient_name: op.name, quantity: op.quantity ?? null, unit, is_purchased: 0 });
        return { id: nextId };
      }
      const item = find(op.itemId);
      if (op.type === 'toggle') { if (!item) { const e = new Error('404'); e.status = 404; throw e; } item.is_purchased = op.purchased ? 1 : 0; }
      if (op.type === 'edit') { if (!item) { const e = new Error('404'); e.status = 404; throw e; } item.quantity = op.quantity ?? null; item.unit = (op.unit || '').trim() || null; }
      if (op.type === 'delete') { if (!item) { const e = new Error('404'); e.status = 404; throw e; } server.items = server.items.filter(i => i !== item); }
      if (op.type === 'clear') server.items = server.items.filter(i => !i.is_purchased);
      return null;
    };
    const flaky = async op => {
      if (rand() < 0.25) { const e = new Error('sin red'); e.offline = true; throw e; } // antes de llegar
      let result;
      try { result = serverOp(op); } catch (e) { if (e.status === 404 && ['toggle', 'edit', 'delete'].includes(op.type)) return null; throw e; }
      if (rand() < 0.25) { const e = new Error('respuesta perdida'); e.offline = true; throw e; } // llegó, pero no se enteró
      return result;
    };

    const ob = createOutbox({ storage: memoryStorage() });
    const snapshot = JSON.parse(JSON.stringify(server));
    const total = 3 + Math.floor(rand() * 8);
    for (let i = 0; i < total; i += 1) {
      const view = applyOps(snapshot, ob.pending());
      const pick = rand();
      const items = view.items;
      if (pick < 0.35 || !items.length) {
        ob.enqueue({ type: 'add', listId: 1, tempId: newTempId(), name: names[Math.floor(rand() * names.length)], quantity: rand() < 0.5 ? null : 1 + Math.floor(rand() * 5), unit: rand() < 0.5 ? '' : 'kg' });
      } else if (pick < 0.6) {
        const it = items[Math.floor(rand() * items.length)];
        ob.enqueue({ type: 'toggle', listId: 1, itemId: it.id, purchased: !it.is_purchased });
      } else if (pick < 0.75) {
        const it = items[Math.floor(rand() * items.length)];
        ob.enqueue({ type: 'edit', listId: 1, itemId: it.id, quantity: Math.floor(rand() * 4) || null, unit: rand() < 0.5 ? '' : 'l' });
      } else if (pick < 0.9) {
        const it = items[Math.floor(rand() * items.length)];
        ob.enqueue({ type: 'delete', listId: 1, itemId: it.id });
      } else {
        ob.enqueue({ type: 'clear', listId: 1 });
      }
    }
    const expected = applyOps(snapshot, ob.pending());

    for (let attempt = 0; attempt < 200 && ob.count(); attempt += 1) await ob.flush(flaky);
    assert.strictEqual(ob.count(), 0, `ronda ${round}: la cola debería vaciarse`);

    const normalize = list => list.items.map(i => `${ingredientKey(i.ingredient_name)}|${i.is_purchased ? 1 : 0}|${i.quantity ?? ''}|${i.unit ?? ''}`).sort();
    assert.deepStrictEqual(normalize(server), normalize(expected), `ronda ${round}: el servidor no coincide con lo que se veía`);
  }

  console.log('Prueba de la cola sin conexión completada correctamente.');
})().catch(error => { console.error(error); process.exit(1); });
