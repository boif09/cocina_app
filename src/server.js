const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { port, basePath, rootDir, databasePath } = require('./config');
const {
  db,
  transaction,
  normalizeName,
  findOrCreateIngredient,
  findOrCreateDish
} = require('./db');

const app = express();
const api = `${basePath}/api`;
const publicDir = path.join(rootDir, 'public');

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

function parseOptionalNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function assertPositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    const error = new Error(`${fieldName} no es válido.`);
    error.status = 400;
    throw error;
  }
  return number;
}

function validateWeekStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    const error = new Error('La fecha de inicio de semana no es válida.');
    error.status = 400;
    throw error;
  }
  return value;
}

function getRecipe(recipeId) {
  const recipe = db.prepare(`
    SELECT r.*,
           (SELECT COUNT(*) FROM dishes d WHERE d.recipe_id = r.id) AS linked_dishes
    FROM recipes r
    WHERE r.id = ?
  `).get(recipeId);

  if (!recipe) return null;

  recipe.ingredients = db.prepare(`
    SELECT ri.id, ri.ingredient_id, i.name, i.category,
           ri.quantity, ri.unit, ri.notes, ri.sort_order
    FROM recipe_ingredients ri
    JOIN ingredients i ON i.id = ri.ingredient_id
    WHERE ri.recipe_id = ?
    ORDER BY ri.sort_order, ri.id
  `).all(recipeId);

  recipe.steps = db.prepare(`
    SELECT id, step_number, instruction
    FROM recipe_steps
    WHERE recipe_id = ?
    ORDER BY step_number
  `).all(recipeId);

  return recipe;
}

function saveRecipeRelations(recipeId, ingredients, steps) {
  db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipeId);
  db.prepare('DELETE FROM recipe_steps WHERE recipe_id = ?').run(recipeId);

  const insertIngredientRelation = db.prepare(`
    INSERT INTO recipe_ingredients
      (recipe_id, ingredient_id, quantity, unit, notes, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  (Array.isArray(ingredients) ? ingredients : []).forEach((item, index) => {
    const ingredientName = normalizeName(item.name);
    if (!ingredientName) return;
    const ingredient = item.ingredient_id
      ? db.prepare('SELECT * FROM ingredients WHERE id = ?').get(Number(item.ingredient_id))
      : findOrCreateIngredient(ingredientName);
    const resolvedIngredient = ingredient || findOrCreateIngredient(ingredientName);

    insertIngredientRelation.run(
      recipeId,
      resolvedIngredient.id,
      parseOptionalNumber(item.quantity),
      normalizeName(item.unit) || null,
      normalizeName(item.notes) || null,
      index
    );
  });

  const insertStep = db.prepare(`
    INSERT INTO recipe_steps (recipe_id, step_number, instruction)
    VALUES (?, ?, ?)
  `);

  (Array.isArray(steps) ? steps : []).forEach((step, index) => {
    const instruction = normalizeName(typeof step === 'string' ? step : step.instruction);
    if (instruction) insertStep.run(recipeId, index + 1, instruction);
  });
}

app.get(`${api}/health`, (_req, res) => {
  res.json({ ok: true, database: databasePath, basePath });
});

// Ingredientes
app.get(`${api}/ingredients`, (req, res) => {
  const query = normalizeName(req.query.q);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const ingredients = query
    ? db.prepare(`
        SELECT * FROM ingredients
        WHERE name LIKE ? COLLATE NOCASE
        ORDER BY CASE WHEN name LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END, name
        LIMIT ?
      `).all(`%${query}%`, `${query}%`, limit)
    : db.prepare('SELECT * FROM ingredients ORDER BY category, name LIMIT ?').all(limit);
  res.json(ingredients);
});

app.post(`${api}/ingredients`, (req, res) => {
  const ingredient = findOrCreateIngredient(req.body.name, req.body.category);
  res.status(201).json(ingredient);
});

// Recetas
app.get(`${api}/recipes`, (req, res) => {
  const query = normalizeName(req.query.q);
  const params = [];
  let where = '';
  if (query) {
    where = `WHERE r.title LIKE ? COLLATE NOCASE
      OR r.description LIKE ? COLLATE NOCASE
      OR EXISTS (
        SELECT 1
        FROM recipe_ingredients ri
        JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE ri.recipe_id = r.id AND i.name LIKE ? COLLATE NOCASE
      )`;
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }

  const recipes = db.prepare(`
    SELECT r.*,
           COUNT(DISTINCT ri.id) AS ingredient_count,
           COUNT(DISTINCT rs.id) AS step_count
    FROM recipes r
    LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
    LEFT JOIN recipe_steps rs ON rs.recipe_id = r.id
    ${where}
    GROUP BY r.id
    ORDER BY r.updated_at DESC, r.title
  `).all(...params);
  res.json(recipes);
});

app.get(`${api}/recipes/:id`, (req, res) => {
  const recipe = getRecipe(assertPositiveInteger(req.params.id, 'La receta'));
  if (!recipe) return res.status(404).json({ error: 'Receta no encontrada.' });
  res.json(recipe);
});

app.post(`${api}/recipes`, (req, res) => {
  const title = normalizeName(req.body.title);
  if (!title) return res.status(400).json({ error: 'El título de la receta es obligatorio.' });

  const recipeId = transaction(() => {
    const result = db.prepare(`
      INSERT INTO recipes
        (title, description, servings, prep_minutes, cook_minutes)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      title,
      normalizeName(req.body.description) || null,
      parseOptionalNumber(req.body.servings),
      parseOptionalNumber(req.body.prep_minutes),
      parseOptionalNumber(req.body.cook_minutes)
    );
    const id = Number(result.lastInsertRowid);
    saveRecipeRelations(id, req.body.ingredients, req.body.steps);
    findOrCreateDish(title, id);
    return id;
  });

  res.status(201).json(getRecipe(recipeId));
});

