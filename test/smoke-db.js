const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tempDb = path.join(__dirname, 'smoke-test.db');
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.unlinkSync(`${tempDb}${suffix}`); } catch (_error) {}
}
process.env.DATABASE_PATH = tempDb;

const {
  db,
  transaction,
  findOrCreateIngredient,
  findOrCreateDish
} = require('../src/db');

const ingredientCount = db.prepare('SELECT COUNT(*) AS total FROM ingredients').get().total;
assert(ingredientCount >= 100, 'No se han insertado los ingredientes iniciales.');

const activeList = db.prepare('SELECT * FROM shopping_lists WHERE is_active = 1').get();
assert(activeList, 'No se ha creado la lista de compra inicial.');

const tomato1 = findOrCreateIngredient('Tomate');
const tomato2 = findOrCreateIngredient('  tomate  ');
assert.strictEqual(tomato1.id, tomato2.id, 'Los ingredientes se están duplicando por mayúsculas o espacios.');

const dish1 = findOrCreateDish('Ensaladilla rusa');
const dish2 = findOrCreateDish('ensaladilla rusa');
assert.strictEqual(dish1.id, dish2.id, 'Los platos se están duplicando por mayúsculas.');

const recipeId = transaction(() => {
  const result = db.prepare('INSERT INTO recipes (title) VALUES (?)').run('Receta de prueba');
  const id = Number(result.lastInsertRowid);
  db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, tomato1.id, 2, 'unidades', 0);
  db.prepare(`
    INSERT INTO recipe_steps (recipe_id, step_number, instruction)
    VALUES (?, 1, ?)
  `).run(id, 'Cortar el tomate.');
  findOrCreateDish('Receta de prueba', id);
  return id;
});

assert(db.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId), 'No se ha guardado la receta.');
assert(db.prepare('SELECT * FROM dishes WHERE recipe_id = ?').get(recipeId), 'No se ha enlazado la receta con su plato.');

db.close();
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.unlinkSync(`${tempDb}${suffix}`); } catch (_error) {}
}

console.log('Smoke test SQLite completado correctamente.');
