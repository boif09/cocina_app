// Clave para comparar nombres de ingredientes: sin tildes, mayúsculas ni plurales.
// "Tomates", "tomate" y "Tómate" dan la misma clave. Se usa en el servidor (require) y en el navegador.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IngredientKey = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // Plurales en -es tras estas consonantes: limones, jamones, colores (pero verdes -> verde, tomates -> tomate)
  const CONSONANTS_BEFORE_ES = 'lnr';

  function singularWord(word) {
    if (word.length <= 3) return word;
    if (word.endsWith('ces')) return `${word.slice(0, -3)}z`;
    if (word.endsWith('es') && word.length > 4) {
      // limones -> limon, colores -> color; pero tomates -> tomate y legumbres -> legumbre (consonante + e)
      const stem = word.slice(0, -2);
      const last = stem[stem.length - 1];
      const before = stem[stem.length - 2];
      const plainConsonantPlural = CONSONANTS_BEFORE_ES.includes(last) && 'aeiou'.includes(before);
      return plainConsonantPlural ? stem : word.slice(0, -1);
    }
    if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
  }

  function ingredientKey(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(singularWord)
      .join(' ');
  }

  // Devuelve el ingrediente existente que "es el mismo" que `name` (misma clave) o null.
  // Si hay un nombre idéntico (sin tener en cuenta mayúsculas) se prefiere ese.
  function findSimilar(name, ingredients) {
    const key = ingredientKey(name);
    if (!key) return null;
    const lower = String(name).trim().toLocaleLowerCase('es');
    let similar = null;
    for (const item of ingredients) {
      if (String(item.name).trim().toLocaleLowerCase('es') === lower) return item;
      if (!similar && ingredientKey(item.name) === key) similar = item;
    }
    return similar;
  }

  return { ingredientKey, findSimilar };
}));
