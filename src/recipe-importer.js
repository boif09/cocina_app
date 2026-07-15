const MAX_HTML_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 10_000;

const FRACTIONS = {
  '1/2': 0.5,
  '1/3': 1 / 3,
  '2/3': 2 / 3,
  '1/4': 0.25,
  '3/4': 0.75,
  '1/8': 0.125
};

const UNITS = new Set([
  'g', 'gr', 'gramo', 'gramos',
  'kg', 'kilo', 'kilos',
  'ml', 'l', 'litro', 'litros',
  'cucharada', 'cucharadas', 'cda', 'cdas',
  'cucharadita', 'cucharaditas', 'cdta', 'cdtas',
  'taza', 'tazas',
  'unidad', 'unidades',
  'diente', 'dientes',
  'pizca', 'pizcas',
  'vaso', 'vasos',
  'sobre', 'sobres',
  'lata', 'latas'
]);

function cleanText(value) {
  return decodeHtmlEntities(String(value || ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

function normalizeUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_error) {
    const error = new Error('El enlace no es valido.');
    error.status = 400;
    throw error;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    const error = new Error('Solo se pueden importar enlaces http o https.');
    error.status = 400;
    throw error;
  }

  return url.toString();
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'CocinaEnCasa/1.0 (+recipe importer)'
      }
    });

    if (!response.ok) {
      const error = new Error(`La pagina ha respondido con estado ${response.status}.`);
      error.status = 502;
      throw error;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      const error = new Error('El enlace no parece ser una pagina HTML.');
      error.status = 400;
      throw error;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_HTML_BYTES) {
        const error = new Error('La pagina es demasiado grande para importarla automaticamente.');
        error.status = 413;
        throw error;
      }
      chunks.push(value);
    }

    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('La pagina ha tardado demasiado en responder.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonLdBlocks(html) {
  const blocks = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const attributes = match[1] || '';
    if (!/type\s*=\s*["']?application\/ld\+json\b/i.test(attributes)) {
      continue;
    }

    const raw = decodeHtmlEntities(match[2]).trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch (_error) {
      const candidates = raw
        .split(/<\/script>\s*<script\b[^>]*type=["']application\/ld\+json["'][^>]*>/i)
        .map(value => value.trim())
        .filter(Boolean);
      for (const candidate of candidates) {
        try { blocks.push(JSON.parse(candidate)); } catch (__error) {}
      }
    }
  }

  return blocks;
}

function isRecipeNode(node) {
  const type = node?.['@type'];
  if (Array.isArray(type)) return type.some(item => String(item).toLowerCase() === 'recipe');
  return String(type || '').toLowerCase() === 'recipe';
}

function collectRecipeNodes(value, recipes = []) {
  if (!value || typeof value !== 'object') return recipes;
  if (Array.isArray(value)) {
    value.forEach(item => collectRecipeNodes(item, recipes));
    return recipes;
  }

  if (isRecipeNode(value)) recipes.push(value);

  if (Array.isArray(value['@graph'])) collectRecipeNodes(value['@graph'], recipes);
  if (Array.isArray(value.mainEntity)) collectRecipeNodes(value.mainEntity, recipes);
  else if (value.mainEntity) collectRecipeNodes(value.mainEntity, recipes);

  return recipes;
}

function firstText(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const text = firstText(...value);
      if (text) return text;
    } else if (value && typeof value === 'object') {
      const text = firstText(value.name, value.text);
      if (text) return text;
    } else {
      const text = cleanText(value);
      if (text) return text;
    }
  }
  return '';
}

function parseDurationMinutes(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const isoMatch = text.match(/^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?$/i);
  if (isoMatch) {
    const hours = Number(isoMatch[1] || 0);
    const minutes = Number(isoMatch[2] || 0);
    return hours * 60 + minutes || null;
  }

  const hourMatch = text.match(/(\d+)\s*(?:h|hora|horas)/i);
  const minuteMatch = text.match(/(\d+)\s*(?:m|min|minuto|minutos)/i);
  const total = Number(hourMatch?.[1] || 0) * 60 + Number(minuteMatch?.[1] || 0);
  return total || null;
}

function parseServings(value) {
  const text = firstText(value);
  const match = text.match(/\d+/);
  return match ? Number(match[0]) : null;
}

function decimalFromToken(token) {
  const normalized = token.replace(',', '.');
  if (FRACTIONS[token]) return FRACTIONS[token];
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  return null;
}

function parseIngredient(line) {
  const text = cleanText(line);
  if (!text) return null;

  const tokens = text.split(' ');
  let quantity = null;
  let unit = '';
  let startIndex = 0;

  const first = tokens[0];
  const second = tokens[1];
  if (first) {
    const firstNumber = decimalFromToken(first);
    if (firstNumber !== null) {
      quantity = firstNumber;
      startIndex = 1;
      if (second && FRACTIONS[second]) {
        quantity += FRACTIONS[second];
        startIndex = 2;
      }
    } else {
      const mixed = first.match(/^(\d+)[\s-](\d+\/\d+)$/);
      if (mixed && FRACTIONS[mixed[2]]) {
        quantity = Number(mixed[1]) + FRACTIONS[mixed[2]];
        startIndex = 1;
      }
    }
  }

  const possibleUnit = tokens[startIndex]?.replace(/[.,:]$/, '').toLowerCase();
  if (possibleUnit && UNITS.has(possibleUnit)) {
    unit = tokens[startIndex].replace(/[.,:]$/, '');
    startIndex += 1;
  }

  const name = tokens.slice(startIndex).join(' ').replace(/^de\s+/i, '').trim() || text;
  return { name, quantity, unit, notes: '' };
}

function extractInstructions(value, output = []) {
  if (!value) return output;
  if (typeof value === 'string') {
    const text = cleanText(value);
    if (text) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach(item => extractInstructions(item, output));
    return output;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.itemListElement)) extractInstructions(value.itemListElement, output);
    else {
      const text = firstText(value.text, value.name);
      if (text) output.push(text);
    }
  }
  return output;
}

function recipeFromJsonLd(recipe, sourceUrl) {
  const rawIngredients = Array.isArray(recipe.recipeIngredient)
    ? recipe.recipeIngredient
    : [recipe.recipeIngredient].filter(Boolean);
  const ingredients = rawIngredients
    .map(parseIngredient)
    .filter(Boolean);
  const steps = extractInstructions(recipe.recipeInstructions)
    .map(instruction => ({ instruction }));

  if (!ingredients.length || !steps.length) {
    const error = new Error('No encontre ingredientes y pasos en los datos estructurados de la pagina.');
    error.status = 422;
    throw error;
  }

  const description = firstText(recipe.description);
  return {
    title: firstText(recipe.name, recipe.headline) || 'Receta importada',
    description,
    servings: parseServings(recipe.recipeYield || recipe.yield),
    prep_minutes: parseDurationMinutes(recipe.prepTime),
    cook_minutes: parseDurationMinutes(recipe.cookTime),
    source_url: sourceUrl,
    ingredients,
    steps
  };
}

async function importRecipeFromUrl(inputUrl) {
  const url = normalizeUrl(inputUrl);
  const html = await fetchHtml(url);
  const recipes = extractJsonLdBlocks(html).flatMap(block => collectRecipeNodes(block));

  if (!recipes.length) {
    const error = new Error('No se pudo importar automaticamente: la pagina no incluye datos estructurados de receta.');
    error.status = 422;
    throw error;
  }

  return recipeFromJsonLd(recipes[0], url);
}

module.exports = {
  importRecipeFromUrl,
  extractJsonLdBlocks,
  collectRecipeNodes,
  recipeFromJsonLd
};