app.put(`${api}/recipes/:id`, (req, res) => {
  const recipeId = assertPositiveInteger(req.params.id, 'La receta');
  const title = normalizeName(req.body.title);
  if (!title) return res.status(400).json({ error: 'El título de la receta es obligatorio.' });
  if (!db.prepare('SELECT id FROM recipes WHERE id = ?').get(recipeId)) {
    return res.status(404).json({ error: 'Receta no encontrada.' });
  }

  transaction(() => {
    db.prepare(`
      UPDATE recipes
      SET title = ?, description = ?, servings = ?, prep_minutes = ?, cook_minutes = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title,
      normalizeName(req.body.description) || null,
      parseOptionalNumber(req.body.servings),
      parseOptionalNumber(req.body.prep_minutes),
      parseOptionalNumber(req.body.cook_minutes),
      recipeId
    );
    saveRecipeRelations(recipeId, req.body.ingredients, req.body.steps);
    findOrCreateDish(title, recipeId);
  });

  res.json(getRecipe(recipeId));
});

app.delete(`${api}/recipes/:id`, (req, res) => {
  const recipeId = assertPositiveInteger(req.params.id, 'La receta');
  const result = db.prepare('DELETE FROM recipes WHERE id = ?').run(recipeId);
  if (!result.changes) return res.status(404).json({ error: 'Receta no encontrada.' });
  res.status(204).end();
});

// Catálogo de platos usado por el menú
app.get(`${api}/dishes`, (req, res) => {
  const query = normalizeName(req.query.q);
  const dishes = query
    ? db.prepare(`
        SELECT d.*, r.title AS recipe_title
        FROM dishes d
        LEFT JOIN recipes r ON r.id = d.recipe_id
        WHERE d.name LIKE ? COLLATE NOCASE
        ORDER BY CASE WHEN d.name LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END, d.name
        LIMIT 100
      `).all(`%${query}%`, `${query}%`)
    : db.prepare(`
        SELECT d.*, r.title AS recipe_title
        FROM dishes d
        LEFT JOIN recipes r ON r.id = d.recipe_id
        ORDER BY d.updated_at DESC, d.name
        LIMIT 300
      `).all();
  res.json(dishes);
});

app.patch(`${api}/dishes/:id`, (req, res) => {
  const dishId = assertPositiveInteger(req.params.id, 'El plato');
  const recipeId = req.body.recipe_id ? assertPositiveInteger(req.body.recipe_id, 'La receta') : null;
  const result = db.prepare(`
    UPDATE dishes SET recipe_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(recipeId, dishId);
  if (!result.changes) return res.status(404).json({ error: 'Plato no encontrado.' });
  res.json(db.prepare(`
    SELECT d.*, r.title AS recipe_title
    FROM dishes d LEFT JOIN recipes r ON r.id = d.recipe_id
    WHERE d.id = ?
  `).get(dishId));
});

// Menús semanales
app.get(`${api}/menus/:weekStart`, (req, res) => {
  const weekStart = validateWeekStart(req.params.weekStart);
  const menu = db.prepare('SELECT * FROM weekly_menus WHERE week_start = ?').get(weekStart);
  if (!menu) return res.json({ week_start: weekStart, notes: '', entries: [] });

  menu.entries = db.prepare(`
    SELECT me.id, me.day_index, me.meal_type, me.dish_id,
           d.name AS dish_name, d.recipe_id, r.title AS recipe_title
    FROM menu_entries me
    JOIN dishes d ON d.id = me.dish_id
    LEFT JOIN recipes r ON r.id = d.recipe_id
    WHERE me.weekly_menu_id = ?
    ORDER BY me.day_index, me.meal_type
  `).all(menu.id);
  res.json(menu);
});

app.put(`${api}/menus/:weekStart`, (req, res) => {
  const weekStart = validateWeekStart(req.params.weekStart);
  const entries = Array.isArray(req.body.entries) ? req.body.entries : [];

  transaction(() => {
    db.prepare(`
      INSERT INTO weekly_menus (week_start, notes)
      VALUES (?, ?)
      ON CONFLICT(week_start) DO UPDATE SET
        notes = excluded.notes,
        updated_at = CURRENT_TIMESTAMP
    `).run(weekStart, normalizeName(req.body.notes) || null);

    const menu = db.prepare('SELECT * FROM weekly_menus WHERE week_start = ?').get(weekStart);
    db.prepare('DELETE FROM menu_entries WHERE weekly_menu_id = ?').run(menu.id);

    const insertEntry = db.prepare(`
      INSERT INTO menu_entries (weekly_menu_id, day_index, meal_type, dish_id)
      VALUES (?, ?, ?, ?)
    `);

    const seenSlots = new Set();
    for (const entry of entries) {
      const name = normalizeName(entry.dish_name || entry.name);
      if (!name) continue;
      const dayIndex = Number(entry.day_index);
      const mealType = entry.meal_type;
      if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) continue;
      if (!['lunch', 'dinner'].includes(mealType)) continue;
      const slot = `${dayIndex}-${mealType}`;
      if (seenSlots.has(slot)) continue;
      seenSlots.add(slot);

      const dish = findOrCreateDish(name, entry.recipe_id || null);
      insertEntry.run(menu.id, dayIndex, mealType, dish.id);
    }
  });

  const menu = db.prepare('SELECT * FROM weekly_menus WHERE week_start = ?').get(weekStart);
  menu.entries = db.prepare(`
    SELECT me.id, me.day_index, me.meal_type, me.dish_id,
           d.name AS dish_name, d.recipe_id, r.title AS recipe_title
    FROM menu_entries me
    JOIN dishes d ON d.id = me.dish_id
    LEFT JOIN recipes r ON r.id = d.recipe_id
    WHERE me.weekly_menu_id = ?
    ORDER BY me.day_index, me.meal_type
  `).all(menu.id);
  res.json(menu);
});

// Lista de la compra
function getShoppingList(listId) {
  const list = db.prepare('SELECT * FROM shopping_lists WHERE id = ?').get(listId);
  if (!list) return null;
  list.items = db.prepare(`
    SELECT si.*, i.name AS ingredient_name, i.category
    FROM shopping_items si
    JOIN ingredients i ON i.id = si.ingredient_id
    WHERE si.shopping_list_id = ?
    ORDER BY si.is_purchased, si.sort_order, si.id
  `).all(list.id);
  return list;
}

app.get(`${api}/shopping/active`, (_req, res) => {
  let list = db.prepare(`
    SELECT * FROM shopping_lists WHERE is_active = 1 ORDER BY id DESC LIMIT 1
  `).get();
  if (!list) {
    const result = db.prepare(
      "INSERT INTO shopping_lists (name, is_active) VALUES ('Lista de la compra', 1)"
    ).run();
    list = db.prepare('SELECT * FROM shopping_lists WHERE id = ?').get(Number(result.lastInsertRowid));
  }
  res.json(getShoppingList(list.id));
});

app.post(`${api}/shopping/new`, (req, res) => {
  const name = normalizeName(req.body.name) || 'Lista de la compra';
  const listId = transaction(() => {
    db.prepare('UPDATE shopping_lists SET is_active = 0, updated_at = CURRENT_TIMESTAMP').run();
    const result = db.prepare('INSERT INTO shopping_lists (name, is_active) VALUES (?, 1)').run(name);
    return Number(result.lastInsertRowid);
  });
  res.status(201).json(getShoppingList(listId));
});

app.post(`${api}/shopping/:listId/items`, (req, res) => {
  const listId = assertPositiveInteger(req.params.listId, 'La lista');
  if (!db.prepare('SELECT id FROM shopping_lists WHERE id = ?').get(listId)) {
    return res.status(404).json({ error: 'Lista no encontrada.' });
  }

  const ingredient = req.body.ingredient_id
    ? db.prepare('SELECT * FROM ingredients WHERE id = ?').get(Number(req.body.ingredient_id))
    : findOrCreateIngredient(req.body.name, req.body.category);
  if (!ingredient) return res.status(400).json({ error: 'Ingrediente no válido.' });

  const existing = db.prepare(`
    SELECT id FROM shopping_items
    WHERE shopping_list_id = ? AND ingredient_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(listId, ingredient.id);

  let itemId;
  if (existing) {
    db.prepare(`
      UPDATE shopping_items
      SET quantity = COALESCE(?, quantity),
          unit = COALESCE(?, unit),
          notes = COALESCE(?, notes),
          is_purchased = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      parseOptionalNumber(req.body.quantity),
      normalizeName(req.body.unit) || null,
      normalizeName(req.body.notes) || null,
      existing.id
    );
    itemId = existing.id;
  } else {
    const sortOrder = db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
      FROM shopping_items WHERE shopping_list_id = ?
    `).get(listId).next_order;
    const result = db.prepare(`
      INSERT INTO shopping_items
        (shopping_list_id, ingredient_id, quantity, unit, notes, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      listId,
      ingredient.id,
      parseOptionalNumber(req.body.quantity),
      normalizeName(req.body.unit) || null,
      normalizeName(req.body.notes) || null,
      sortOrder
    );
    itemId = Number(result.lastInsertRowid);
  }

  res.status(201).json(db.prepare(`
    SELECT si.*, i.name AS ingredient_name, i.category
    FROM shopping_items si JOIN ingredients i ON i.id = si.ingredient_id
    WHERE si.id = ?
  `).get(itemId));
});

app.patch(`${api}/shopping/items/:itemId`, (req, res) => {
  const itemId = assertPositiveInteger(req.params.itemId, 'El ingrediente');
  const current = db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(itemId);
  if (!current) return res.status(404).json({ error: 'Ingrediente no encontrado en la lista.' });

  const purchased = req.body.is_purchased === undefined
    ? current.is_purchased
    : req.body.is_purchased ? 1 : 0;

  db.prepare(`
    UPDATE shopping_items
    SET is_purchased = ?, quantity = ?, unit = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    purchased,
    req.body.quantity === undefined ? current.quantity : parseOptionalNumber(req.body.quantity),
    req.body.unit === undefined ? current.unit : normalizeName(req.body.unit) || null,
    req.body.notes === undefined ? current.notes : normalizeName(req.body.notes) || null,
    itemId
  );

  res.json(db.prepare(`
    SELECT si.*, i.name AS ingredient_name, i.category
    FROM shopping_items si JOIN ingredients i ON i.id = si.ingredient_id
    WHERE si.id = ?
  `).get(itemId));
});

app.delete(`${api}/shopping/items/:itemId`, (req, res) => {
  const itemId = assertPositiveInteger(req.params.itemId, 'El ingrediente');
  const result = db.prepare('DELETE FROM shopping_items WHERE id = ?').run(itemId);
  if (!result.changes) return res.status(404).json({ error: 'Ingrediente no encontrado.' });
  res.status(204).end();
});

app.delete(`${api}/shopping/:listId/purchased`, (req, res) => {
  const listId = assertPositiveInteger(req.params.listId, 'La lista');
  const result = db.prepare(`
    DELETE FROM shopping_items WHERE shopping_list_id = ? AND is_purchased = 1
  `).run(listId);
  res.json({ deleted: result.changes });
});

app.post(`${api}/shopping/:listId/from-recipe/:recipeId`, (req, res) => {
  const listId = assertPositiveInteger(req.params.listId, 'La lista');
  const recipeId = assertPositiveInteger(req.params.recipeId, 'La receta');
  if (!db.prepare('SELECT id FROM shopping_lists WHERE id = ?').get(listId)) {
    return res.status(404).json({ error: 'Lista no encontrada.' });
  }
  if (!db.prepare('SELECT id FROM recipes WHERE id = ?').get(recipeId)) {
    return res.status(404).json({ error: 'Receta no encontrada.' });
  }

  const recipeIngredients = db.prepare(`
    SELECT ingredient_id, quantity, unit, notes
    FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort_order
  `).all(recipeId);

  transaction(() => {
    const findExisting = db.prepare(`
      SELECT * FROM shopping_items
      WHERE shopping_list_id = ? AND ingredient_id = ?
      ORDER BY id DESC LIMIT 1
    `);
    const insertItem = db.prepare(`
      INSERT INTO shopping_items
        (shopping_list_id, ingredient_id, quantity, unit, notes, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateItem = db.prepare(`
      UPDATE shopping_items
      SET is_purchased = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    let nextOrder = db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS value
      FROM shopping_items WHERE shopping_list_id = ?
    `).get(listId).value;

    for (const item of recipeIngredients) {
      const existing = findExisting.get(listId, item.ingredient_id);
      if (existing) {
        updateItem.run(existing.id);
      } else {
        insertItem.run(
          listId,
          item.ingredient_id,
          item.quantity,
          item.unit,
          item.notes,
          nextOrder++
        );
      }
    }
  });

  res.json(getShoppingList(listId));
});

app.use(basePath || '/', express.static(publicDir));

if (basePath) {
  app.get('/', (_req, res) => res.redirect(basePath));
  app.get(`${basePath}/*`, (req, res, next) => {
    if (req.path.startsWith(`${api}/`)) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });
} else {
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
}

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.status || (String(error.message).includes('UNIQUE constraint') ? 409 : 500);
  let message = error.message || 'Ha ocurrido un error inesperado.';
  if (String(error.message).includes('UNIQUE constraint failed: recipes.title')) {
    message = 'Ya existe una receta con ese nombre.';
  }
  res.status(status).json({ error: message });
});

app.listen(port, () => {
  console.log(`Cocina disponible en http://localhost:${port}${basePath || '/'}`);
  console.log(`SQLite: ${databasePath}`);
});
