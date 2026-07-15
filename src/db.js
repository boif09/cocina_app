const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { databasePath, rootDir } = require('./config');

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

const BASIC_INGREDIENTS = {
  'Verduras y hortalizas': [
    'Acelgas', 'Ajo', 'Alcachofa', 'Apio', 'Berenjena', 'Boniato', 'Brócoli', 'Calabacín',
    'Calabaza', 'Cebolla', 'Cebolla morada', 'Champiñones', 'Col', 'Coliflor', 'Espárragos',
    'Espinacas', 'Guisantes', 'Judías verdes', 'Lechuga', 'Maíz', 'Patata', 'Pepino',
    'Pimiento rojo', 'Pimiento verde', 'Puerro', 'Rúcula', 'Tomate', 'Tomate cherry', 'Zanahoria'
  ],
  'Fruta': [
    'Aguacate', 'Fresas', 'Kiwi', 'Limón', 'Mandarina', 'Manzana', 'Melocotón', 'Naranja',
    'Pera', 'Piña', 'Plátano', 'Sandía', 'Uvas'
  ],
  'Carne': [
    'Carne picada', 'Cerdo', 'Chuletas de cerdo', 'Conejo', 'Hamburguesas', 'Jamón cocido',
    'Jamón serrano', 'Pavo', 'Pechuga de pollo', 'Pollo', 'Salchichas', 'Ternera'
  ],
  'Pescado y marisco': [
    'Atún en conserva', 'Bacalao', 'Calamares', 'Gambas', 'Langostinos', 'Lubina', 'Mejillones',
    'Merluza', 'Salmón', 'Sardinas', 'Sepia'
  ],
  'Lácteos y huevos': [
    'Huevos', 'Leche', 'Mantequilla', 'Mozzarella', 'Nata para cocinar', 'Queso', 'Queso crema',
    'Queso rallado', 'Yogur natural'
  ],
  'Pasta, arroz y legumbres': [
    'Alubias', 'Arroz', 'Cuscús', 'Espaguetis', 'Fideos', 'Garbanzos', 'Lentejas', 'Macarrones',
    'Pasta', 'Quinoa'
  ],
  'Pan y harinas': [
    'Harina', 'Harina de maíz', 'Levadura', 'Pan', 'Pan de molde', 'Pan rallado', 'Tortillas de trigo'
  ],
  'Despensa': [
    'Aceite de girasol', 'Aceite de oliva', 'Aceitunas', 'Azúcar', 'Caldo de carne',
    'Caldo de pescado', 'Caldo de verduras', 'Chocolate', 'Concentrado de tomate', 'Kétchup',
    'Leche de coco', 'Mayonesa', 'Miel', 'Mostaza', 'Salsa de soja', 'Tomate frito', 'Vinagre'
  ],
  'Especias y condimentos': [
    'Albahaca', 'Canela', 'Cilantro', 'Comino', 'Curry', 'Laurel', 'Nuez moscada', 'Orégano',
    'Perejil', 'Pimentón dulce', 'Pimentón picante', 'Pimienta negra', 'Romero', 'Sal', 'Tomillo'
  ],
  'Congelados': [
    'Croquetas', 'Espinacas congeladas', 'Guisantes congelados', 'Patatas fritas congeladas',
    'Pizza congelada', 'Verduras congeladas'
  ],
  'Otros': [
    'Agua', 'Café', 'Cerveza sin alcohol', 'Frutos secos', 'Té'
  ]
};

function initializeDatabase() {
  const schema = fs.readFileSync(path.join(rootDir, 'schema.sql'), 'utf8');
  db.exec(schema);

  const insertIngredient = db.prepare(
    'INSERT OR IGNORE INTO ingredients (name, category) VALUES (?, ?)'
  );

  db.exec('BEGIN');
  try {
    for (const [category, names] of Object.entries(BASIC_INGREDIENTS)) {
      for (const name of names) insertIngredient.run(name, category);
    }
    db.prepare(`
      INSERT INTO shopping_lists (name, is_active)
      SELECT 'Lista de la compra', 1
      WHERE NOT EXISTS (SELECT 1 FROM shopping_lists WHERE is_active = 1)
    `).run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function transaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function findOrCreateIngredient(name, category = null) {
  const cleanName = normalizeName(name);
  if (!cleanName) throw new Error('El nombre del ingrediente es obligatorio.');

  const existing = db.prepare('SELECT * FROM ingredients WHERE name = ? COLLATE NOCASE').get(cleanName);
  if (existing) return existing;

  const result = db.prepare(
    'INSERT INTO ingredients (name, category) VALUES (?, ?)'
  ).run(cleanName, category || null);
  return db.prepare('SELECT * FROM ingredients WHERE id = ?').get(Number(result.lastInsertRowid));
}

function findOrCreateDish(name, recipeId = null) {
  const cleanName = normalizeName(name);
  if (!cleanName) throw new Error('El nombre del plato es obligatorio.');

  const existing = db.prepare('SELECT * FROM dishes WHERE name = ? COLLATE NOCASE').get(cleanName);
  if (existing) {
    if (recipeId && Number(existing.recipe_id) !== Number(recipeId)) {
      db.prepare(
        'UPDATE dishes SET recipe_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(Number(recipeId), existing.id);
      return db.prepare('SELECT * FROM dishes WHERE id = ?').get(existing.id);
    }
    return existing;
  }

  const result = db.prepare(
    'INSERT INTO dishes (name, recipe_id) VALUES (?, ?)'
  ).run(cleanName, recipeId ? Number(recipeId) : null);
  return db.prepare('SELECT * FROM dishes WHERE id = ?').get(Number(result.lastInsertRowid));
}

initializeDatabase();

module.exports = {
  db,
  transaction,
  normalizeName,
  findOrCreateIngredient,
  findOrCreateDish
};
