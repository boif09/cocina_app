const assert = require('assert');
const { ingredientKey, findSimilar } = require('../public/ingredient-key');

// Mismas claves: plurales, tildes y mayúsculas
const same = [
  ['Tomates', 'tomate'],
  ['Patatas', 'Patata'],
  ['Limones', 'Limón'],
  ['Brocoli', 'Brócoli'],
  ['Atun', 'Atún'],
  ['Ketchup', 'Kétchup'],
  ['Salmon', 'Salmón'],
  ['Tomates cherry', 'Tomate cherry'],
  ['Champiñones', 'champiñón'],
  ['  Judías   verdes ', 'judia verde'],
  ['Arroces', 'Arroz'],
  ['Huevo', 'Huevos'],
  ['Nueces', 'Nuez'],
  ['Jamones', 'Jamón'],
  ['Aceitunas', 'Aceituna'],
  ['Legumbres', 'Legumbre'],
  ['Pimientos verdes', 'Pimiento verde']
];
for (const [a, b] of same) {
  assert.strictEqual(ingredientKey(a), ingredientKey(b), `"${a}" y "${b}" deberían coincidir`);
}

// Claves distintas: productos que no son lo mismo
const different = [
  ['Mozzarella', 'Mozzarella rallada'],
  ['Levadura', 'Levadura fresca'],
  ['Espinacas', 'Espinacas congeladas'],
  ['Pan', 'Pan rallado'],
  ['Queso', 'Queso feta'],
  ['Harina', 'Harina de maíz'],
  ['Gas', 'Gato']
];
for (const [a, b] of different) {
  assert.notStrictEqual(ingredientKey(a), ingredientKey(b), `"${a}" y "${b}" NO deberían coincidir`);
}

assert.strictEqual(ingredientKey(''), '');
assert.strictEqual(ingredientKey(null), '');

const catalog = [{ id: 1, name: 'Tomate' }, { id: 2, name: 'Tomate cherry' }, { id: 3, name: 'Patata' }];
assert.strictEqual(findSimilar('tomates', catalog).id, 1);
assert.strictEqual(findSimilar('Tomates cherry', catalog).id, 2);
assert.strictEqual(findSimilar('PATATAS', catalog).id, 3);
assert.strictEqual(findSimilar('Pera', catalog), null);
assert.strictEqual(findSimilar('', catalog), null);
// Un nombre idéntico gana sobre uno solo "parecido"
assert.strictEqual(findSimilar('Tomates', [{ id: 9, name: 'Tomate' }, { id: 10, name: 'Tomates' }]).id, 10);

console.log('Prueba de claves de ingredientes completada correctamente.');
