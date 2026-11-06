// Cola de cambios de la lista de la compra hechos sin conexión (guardada en el móvil).
// - Vista = última lista del servidor + cambios pendientes (applyOps), así nada se pierde al recargar.
// - Todas las operaciones son repetibles: marcar usa un valor explícito (no "alternar"), borrar un
//   elemento que ya no existe cuenta como hecho y añadir el mismo ingrediente dos veces no lo duplica.
// - Los elementos creados sin conexión usan un id temporal ("tmp-…") que se sustituye al sincronizar.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ingredient-key'));
  else root.ShoppingOutbox = factory(root.IngredientKey);
}(typeof self !== 'undefined' ? self : this, function (IngredientKey) {
  const QUEUE_KEY = 'cocina.shopping.queue.v1';
  const CACHE_KEY = 'cocina.shopping.cache.v1';

  const isTempId = id => typeof id === 'string' && id.startsWith('tmp-');
  const newTempId = () => `tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const clone = value => JSON.parse(JSON.stringify(value));

  function safeStorage(storage) {
    return {
      read(key, fallback) {
        try {
          const raw = storage?.getItem(key);
          return raw ? JSON.parse(raw) : fallback;
        } catch (_error) { return fallback; }
      },
      // Devuelve false si no se pudo guardar (sin espacio o almacenamiento bloqueado)
      write(key, value) {
        try { storage.setItem(key, JSON.stringify(value)); return true; } catch (_error) { return false; }
      }
    };
  }

  // Aplica los cambios pendientes sobre una lista (sin modificar la original).
  function applyOps(list, ops, lookupCategory = () => null) {
    if (!list) return list;
    const result = clone(list);
    result.items = result.items || [];
    for (const op of ops) {
      if (op.listId !== undefined && op.listId !== result.id) continue;
      const find = id => result.items.find(item => String(item.id) === String(id));
      if (op.type === 'add') {
        const key = IngredientKey.ingredientKey(op.name);
        const existing = result.items.find(item => IngredientKey.ingredientKey(item.ingredient_name) === key);
        const unit = (op.unit || '').trim() || null;
        if (existing) {
          existing.is_purchased = 0;
          if (op.quantity !== null && op.quantity !== undefined) existing.quantity = op.quantity;
          if (unit) existing.unit = unit;
        } else {
          result.items.push({
            id: op.tempId,
            shopping_list_id: result.id,
            ingredient_name: op.name,
            category: lookupCategory(op.name),
            quantity: op.quantity ?? null,
            unit,
            notes: null,
            is_purchased: 0,
            sort_order: result.items.reduce((max, item) => Math.max(max, item.sort_order ?? 0), -1) + 1,
            pending: true
          });
        }
      } else if (op.type === 'toggle') {
        const item = find(op.itemId);
        if (item) item.is_purchased = op.purchased ? 1 : 0;
      } else if (op.type === 'edit') {
        const item = find(op.itemId);
        if (item) {
          item.quantity = op.quantity ?? null;
          item.unit = (op.unit || '').trim() || null;
        }
      } else if (op.type === 'delete') {
        result.items = result.items.filter(item => String(item.id) !== String(op.itemId));
      } else if (op.type === 'clear') {
        result.items = result.items.filter(item => !item.is_purchased);
      }
    }
    return result;
  }

  // Un error es "reintentable" si no es culpa de la petición: sin red, servidor caído o sesión caducada.
  const isRetryable = error => Boolean(error && (error.offline || error.status === undefined
    || error.status >= 500 || [401, 403, 408, 429].includes(error.status)));

  function createOutbox({ storage, onChange = () => {} } = {}) {
    const store = safeStorage(storage);
    let queue = store.read(QUEUE_KEY, []);
    let flushing = null;

    const persist = () => { const saved = store.write(QUEUE_KEY, queue); onChange(); return saved; };

    function remapTempId(tempId, realId) {
      for (const op of queue) if (op.itemId === tempId) op.itemId = realId;
    }

    async function run(send) {
      const dropped = [];
      while (queue.length) {
        const op = queue[0];
        if (isTempId(op.itemId)) {
          // Su "añadir" fue rechazado: no hay nada a lo que aplicarlo
          queue.shift(); persist();
          dropped.push({ op, error: new Error('El ingrediente ya no existe.') });
          continue;
        }
        let result;
        try {
          result = await send(op);
        } catch (error) {
          if (isRetryable(error)) return { offline: true, dropped };
          queue.shift(); persist();
          dropped.push({ op, error });
          continue;
        }
        if (op.type === 'add' && result?.id !== undefined) remapTempId(op.tempId, result.id);
        queue.shift(); persist();
      }
      return { offline: false, dropped };
    }

    return {
      pending: () => queue.slice(),
      count: () => queue.length,
      // Devuelve false si el cambio no quedó guardado en el dispositivo (se perdería al recargar)
      enqueue(op) {
        queue.push({ ...op, queuedAt: new Date().toISOString() });
        return persist();
      },
      // Envía los pendientes en orden. Una sola ejecución a la vez; devuelve { offline, dropped }.
      flush(send) {
        if (flushing) return flushing;
        flushing = run(send).finally(() => { flushing = null; });
        return flushing;
      },
      isFlushing: () => Boolean(flushing),
      clear() { queue = []; persist(); },
      loadCache: () => store.read(CACHE_KEY, null),
      saveCache: list => store.write(CACHE_KEY, list)
    };
  }

  return { applyOps, createOutbox, newTempId, isTempId, isRetryable };
}));
