// Prueba del gestor de ingredientes sobre una base de datos temporal.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tempDb = path.join(__dirname, 'admin-test.db');
const clean = () => { for (const suffix of ['', '-shm', '-wal']) { try { fs.unlinkSync(`${tempDb}${suffix}`); } catch (_error) {} } };
clean();
process.env.DATABASE_PATH = tempDb;

const { db, findOrCreateIngredient } = require('../src/db');
const admin = require('../src/ingredient-admin');

const throwsStatus = (fn, status) => {
  try { fn(); } catch (error) { assert.strictEqual(error.status, status, `estado esperado ${status}, recibido ${error.status}: ${error.message}`); return error; }
  assert.fail(`debería fallar con ${status}`);
};

// --- Anti-duplicados en findOrCreateIngredient
const tomate = findOrCreateIngredient('Tomate');
assert.strictEqual(findOrCreateIngredient('tomates').id, tomate.id, 'Tomates debe reutilizar Tomate');
assert.strictEqual(findOrCreateIngredient('Tómate').id, tomate.id);
const nuevo = findOrCreateIngredient('Ingrediente rarísimo', 'Otros');
assert.notStrictEqual(nuevo.id, tomate.id);

// --- Renombrar
const a = findOrCreateIngredient('Cosa uno');
const b = findOrCreateIngredient('Cosa dos');
const renamed = admin.updateIngredient(a.id, { name: 'Cosa 1', category: 'Despensa' });
assert.strictEqual(renamed.name, 'Cosa 1');
assert.strictEqual(renamed.category, 'Despensa');
// cambiar solo mayúsculas/tildes de uno mismo está permitido
assert.strictEqual(admin.updateIngredient(a.id, { name: 'cosa 1' }).name, 'cosa 1');
// chocar con otro (aunque sea plural/tilde) no
const clash = throwsStatus(() => admin.updateIngredient(b.id, { name: 'Tomates' }), 409);
assert(clash.message.includes('Tomate'));
throwsStatus(() => admin.updateIngredient(b.id, { name: '   ' }), 400);
throwsStatus(() => admin.updateIngredient(999999, { name: 'x' }), 404);
assert.strictEqual(admin.updateIngredient(b.id, { category: '' }).category, null);

// --- Datos de prueba: recetas y lista
const listId = db.prepare("SELECT id FROM shopping_lists WHERE is_active = 1").get().id;
const recipeId = Number(db.prepare("INSERT INTO recipes (title) VALUES ('R1')").run().lastInsertRowid);
const insRi = db.prepare('INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit, sort_order) VALUES (?, ?, ?, ?, 0)');
const dup = findOrCreateIngredient('Duplicado raro');       // a eliminar
const keep = findOrCreateIngredient('Destino final');       // se queda
insRi.run(recipeId, dup.id, 2, 'uds');
const insSi = db.prepare('INSERT INTO shopping_items (shopping_list_id, ingredient_id, quantity, unit, is_purchased) VALUES (?, ?, ?, ?, ?)');
insSi.run(listId, dup.id, 2, 'kg', 0);
insSi.run(listId, keep.id, 3, 'kg', 1);

// --- Eliminar en uso: prohibido
const used = throwsStatus(() => admin.deleteIngredient(dup.id), 409);
assert(used.message.includes('1 receta'));

// --- Fusionar: receta repuntada, lista combinada (suma, pendiente si alguna lo estaba) y origen borrado
throwsStatus(() => admin.mergeIngredients(dup.id, dup.id), 400);
throwsStatus(() => admin.mergeIngredients(dup.id, 999999), 404);
const result = admin.mergeIngredients(dup.id, keep.id);
assert.strictEqual(result.recipes_updated, 1);
assert.strictEqual(result.shopping_updated, 1);
assert.strictEqual(db.prepare('SELECT ingredient_id FROM recipe_ingredients WHERE recipe_id = ?').get(recipeId).ingredient_id, keep.id);
const items = db.prepare('SELECT * FROM shopping_items WHERE shopping_list_id = ?').all(listId);
assert.strictEqual(items.length, 1, 'una sola línea tras fusionar');
assert.strictEqual(items[0].quantity, 5);
assert.strictEqual(items[0].is_purchased, 0, 'si alguna estaba pendiente, queda pendiente');
assert.strictEqual(db.prepare('SELECT id FROM ingredients WHERE id = ?').get(dup.id), undefined);

