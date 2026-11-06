const { db, transaction, normalizeName } = require('./db');
const { findSimilar } = require('../public/ingredient-key');

function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function getIngredient(id) {
  return db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
}

function usageOf(id) {
  return {
    recipes: db.prepare('SELECT COUNT(DISTINCT recipe_id) AS n FROM recipe_ingredients WHERE ingredient_id = ?').get(id).n,
    shopping: db.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE ingredient_id = ?').get(id).n
  };
}

function listForManagement() {
  return db.prepare(`
    SELECT i.id, i.name, i.category,
           (SELECT COUNT(DISTINCT recipe_id) FROM recipe_ingredients WHERE ingredient_id = i.id) AS recipe_count,
           (SELECT COUNT(*) FROM shopping_items WHERE ingredient_id = i.id) AS shopping_count
    FROM ingredients i
    ORDER BY i.name COLLATE NOCASE
  `).all();
}

function updateIngredient(id, changes) {
  const current = getIngredient(id);
  if (!current) throw httpError(404, 'Ingrediente no encontrado.');

  let name = current.name;
  if (changes.name !== undefined) {
    name = normalizeName(changes.name);
    if (!name) throw httpError(400, 'El nombre del ingrediente es obligatorio.');
    const others = db.prepare('SELECT * FROM ingredients WHERE id != ?').all(id);
    const clash = findSimilar(name, others);
    if (clash) {
      throw httpError(409, `Ya existe «${clash.name}». Usa Fusionar para unirlos.`, { similar: { id: clash.id, name: clash.name } });
    }
  }

  let category = current.category;
  if (changes.category !== undefined) category = normalizeName(changes.category) || null;

  db.prepare('UPDATE ingredients SET name = ?, category = ? WHERE id = ?').run(name, category, id);
  return getIngredient(id);
}

// Tras una fusión una receta puede tener el mismo ingrediente en dos líneas (Patata y Patatas).
// Se unen solo si es seguro: misma unidad y ambas con cantidad (se suman) o ambas sin cantidad ni notas distintas.
function consolidateRecipeLines(ingredientId) {
  const lines = db.prepare(
    'SELECT * FROM recipe_ingredients WHERE ingredient_id = ? ORDER BY recipe_id, sort_order, id'
  ).all(ingredientId);
  const kept = new Map();
  for (const line of lines) {
    const first = kept.get(line.recipe_id);
    if (!first) { kept.set(line.recipe_id, line); continue; }
    const sameUnit = (first.unit || '') === (line.unit || '');
    const bothQuantities = first.quantity !== null && line.quantity !== null;
    const noQuantities = first.quantity === null && line.quantity === null;
    const sameNotes = (first.notes || '') === (line.notes || '');
    if (sameUnit && bothQuantities && sameNotes) {
      first.quantity += line.quantity;
      db.prepare('UPDATE recipe_ingredients SET quantity = ? WHERE id = ?').run(first.quantity, first.id);
      db.prepare('DELETE FROM recipe_ingredients WHERE id = ?').run(line.id);
    } else if (noQuantities && sameNotes) {
      db.prepare('DELETE FROM recipe_ingredients WHERE id = ?').run(line.id);
    }
  }
}

// Une `fromId` en `intoId`: recetas y listas pasan a apuntar al segundo y el primero desaparece.
function mergeIngredients(fromId, intoId) {
  if (fromId === intoId) throw httpError(400, 'Elige otro ingrediente con el que fusionar.');
  const from = getIngredient(fromId);
  const into = getIngredient(intoId);
  if (!from || !into) throw httpError(404, 'Ingrediente no encontrado.');

  return transaction(() => {
    const recipes = db.prepare('UPDATE recipe_ingredients SET ingredient_id = ? WHERE ingredient_id = ?').run(intoId, fromId).changes;
    consolidateRecipeLines(intoId);

    let shopping = 0;
    const fromItems = db.prepare('SELECT * FROM shopping_items WHERE ingredient_id = ?').all(fromId);
    for (const item of fromItems) {
      const target = db.prepare(
        'SELECT * FROM shopping_items WHERE shopping_list_id = ? AND ingredient_id = ?'
      ).get(item.shopping_list_id, intoId);
      const sameUnit = target && (target.unit || '') === (item.unit || '');
      const bothHaveQuantity = target && target.quantity !== null && item.quantity !== null;

      if (!target || (bothHaveQuantity && !sameUnit)) {
        // Sin línea equivalente, o con unidades distintas (1 l y 500 ml): se conserva la línea sin perder nada
        db.prepare('UPDATE shopping_items SET ingredient_id = ? WHERE id = ?').run(intoId, item.id);
      } else {
        // Ya estaba en la misma lista y se pueden unir: queda una sola línea
        const quantity = target.quantity === null ? item.quantity
          : item.quantity === null ? target.quantity
            : target.quantity + item.quantity;
        const unit = target.quantity === null && item.quantity !== null ? item.unit : target.unit;
        const purchased = target.is_purchased && item.is_purchased ? 1 : 0;
        db.prepare(`
          UPDATE shopping_items SET quantity = ?, unit = ?, is_purchased = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(quantity, unit, purchased, target.id);
        db.prepare('DELETE FROM shopping_items WHERE id = ?').run(item.id);
      }
      shopping += 1;
    }

    if (!into.category && from.category) {
      db.prepare('UPDATE ingredients SET category = ? WHERE id = ?').run(from.category, intoId);
    }
    db.prepare('DELETE FROM ingredients WHERE id = ?').run(fromId);
    return { ingredient: getIngredient(intoId), recipes_updated: recipes, shopping_updated: shopping };
  });
}

function deleteIngredient(id) {
  if (!getIngredient(id)) throw httpError(404, 'Ingrediente no encontrado.');
  const usage = usageOf(id);
  if (usage.recipes || usage.shopping) {
    const parts = [];
    if (usage.recipes) parts.push(`${usage.recipes} ${usage.recipes === 1 ? 'receta' : 'recetas'}`);
    if (usage.shopping) parts.push(`${usage.shopping} ${usage.shopping === 1 ? 'lista' : 'listas'}`);
    throw httpError(409, `No se puede eliminar: se usa en ${parts.join(' y ')}. Fusiónalo con otro ingrediente.`);
  }
  db.prepare('DELETE FROM ingredients WHERE id = ?').run(id);
}

module.exports = { listForManagement, updateIngredient, mergeIngredients, deleteIngredient };