// unidades distintas: NO se pierde nada, quedan las dos líneas apuntando al destino
const x = findOrCreateIngredient('Equis'); const y = findOrCreateIngredient('Ye');
const list2 = Number(db.prepare("INSERT INTO shopping_lists (name, is_active) VALUES ('otra', 0)").run().lastInsertRowid);
insSi.run(list2, x.id, 1, 'l', 0); insSi.run(list2, y.id, 500, 'ml', 0);
admin.mergeIngredients(x.id, y.id);
const kept = db.prepare('SELECT quantity, unit, ingredient_id FROM shopping_items WHERE shopping_list_id = ? ORDER BY quantity').all(list2);
assert.deepStrictEqual(kept.map((r) => `${r.quantity} ${r.unit}`), ['1 l', '500 ml'], 'no se pierde el litro');
assert(kept.every((r) => r.ingredient_id === y.id));

// misma unidad: se suman; una con cantidad y otra sin: se queda la cantidad
const p = findOrCreateIngredient('Pe'); const q = findOrCreateIngredient('Cu');
const list3 = Number(db.prepare("INSERT INTO shopping_lists (name, is_active) VALUES ('tercera', 0)").run().lastInsertRowid);
insSi.run(list3, p.id, null, null, 0); insSi.run(list3, q.id, 2, 'kg', 0);
admin.mergeIngredients(p.id, q.id);
const merged3 = db.prepare('SELECT quantity, unit FROM shopping_items WHERE shopping_list_id = ?').all(list3);
assert.strictEqual(merged3.length, 1);
assert.strictEqual(merged3[0].quantity, 2);

// --- Receta con los dos ingredientes: se consolidan solo cuando es seguro
const rid = Number(db.prepare("INSERT INTO recipes (title) VALUES ('R2')").run().lastInsertRowid);
const r1 = findOrCreateIngredient('Pata uno'); const r2 = findOrCreateIngredient('Pata dos'); const r3 = findOrCreateIngredient('Pata tres');
const insRi2 = db.prepare('INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
insRi2.run(rid, r1.id, 2, 'uds', null, 0);
insRi2.run(rid, r2.id, 3, 'uds', null, 1);
admin.mergeIngredients(r2.id, r1.id);
const lines = db.prepare('SELECT quantity, unit FROM recipe_ingredients WHERE recipe_id = ? AND ingredient_id = ?').all(rid, r1.id);
assert.strictEqual(lines.length, 1, 'misma unidad: una sola línea');
assert.strictEqual(lines[0].quantity, 5);
insRi2.run(rid, r3.id, 100, 'g', null, 2);
admin.mergeIngredients(r3.id, r1.id);
assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM recipe_ingredients WHERE recipe_id = ? AND ingredient_id = ?').get(rid, r1.id).n, 2, 'unidades distintas: se conservan las dos líneas');

// --- Eliminar sin uso
const free = findOrCreateIngredient('Sin uso alguno');
admin.deleteIngredient(free.id);
assert.strictEqual(db.prepare('SELECT id FROM ingredients WHERE id = ?').get(free.id), undefined);
throwsStatus(() => admin.deleteIngredient(free.id), 404);

// --- Listado con uso
const listing = admin.listForManagement();
const k = listing.find((row) => row.id === keep.id);
assert.strictEqual(k.recipe_count, 1);
assert.strictEqual(k.shopping_count, 1);
assert.strictEqual(db.prepare('PRAGMA foreign_key_check').all().length, 0);

db.close();
clean();
console.log('Prueba del gestor de ingredientes completada correctamente.');
