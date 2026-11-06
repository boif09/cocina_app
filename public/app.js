const scriptUrl = new URL(document.currentScript.src);
const BASE_PATH = scriptUrl.pathname.replace(/\/app\.js$/, '').replace(/\/$/, '');
const API = `${BASE_PATH}/api`;

const state = {
  recipes: [],
  dishes: [],
  ingredients: [],
  activeRecipe: null,
  shoppingList: null,
  weekStart: getMonday(new Date()),
  menu: null,
  shoppingServer: null, // última lista recibida del servidor (sin cambios pendientes)
  offline: false,
  managerItems: [],
  mergeFrom: null,
  servingsTarget: null,
  cookMode: false,
  // Texto escrito en el menú y aún sin guardar, por semana: { '2026-10-19': { '0-lunch': 'Pasta' } }
  menuDrafts: {}
};

const days = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const mealLabels = { lunch: 'Comida', dinner: 'Cena' };
let toastTimer;
let searchTimer;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Errores con `status` (código HTTP) y `offline` (true si no hay red, el servidor no responde o la sesión caducó)
async function apiFetch(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
  } catch (_networkError) {
    const error = new Error('Sin conexión con el servidor.');
    error.offline = true;
    throw error;
  }

  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'No se ha podido completar la operación.');
    error.status = response.status;
    error.offline = ShoppingOutbox.isRetryable(error);
    throw error;
  }
  return data;
}

function showToast(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast visible${type === 'error' ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2800);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalize(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
}

function openModal(id) {
  const modal = $(`#${id}`);
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal(modal) {
  const target = typeof modal === 'string' ? $(`#${modal}`) : modal.closest('.modal');
  if (!target) return;
  target.classList.remove('open');
  target.setAttribute('aria-hidden', 'true');
  if (!$('.modal.open')) document.body.style.overflow = '';
  if (target.id === 'recipe-detail-modal' && state.cookMode) setCookMode(false);
}

function switchView(viewName) {
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${viewName}`));
  $$('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === viewName));
  const hashMap = { recipes: 'recetas', menu: 'menu', shopping: 'compra' };
  history.replaceState(null, '', `#${hashMap[viewName]}`);

  if (viewName === 'menu') loadMenu().catch(handleError);
  if (viewName === 'shopping') loadShoppingList().catch(handleError);
}

// Deslizar izquierda/derecha para cambiar de sección (solo móvil)
const VIEW_ORDER = ['recipes', 'menu', 'shopping'];
const mobileQuery = window.matchMedia('(max-width: 700px)');

function canScrollHorizontally(element, dx) {
  for (let node = element; node && node !== document.body; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    if (!['auto', 'scroll'].includes(getComputedStyle(node).overflowX)) continue;
    // dx < 0: el dedo va a la izquierda y el contenido se desplaza hacia la derecha
    if (dx < 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1) return true;
    if (dx > 0 && node.scrollLeft > 1) return true;
  }
  return false;
}

function setupSwipeNavigation() {
  let start = null;

  document.addEventListener('touchstart', event => {
    const blocked = event.touches.length !== 1
      || $('.modal.open')
      || event.target.closest('input, textarea, select');
    start = blocked ? null : { x: event.touches[0].clientX, y: event.touches[0].clientY, target: event.target };
  }, { passive: true });

  document.addEventListener('touchend', event => {
    if (!start || !mobileQuery.matches) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const target = start.target;
    start = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    if (canScrollHorizontally(target, dx)) return;

    const current = VIEW_ORDER.indexOf($('.nav-button.active')?.dataset.view);
    const next = VIEW_ORDER[current + (dx < 0 ? 1 : -1)];
    if (current < 0 || !next) return;
    switchView(next);
    window.scrollTo(0, 0);
  }, { passive: true });

  document.addEventListener('touchcancel', () => { start = null; }, { passive: true });
}

function handleError(error) {
  console.error(error);
  showToast(error.message || 'Ha ocurrido un error.', 'error');
}

// RECETAS
async function loadRecipes(query = '') {
  state.recipes = await apiFetch(`/recipes${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  renderRecipes();
}

function renderRecipes() {
  const grid = $('#recipe-grid');
  const empty = $('#recipe-empty');
  grid.innerHTML = '';
  empty.classList.toggle('hidden', state.recipes.length > 0);

  for (const recipe of state.recipes) {
    const totalMinutes = Number(recipe.prep_minutes || 0) + Number(recipe.cook_minutes || 0);
    const card = document.createElement('article');
    card.className = 'recipe-card';
    card.tabIndex = 0;
    card.dataset.recipeId = recipe.id;
    card.innerHTML = `
      <div class="recipe-card-icon">${recipeEmoji(recipe.title)}</div>
      <h3>${escapeHtml(recipe.title)}</h3>
      <p>${escapeHtml(recipe.description || 'Abre la receta para ver sus ingredientes y preparación.')}</p>
      <div class="recipe-card-footer">
        <span class="mini-tag">${recipe.ingredient_count} ingredientes</span>
        ${recipe.servings ? `<span class="mini-tag">${recipe.servings} raciones</span>` : ''}
        ${totalMinutes ? `<span class="mini-tag">${totalMinutes} min</span>` : ''}
      </div>
    `;
    card.addEventListener('click', () => openRecipeDetail(recipe.id));
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') openRecipeDetail(recipe.id);
    });
    grid.appendChild(card);
  }
}

function recipeEmoji(title) {
  const text = normalize(title);
  if (text.includes('ensalada')) return '🥗';
  if (text.includes('pasta') || text.includes('espagueti') || text.includes('macarr')) return '🍝';
  if (text.includes('arroz') || text.includes('paella')) return '🥘';
  if (text.includes('sopa') || text.includes('crema')) return '🍲';
  if (text.includes('pizza')) return '🍕';
  if (text.includes('pollo') || text.includes('carne')) return '🍗';
  if (text.includes('pescado') || text.includes('salmón')) return '🐟';
  if (text.includes('tarta') || text.includes('pastel')) return '🍰';
  return '🍽️';
}

function addIngredientRow(item = {}) {
  const row = document.createElement('div');
  row.className = 'ingredient-row';
  row.innerHTML = `
    <input class="ingredient-name" list="ingredient-suggestions" placeholder="Ingrediente" value="${escapeHtml(item.name || '')}">
    <input class="ingredient-quantity" type="number" min="0" step="any" placeholder="Cant." value="${item.quantity ?? ''}">
    <input class="ingredient-unit" placeholder="Unidad" value="${escapeHtml(item.unit || '')}">
    <input class="ingredient-notes" placeholder="Notas (opcional)" value="${escapeHtml(item.notes || '')}">
    <button class="remove-row" type="button" aria-label="Eliminar ingrediente">×</button>
  `;
  $('.ingredient-name', row).addEventListener('change', event => {
    // "tomates" -> "Tomate" si ya existe, para no crear duplicados
    const typed = event.target.value.trim();
    const similar = typed ? IngredientKey.findSimilar(typed, state.ingredients) : null;
    if (similar && similar.name.toLocaleLowerCase('es') !== typed.toLocaleLowerCase('es')) {
      event.target.value = similar.name;
      showToast(`«${typed}» ya existe como «${similar.name}».`);
    }
  });
  $('.remove-row', row).addEventListener('click', () => {
    row.remove();
    if (!$('#recipe-ingredients').children.length) addIngredientRow();
  });
  $('#recipe-ingredients').appendChild(row);
}

function addStepRow(instruction = '') {
  const row = document.createElement('div');
  row.className = 'step-row';
  row.innerHTML = `
    <span class="step-number"></span>
    <textarea rows="2" placeholder="Describe este paso…">${escapeHtml(instruction)}</textarea>
    <button class="remove-row" type="button" aria-label="Eliminar paso">×</button>
  `;
  $('.remove-row', row).addEventListener('click', () => {
    row.remove();
    if (!$('#recipe-steps').children.length) addStepRow();
    renumberSteps();
  });
  $('#recipe-steps').appendChild(row);
  renumberSteps();
}

function renumberSteps() {
  $$('.step-row').forEach((row, index) => { $('.step-number', row).textContent = index + 1; });
}

function resetRecipeForm(prefillTitle = '') {
  $('#recipe-form').reset();
  $('#recipe-id').value = '';
  $('#recipe-form-title').textContent = 'Nueva receta';
  $('#recipe-title').value = prefillTitle;
  $('#recipe-ingredients').innerHTML = '';
  $('#recipe-steps').innerHTML = '';
  addIngredientRow();
  addStepRow();
}

async function openRecipeForm(recipe = null, prefillTitle = '') {
  resetRecipeForm(prefillTitle);
  $('#recipe-import-form').classList.toggle('hidden', Boolean(recipe?.id));
  if (recipe) {
    const isExistingRecipe = Boolean(recipe.id);
    $('#recipe-form-title').textContent = isExistingRecipe ? 'Editar receta' : 'Nueva receta';
    $('#recipe-id').value = isExistingRecipe ? recipe.id : '';
    $('#recipe-title').value = recipe.title || '';
    $('#recipe-description').value = recipe.description || '';
    $('#recipe-servings').value = recipe.servings || '';
    $('#recipe-prep').value = recipe.prep_minutes || '';
    $('#recipe-cook').value = recipe.cook_minutes || '';
    $('#recipe-ingredients').innerHTML = '';
    $('#recipe-steps').innerHTML = '';
    recipe.ingredients.forEach(addIngredientRow);
    recipe.steps.forEach(step => addStepRow(step.instruction));
    if (!recipe.ingredients.length) addIngredientRow();
    if (!recipe.steps.length) addStepRow();
  }
  closeModal('recipe-detail-modal');
  openModal('recipe-form-modal');
  setTimeout(() => $('#recipe-title').focus(), 50);
}

async function importRecipeFromUrl(event) {
  event.preventDefault();
  const input = $('#recipe-import-url');
  const button = $('#recipe-import-button');
  const url = input.value.trim();
  if (!url) return showToast('Pega un enlace de receta.', 'error');

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Importando...';

  try {
    const recipe = await apiFetch('/recipes/import-url', {
      method: 'POST',
      body: JSON.stringify({ url })
    });
    await openRecipeForm(recipe);
    input.value = '';
    showToast('Receta importada. Revisa los datos antes de guardar.');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function collectRecipeForm() {
  const ingredients = $$('.ingredient-row').map(row => ({
    name: $('.ingredient-name', row).value.trim(),
    quantity: $('.ingredient-quantity', row).value || null,
    unit: $('.ingredient-unit', row).value.trim(),
    notes: $('.ingredient-notes', row).value.trim()
  })).filter(item => item.name);

  const steps = $$('.step-row textarea').map(textarea => textarea.value.trim()).filter(Boolean);

  return {
    title: $('#recipe-title').value.trim(),
    description: $('#recipe-description').value.trim(),
    servings: $('#recipe-servings').value || null,
    prep_minutes: $('#recipe-prep').value || null,
    cook_minutes: $('#recipe-cook').value || null,
    ingredients,
    steps
  };
}

async function saveRecipe(event) {
  event.preventDefault();
  const id = $('#recipe-id').value;
  const payload = collectRecipeForm();
  if (!payload.title) return showToast('Escribe el nombre de la receta.', 'error');
  if (!payload.ingredients.length) return showToast('Añade al menos un ingrediente.', 'error');
  if (!payload.steps.length) return showToast('Añade al menos un paso.', 'error');

  const recipe = await apiFetch(id ? `/recipes/${id}` : '/recipes', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(payload)
  });
  closeModal('recipe-form-modal');
  showToast(id ? 'Receta actualizada.' : 'Receta guardada.');
  await Promise.all([loadRecipes($('#recipe-search').value.trim()), loadDishes(), loadIngredients()]);
  state.activeRecipe = recipe;
}

async function openRecipeDetail(id) {
  const recipe = await apiFetch(`/recipes/${id}`);
  state.activeRecipe = recipe;
  $('#detail-title').textContent = recipe.title;
  $('#detail-description').textContent = recipe.description || '';

  const totalMinutes = Number(recipe.prep_minutes || 0) + Number(recipe.cook_minutes || 0);
  $('#detail-meta').innerHTML = [
    recipe.servings ? `<span class="mini-tag">👥 ${recipe.servings} raciones</span>` : '',
    recipe.prep_minutes ? `<span class="mini-tag">Preparación: ${recipe.prep_minutes} min</span>` : '',
    recipe.cook_minutes ? `<span class="mini-tag">Cocción: ${recipe.cook_minutes} min</span>` : '',
    totalMinutes ? `<span class="mini-tag">Total: ${totalMinutes} min</span>` : ''
  ].join('');

  state.servingsTarget = recipe.servings || null;
  renderDetailIngredients();

  $('#detail-steps').innerHTML = recipe.steps
    .map(step => `<li>${escapeHtml(step.instruction)}</li>`)
    .join('') || '<li>No hay pasos guardados.</li>';

  setCookMode(false);
  openModal('recipe-detail-modal');
}

// RACIONES: las cantidades se recalculan en pantalla (la receta guardada no cambia)
const MIN_SERVINGS = 1;
const MAX_SERVINGS = 99;

function recipeServingsChanged() {
  const recipe = state.activeRecipe;
  return Boolean(recipe?.servings && state.servingsTarget && state.servingsTarget !== recipe.servings);
}

function renderDetailIngredients() {
  const recipe = state.activeRecipe;
  const factor = recipeServingsChanged() ? state.servingsTarget / recipe.servings : 1;

  const control = $('#detail-servings');
  control.classList.toggle('hidden', !recipe.servings);
  $('#servings-value').textContent = state.servingsTarget ?? '';
  $('#servings-reset').classList.toggle('hidden', !recipeServingsChanged());
  $('#servings-minus').disabled = (state.servingsTarget ?? 0) <= MIN_SERVINGS;
  $('#servings-plus').disabled = (state.servingsTarget ?? 0) >= MAX_SERVINGS;

  $('#detail-ingredients').innerHTML = recipe.ingredients.map(item => {
    const quantityValue = item.quantity === null || item.quantity === undefined ? null : item.quantity * factor;
    const quantity = [formatNumber(quantityValue), item.unit].filter(Boolean).join(' ');
    const detail = [quantity, item.notes].filter(Boolean).join(' · ');
    return `<li><strong>${escapeHtml(item.name)}</strong><span${factor !== 1 && quantityValue !== null ? ' class="scaled"' : ''}>${escapeHtml(detail)}</span></li>`;
  }).join('') || '<li>No hay ingredientes guardados.</li>';
}

function changeServings(delta) {
  if (!state.activeRecipe?.servings) return;
  const next = Math.min(MAX_SERVINGS, Math.max(MIN_SERVINGS, (state.servingsTarget || state.activeRecipe.servings) + delta));
  state.servingsTarget = next;
  renderDetailIngredients();
}

// MODO COCINA: pasos grandes y pantalla encendida mientras se cocina
let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    showToast('Este navegador no puede mantener la pantalla encendida.', 'error');
    return;
  }
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => { if (wakeLock === sentinel) wakeLock = null; });
    wakeLock = sentinel;
  } catch (_error) {
    showToast('No se pudo mantener la pantalla encendida.', 'error');
  }
}

async function releaseWakeLock() {
  const sentinel = wakeLock;
  wakeLock = null;
  try { await sentinel?.release(); } catch (_error) { /* ya liberado */ }
}

function setCookMode(on) {
  state.cookMode = on;
  $('#recipe-detail-modal').classList.toggle('cook-mode', on);
  const button = $('#cook-mode-toggle');
  button.textContent = on ? 'Salir del modo cocina' : 'Modo cocina';
  button.setAttribute('aria-pressed', String(on));
  if (!on) $$('#detail-steps li.done').forEach(step => step.classList.remove('done'));
  return on ? requestWakeLock() : releaseWakeLock();
}

// Al volver a la pestaña el navegador suelta la pantalla encendida: se vuelve a pedir
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.cookMode && !wakeLock) requestWakeLock();
});

async function deleteActiveRecipe() {
  if (!state.activeRecipe) return;
  if (!confirm(`¿Eliminar la receta “${state.activeRecipe.title}”?`)) return;
  await apiFetch(`/recipes/${state.activeRecipe.id}`, { method: 'DELETE' });
  closeModal('recipe-detail-modal');
  state.activeRecipe = null;
  await Promise.all([loadRecipes(), loadDishes()]);
  showToast('Receta eliminada.');
}

// MENÚ SEMANAL
function getMonday(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = result.getDay() || 7;
  result.setDate(result.getDate() - day + 1);
  result.setHours(12, 0, 0, 0);
  return result;
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatWeekTitle(start) {
  const end = addDays(start, 6);
  const formatter = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long' });
  if (start.getMonth() === end.getMonth()) {
    return `${start.getDate()}–${formatter.format(end)} de ${end.getFullYear()}`;
  }
  return `${formatter.format(start)} – ${formatter.format(end)} de ${end.getFullYear()}`;
}

async function loadDishes() {
  state.dishes = await apiFetch('/dishes');
  $('#dish-suggestions').innerHTML = state.dishes
    .map(dish => `<option value="${escapeHtml(dish.name)}"></option>`).join('');
}

async function loadMenu() {
  if (!state.dishes.length) await loadDishes();
  const weekIso = toIsoDate(state.weekStart);
  state.menu = await apiFetch(`/menus/${weekIso}`);
  renderMenu();
}

function renderMenu() {
  $('#week-title').textContent = capitalize(formatWeekTitle(state.weekStart));
  const container = $('#weekly-menu');
  container.innerHTML = '';
  const entryMap = new Map(
    (state.menu?.entries || []).map(entry => [`${entry.day_index}-${entry.meal_type}`, entry])
  );
  const todayIso = toIsoDate(new Date());
  const weekIso = toIsoDate(state.weekStart);
  const draft = state.menuDrafts[weekIso] || {};
  const slotEntry = (dayIndex, mealType) => {
    const key = `${dayIndex}-${mealType}`;
    return key in draft ? { dish_name: draft[key] } : entryMap.get(key);
  };

  days.forEach((dayName, dayIndex) => {
    const date = addDays(state.weekStart, dayIndex);
    const card = document.createElement('article');
    card.className = `day-card${toIsoDate(date) === todayIso ? ' today' : ''}`;
    card.innerHTML = `
      <div class="day-heading">
        <strong>${dayName}</strong>
        <span>${new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(date)}</span>
      </div>
      ${menuSlotHtml(dayIndex, 'lunch', slotEntry(dayIndex, 'lunch'))}
      ${menuSlotHtml(dayIndex, 'dinner', slotEntry(dayIndex, 'dinner'))}
    `;
    container.appendChild(card);
  });

  $$('.meal-slot input', container).forEach(input => {
    const slot = input.closest('.meal-slot');
    const rememberDraft = () => {
      (state.menuDrafts[weekIso] ||= {})[`${slot.dataset.day}-${slot.dataset.meal}`] = input.value;
    };
    input.addEventListener('input', () => { rememberDraft(); updateSlotActions(input); });
    input.addEventListener('change', () => { rememberDraft(); updateSlotActions(input); });
    updateSlotActions(input);
  });
}

function menuSlotHtml(dayIndex, mealType, entry) {
  return `
    <div class="meal-slot" data-day="${dayIndex}" data-meal="${mealType}">
      <label>${mealLabels[mealType]}</label>
      <input list="dish-suggestions" autocomplete="off" placeholder="Sin planificar" value="${escapeHtml(entry?.dish_name || '')}">
      <div class="slot-actions"></div>
    </div>
  `;
}

function findDishByName(name) {
  const target = normalize(name);
  return state.dishes.find(dish => normalize(dish.name) === target) || null;
}

function updateSlotActions(input) {
  const slot = input.closest('.meal-slot');
  const actions = $('.slot-actions', slot);
  const name = input.value.trim();
  const dish = findDishByName(name);
  actions.innerHTML = '';
  if (!name) return;

  if (dish?.recipe_id) {
    actions.innerHTML = `
      <button type="button" class="slot-link">Abrir receta</button>
      <span class="slot-status">Receta enlazada</span>
    `;
    $('.slot-link', actions).addEventListener('click', () => openRecipeDetail(dish.recipe_id).catch(handleError));
  } else {
    actions.innerHTML = `
      <button type="button" class="slot-create">＋ Crear receta</button>
      <span class="slot-status">${dish ? 'Plato guardado' : 'Plato nuevo'}</span>
    `;
    $('.slot-create', actions).addEventListener('click', () => openRecipeForm(null, name));
  }
}

async function saveMenu() {
  const entries = $$('.meal-slot').map(slot => {
    const input = $('input', slot);
    const name = input.value.trim();
    if (!name) return null;
    const dish = findDishByName(name);
    return {
      day_index: Number(slot.dataset.day),
      meal_type: slot.dataset.meal,
      dish_name: name,
      recipe_id: dish?.recipe_id || null
    };
  }).filter(Boolean);

  const weekIso = toIsoDate(state.weekStart);
  state.menu = await apiFetch(`/menus/${weekIso}`, {
    method: 'PUT',
    body: JSON.stringify({ entries })
  });
  delete state.menuDrafts[weekIso];
  await loadDishes();
  renderMenu();
  showToast('Menú semanal guardado.');
}

function changeWeek(daysToAdd) {
  state.weekStart = addDays(state.weekStart, daysToAdd);
  loadMenu().catch(handleError);
}

// LISTA DE LA COMPRA
let storage = null;
try { storage = window.localStorage; } catch (_error) { /* almacenamiento bloqueado */ }
const outbox = ShoppingOutbox.createOutbox({ storage, onChange: () => renderSyncStatus() });
let syncPromise = null;

const lookupCategory = name => IngredientKey.findSimilar(name, state.ingredients)?.category ?? null;

async function loadIngredients() {
  state.ingredients = await apiFetch('/ingredients?limit=1000');
  $('#ingredient-suggestions').innerHTML = state.ingredients
    .map(item => `<option value="${escapeHtml(item.name)}"></option>`).join('');
}

// Pide la lista al servidor; sin conexión usa la última guardada. Devuelve true si había conexión.
async function fetchShoppingServerList() {
  try {
    state.shoppingServer = await apiFetch('/shopping/active');
    outbox.saveCache(state.shoppingServer);
    state.offline = false;
    return true;
  } catch (error) {
    if (!error.offline) throw error;
    state.offline = true;
    const cached = outbox.loadCache();
    if (!cached) throw new Error('Sin conexión y todavía no hay una lista guardada en este dispositivo.');
    state.shoppingServer = cached;
    return false;
  }
}

// Lo que se ve = lista del servidor + cambios aún sin enviar
function refreshShoppingView() {
  state.shoppingList = ShoppingOutbox.applyOps(state.shoppingServer, outbox.pending(), lookupCategory);
  renderShoppingList();
  renderSyncStatus();
}

async function loadShoppingList() {
  const online = await fetchShoppingServerList();
  refreshShoppingView();
  if (online && outbox.count()) syncShopping();
}

function sendShoppingOp(op) {
  const json = body => ({ body: JSON.stringify(body) });
  let request;
  if (op.type === 'add') request = apiFetch(`/shopping/${op.listId}/items`, { method: 'POST', ...json({ name: op.name, quantity: op.quantity, unit: op.unit }) });
  else if (op.type === 'toggle') request = apiFetch(`/shopping/items/${op.itemId}`, { method: 'PATCH', ...json({ is_purchased: op.purchased }) });
  else if (op.type === 'edit') request = apiFetch(`/shopping/items/${op.itemId}`, { method: 'PATCH', ...json({ quantity: op.quantity, unit: op.unit }) });
  else if (op.type === 'delete') request = apiFetch(`/shopping/items/${op.itemId}`, { method: 'DELETE' });
  else if (op.type === 'clear') request = apiFetch(`/shopping/${op.listId}/purchased`, { method: 'DELETE' });
  else return Promise.resolve(null);
  // Si el elemento o la lista ya no existen, la operación ya no tiene nada que hacer
  return request.catch(error => {
    if (error.status === 404 && op.type !== 'add') return null;
    throw error;
  });
}

// Envía los cambios pendientes y vuelve a pedir la lista. Una sola sincronización a la vez.
function syncShopping() {
  if (!syncPromise) {
    syncPromise = (async () => {
      renderSyncStatus();
      const hadAdds = outbox.pending().some(op => op.type === 'add');
      const result = await outbox.flush(sendShoppingOp);
      state.offline = result.offline;
      try { await fetchShoppingServerList(); } catch (_error) { /* se queda lo que hubiera */ }
      refreshShoppingView();
      if (hadAdds && !result.offline) loadIngredients().catch(() => {});
      for (const { op, error } of result.dropped) {
        showToast(`No se pudo guardar un cambio (${op.name || 'ingrediente'}): ${error.message}`, 'error');
      }
    })().finally(() => { syncPromise = null; renderSyncStatus(); });
  }
  return syncPromise;
}

function renderSyncStatus() {
  const banner = $('#shopping-sync');
  if (!banner) return;
  const count = outbox.count();
  const offline = state.offline || navigator.onLine === false;
  const syncing = Boolean(syncPromise) && !offline;
  banner.classList.toggle('hidden', !count && !offline);
  banner.classList.toggle('offline', offline);
  const changes = `${count} ${count === 1 ? 'cambio' : 'cambios'}`;
  let text = '';
  if (offline) text = count ? `Sin conexión (o sesión caducada) · ${changes} sin enviar. Se enviarán solos al volver; si no, recarga la página para entrar de nuevo.` : 'Sin conexión · mostrando la última lista guardada.';
  else if (count) text = syncing ? `Sincronizando ${changes}…` : `${changes} sin enviar.`;
  $('#shopping-sync-text').textContent = text;
  $('#shopping-sync-retry').classList.toggle('hidden', !count || syncing);
}

function queueShoppingOp(op) {
  if (!state.shoppingList) {
    showToast('Abre la lista de la compra con conexión al menos una vez.', 'error');
    return;
  }
  const saved = outbox.enqueue({ ...op, listId: state.shoppingList.id });
  refreshShoppingView();
  syncShopping();
  if (!saved) showToast('Este dispositivo no puede guardar el cambio: no recargues hasta que se envíe.', 'error');
}

function renderShoppingList() {
  const list = state.shoppingList;
  $('#shopping-title').textContent = list?.name || 'Lista de la compra';
  const items = list?.items || [];
  const pending = items.filter(item => !item.is_purchased).length;
  $('#shopping-counter').textContent = `${pending} ${pending === 1 ? 'pendiente' : 'pendientes'} · ${items.length} en total`;
  $('#shopping-empty').classList.toggle('hidden', items.length > 0);
  $('#clear-purchased').disabled = !items.some(item => item.is_purchased);

  const container = $('#shopping-tags');
  container.innerHTML = '';
  for (const section of groupShoppingItems(items)) {
    const heading = document.createElement('h3');
    heading.className = 'shopping-section';
    heading.innerHTML = `${escapeHtml(section.title)} <span>${section.items.length}</span>`;
    const tags = document.createElement('div');
    tags.className = 'shopping-section-tags';
    container.append(heading, tags);
    renderShoppingTags(tags, section.items);
  }
}

// Pendientes agrupados por categoría (en el orden del súper) y, al final, los comprados
const CATEGORY_ORDER = [
  'Verduras y hortalizas', 'Fruta', 'Carne', 'Pescado y marisco', 'Lácteos y huevos',
  'Pasta, arroz y legumbres', 'Pan y harinas', 'Despensa', 'Especias y condimentos', 'Congelados',
  'Platos preparados', 'Bebidas', 'Limpieza e higiene'
];
const LAST_CATEGORY = 'Otros';

function groupShoppingItems(items) {
  // Categorías conocidas por orden; las demás (nuevas) por orden alfabético; "Otros" al final
  const rank = category => {
    if (category === LAST_CATEGORY) return Number.MAX_SAFE_INTEGER;
    const index = CATEGORY_ORDER.indexOf(category);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };
  const byCategory = new Map();
  for (const item of items.filter(entry => !entry.is_purchased)) {
    const category = item.category || LAST_CATEGORY;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(item);
  }
  const sections = [...byCategory.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], 'es'))
    .map(([title, list]) => ({ title, items: list }));
  const purchased = items.filter(entry => entry.is_purchased);
  if (purchased.length) sections.push({ title: 'Comprados', items: purchased });
  return sections;
}

function renderShoppingTags(tags, items) {
  for (const item of items) {
    const tag = document.createElement('div');
    tag.className = `shopping-tag${item.is_purchased ? ' purchased' : ''}${item.pending ? ' pending' : ''}`;
    tag.dataset.itemId = item.id;
    const quantity = [formatNumber(item.quantity), item.unit].filter(Boolean).join(' ');
    tag.innerHTML = `
      <span class="tag-check">✓</span>
      <strong>${escapeHtml(item.ingredient_name)}</strong>
      ${quantity ? `<span class="tag-quantity">${escapeHtml(quantity)}</span>` : ''}
      <button class="tag-edit" type="button" aria-label="Editar cantidad">✎</button>
      <button class="tag-delete" type="button" aria-label="Eliminar">×</button>
    `;
    tag.addEventListener('click', event => {
      if (event.target.closest('.tag-delete, .tag-edit')) return;
      if (tag.dataset.longPressed) { delete tag.dataset.longPressed; return; }
      toggleShoppingItem(item).catch(handleError);
    });
    $('.tag-edit', tag).addEventListener('click', () => openShoppingEdit(item));
    enableLongPress(tag, () => openShoppingEdit(item));
    $('.tag-delete', tag).addEventListener('click', () => deleteShoppingItem(item.id).catch(handleError));
    tags.appendChild(tag);
  }
}

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(number);
}

const parseQuantity = value => {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// "¿Quieres decir «Tomate»?" cuando lo escrito se parece a un ingrediente que ya existe
function updateIngredientHint() {
  const typed = $('#shopping-ingredient').value.trim();
  const similar = typed ? IngredientKey.findSimilar(typed, state.ingredients) : null;
  const differs = similar && similar.name.toLocaleLowerCase('es') !== typed.toLocaleLowerCase('es');
  $('#shopping-ingredient-hint').classList.toggle('hidden', !differs);
  if (differs) $('#shopping-ingredient-hint-text').textContent = `¿Quieres decir «${similar.name}»?`;
}

async function addShoppingItem() {
  const typed = $('#shopping-ingredient').value.trim();
  if (!typed) return showToast('Escribe un ingrediente.', 'error');
  const similar = IngredientKey.findSimilar(typed, state.ingredients);
  const name = similar ? similar.name : typed;
  queueShoppingOp({
    type: 'add',
    tempId: ShoppingOutbox.newTempId(),
    name,
    quantity: parseQuantity($('#shopping-quantity').value),
    unit: $('#shopping-unit').value.trim()
  });
  if (similar && name.toLocaleLowerCase('es') !== typed.toLocaleLowerCase('es')) {
    showToast(`Añadido como «${name}», que ya existía.`);
  }
  $('#shopping-ingredient').value = '';
  $('#shopping-quantity').value = '';
  $('#shopping-unit').value = '';
  updateIngredientHint();
  $('#shopping-ingredient').focus();
}

// Pulsación larga (táctil/lápiz) o clic derecho (ratón) para editar
function enableLongPress(element, callback) {
  let timer;
  let startX = 0;
  let startY = 0;
  const cancel = () => clearTimeout(timer);

  element.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || event.target.closest('.tag-delete, .tag-edit')) return;
    startX = event.clientX;
    startY = event.clientY;
    cancel();
    timer = setTimeout(() => {
      element.dataset.longPressed = '1';
      if (navigator.vibrate) navigator.vibrate(30);
      callback();
    }, 500);
  });
  element.addEventListener('pointermove', event => {
    if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) cancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(name => element.addEventListener(name, () => {
    cancel();
    // Si el navegador no genera el clic tras la pulsación larga, no dejar la marca colgada
    if (element.dataset.longPressed) setTimeout(() => delete element.dataset.longPressed, 400);
  }));
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    cancel();
    if (event.pointerType !== 'touch' && !element.dataset.longPressed) callback();
  });
}

function openShoppingEdit(item) {
  $('#shopping-edit-id').value = item.id;
  $('#shopping-edit-name').textContent = item.ingredient_name;
  $('#shopping-edit-quantity').value = item.quantity ?? '';
  $('#shopping-edit-unit').value = item.unit || '';
  openModal('shopping-edit-modal');
  setTimeout(() => {
    const input = $('#shopping-edit-quantity');
    input.focus();
    input.select();
  }, 50);
}

function stepShoppingQuantity(delta) {
  const input = $('#shopping-edit-quantity');
  const next = Math.max(0, (Number(input.value) || 0) + delta);
  input.value = Math.round(next * 100) / 100;
}

async function saveShoppingEdit(event) {
  event.preventDefault();
  queueShoppingOp({
    type: 'edit',
    itemId: $('#shopping-edit-id').value,
    quantity: parseQuantity($('#shopping-edit-quantity').value),
    unit: $('#shopping-edit-unit').value.trim()
  });
  closeModal('shopping-edit-modal');
}

async function toggleShoppingItem(item) {
  queueShoppingOp({ type: 'toggle', itemId: item.id, purchased: !item.is_purchased });
}

async function deleteShoppingItem(itemId) {
  queueShoppingOp({ type: 'delete', itemId });
}

async function clearPurchased() {
  if (!state.shoppingList?.items.some(item => item.is_purchased)) return;
  queueShoppingOp({ type: 'clear' });
  showToast('Ingredientes comprados eliminados.');
}

// Acciones que necesitan al servidor: primero se envía lo pendiente para mantener el orden
async function flushBeforeServerAction() {
  if (!outbox.count()) return;
  await syncShopping();
  if (outbox.count()) throw new Error('Hay cambios sin enviar. Inténtalo de nuevo cuando tengas conexión.');
}

async function createShoppingList() {
  const name = prompt('Nombre de la nueva lista:', 'Lista de la compra');
  if (name === null) return;
  await flushBeforeServerAction();
  state.shoppingServer = await apiFetch('/shopping/new', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
  outbox.saveCache(state.shoppingServer);
  refreshShoppingView();
  showToast('Nueva lista creada.');
}

async function addRecipeToShopping() {
  if (!state.activeRecipe) return;
  if (!state.shoppingServer) await loadShoppingList();
  await flushBeforeServerAction();
  const servings = recipeServingsChanged() ? state.servingsTarget : undefined;
  state.shoppingServer = await apiFetch(
    `/shopping/${state.shoppingServer.id}/from-recipe/${state.activeRecipe.id}`,
    { method: 'POST', body: JSON.stringify({ servings }) }
  );
  outbox.saveCache(state.shoppingServer);
  refreshShoppingView();
  showToast(servings
    ? `Ingredientes para ${servings} ${servings === 1 ? 'ración' : 'raciones'} añadidos a la lista de la compra.`
    : 'Ingredientes añadidos a la lista de la compra.');
}

// GESTOR DE INGREDIENTES
const matchesSearch = (name, query) => !query || IngredientKey.ingredientKey(name).includes(query);

function usageText(item) {
  const parts = [];
  if (item.recipe_count) parts.push(`${item.recipe_count} ${item.recipe_count === 1 ? 'receta' : 'recetas'}`);
  if (item.shopping_count) parts.push(`${item.shopping_count} ${item.shopping_count === 1 ? 'lista' : 'listas'}`);
  return parts.join(' · ') || 'Sin usar';
}

async function loadManagerItems() {
  state.managerItems = await apiFetch('/ingredients/manage');
  const categories = new Set([...CATEGORY_ORDER, LAST_CATEGORY]);
  state.managerItems.forEach(item => item.category && categories.add(item.category));
  $('#category-suggestions').innerHTML = [...categories].sort((a, b) => a.localeCompare(b, 'es'))
    .map(category => `<option value="${escapeHtml(category)}"></option>`).join('');
  renderManager();
}

function renderManager() {
  const query = IngredientKey.ingredientKey($('#ingredient-manager-search').value);
  const unusedOnly = $('#ingredient-manager-unused').checked;
  const items = state.managerItems.filter(item =>
    matchesSearch(item.name, query) && (!unusedOnly || (!item.recipe_count && !item.shopping_count)));
  $('#ingredient-manager-count').textContent = `${items.length} de ${state.managerItems.length}`;

  const list = $('#ingredient-manager-list');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<p class="manager-empty">No hay ingredientes que coincidan.</p>';
    return;
  }
  for (const item of items) {
    const used = item.recipe_count || item.shopping_count;
    const row = document.createElement('div');
    row.className = 'manager-row';
    row.innerHTML = `
      <input class="manager-name" value="${escapeHtml(item.name)}" aria-label="Nombre de ${escapeHtml(item.name)}">
      <input class="manager-category" list="category-suggestions" value="${escapeHtml(item.category || '')}" placeholder="Sin categoría" aria-label="Categoría de ${escapeHtml(item.name)}">
      <span class="manager-usage">${escapeHtml(usageText(item))}</span>
      <div class="manager-actions">
        <button class="text-button manager-merge" type="button">Fusionar</button>
        <button class="text-button danger-text manager-delete" type="button" ${used ? 'disabled title="Está en uso: fusiónalo con otro"' : ''}>Eliminar</button>
      </div>
    `;
    $('.manager-name', row).addEventListener('change', event => saveIngredientChange(item, { name: event.target.value }, event.target).catch(handleError));
    $('.manager-category', row).addEventListener('change', event => saveIngredientChange(item, { category: event.target.value }, event.target).catch(handleError));
    $('.manager-merge', row).addEventListener('click', () => openMergeModal(item));
    $('.manager-delete', row).addEventListener('click', () => deleteManagedIngredient(item).catch(handleError));
    list.appendChild(row);
  }
}

// Tras tocar ingredientes se actualizan las listas que los muestran (sin avisar si falla, p. ej. sin red)
function refreshAfterIngredientChange() {
  loadIngredients().catch(() => {});
  loadShoppingList().catch(() => {});
}

async function saveIngredientChange(item, changes, input) {
  const clean = value => String(value ?? '').trim();
  const unchanged = 'name' in changes ? clean(changes.name) === item.name : clean(changes.category) === (item.category || '');
  if (unchanged) return;
  try {
    const updated = await apiFetch(`/ingredients/${item.id}`, { method: 'PATCH', body: JSON.stringify(changes) });
    item.name = updated.name;
    item.category = updated.category;
    showToast('Ingrediente actualizado.');
    refreshAfterIngredientChange();
  } catch (error) {
    input.value = 'name' in changes ? item.name : (item.category || '');
    throw error;
  }
}

async function deleteManagedIngredient(item) {
  if (!confirm(`¿Eliminar el ingrediente «${item.name}»?`)) return;
  await apiFetch(`/ingredients/${item.id}`, { method: 'DELETE' });
  state.managerItems = state.managerItems.filter(entry => entry.id !== item.id);
  renderManager();
  showToast('Ingrediente eliminado.');
  refreshAfterIngredientChange();
}

function openMergeModal(item) {
  state.mergeFrom = item;
  $('#merge-title').textContent = `«${item.name}»`;
  // Se parte de la primera palabra del nombre para encontrar rápido el equivalente (Tomates -> tomate)
  $('#merge-search').value = IngredientKey.ingredientKey(item.name).split(' ')[0] || '';
  renderMergeResults();
  openModal('merge-modal');
  setTimeout(() => $('#merge-search').focus(), 50);
}

function renderMergeResults() {
  const from = state.mergeFrom;
  const query = IngredientKey.ingredientKey($('#merge-search').value);
  const results = state.managerItems
    .filter(item => item.id !== from.id && matchesSearch(item.name, query))
    .slice(0, 30);
  const box = $('#merge-results');
  box.innerHTML = results.length ? '' : '<p class="manager-empty">No hay coincidencias.</p>';
  for (const item of results) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'merge-option';
    button.innerHTML = `<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.category || 'Sin categoría')} · ${escapeHtml(usageText(item))}</span>`;
    button.addEventListener('click', () => mergeIngredientInto(item).catch(handleError));
    box.appendChild(button);
  }
}

async function mergeIngredientInto(target) {
  const from = state.mergeFrom;
  const uses = usageText(from);
  const detail = uses === 'Sin usar' ? '' : ` (${uses})`;
  if (!confirm(`Se fusionará «${from.name}»${detail} en «${target.name}». «${from.name}» desaparecerá.\n\n¿Continuar?`)) return;
  await apiFetch(`/ingredients/${from.id}/merge`, { method: 'POST', body: JSON.stringify({ into: target.id }) });
  closeModal('merge-modal');
  state.mergeFrom = null;
  showToast(`«${from.name}» fusionado en «${target.name}».`);
  await loadManagerItems();
  refreshAfterIngredientChange();
}

// EVENTOS
$$('.nav-button').forEach(button => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});

$('#new-recipe-button').addEventListener('click', () => openRecipeForm());
$$('[data-action="new-recipe"]').forEach(button => button.addEventListener('click', () => openRecipeForm()));
$('#recipe-import-form').addEventListener('submit', event => importRecipeFromUrl(event).catch(handleError));
$('#add-ingredient-row').addEventListener('click', () => addIngredientRow());
$('#add-step-row').addEventListener('click', () => addStepRow());
$('#recipe-form').addEventListener('submit', event => saveRecipe(event).catch(handleError));
$('#edit-recipe').addEventListener('click', () => openRecipeForm(state.activeRecipe));
$('#delete-recipe').addEventListener('click', () => deleteActiveRecipe().catch(handleError));
$('#recipe-to-shopping').addEventListener('click', () => addRecipeToShopping().catch(handleError));

$('#recipe-search').addEventListener('input', event => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadRecipes(event.target.value.trim()).catch(handleError), 220);
});

$$('[data-close-modal]').forEach(element => {
  element.addEventListener('click', () => closeModal(element));
});

document.addEventListener('keydown', event => {
  // Escape cierra la ventana de más arriba (la última abierta)
  const open = $$('.modal.open').pop();
  if (event.key === 'Escape' && open) closeModal(open);
});

$('#previous-week').addEventListener('click', () => changeWeek(-7));
$('#next-week').addEventListener('click', () => changeWeek(7));
$('#current-week').addEventListener('click', () => {
  state.weekStart = getMonday(new Date());
  loadMenu().catch(handleError);
});
$('#save-menu-button').addEventListener('click', () => saveMenu().catch(handleError));

$('#add-shopping-item').addEventListener('click', () => addShoppingItem().catch(handleError));
$('#shopping-ingredient').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addShoppingItem().catch(handleError);
  }
});
$('#shopping-edit-form').addEventListener('submit', event => saveShoppingEdit(event).catch(handleError));
$('#shopping-edit-minus').addEventListener('click', () => stepShoppingQuantity(-1));
$('#shopping-edit-plus').addEventListener('click', () => stepShoppingQuantity(1));
$('#clear-purchased').addEventListener('click', () => clearPurchased().catch(handleError));
$('#new-shopping-list').addEventListener('click', () => createShoppingList().catch(handleError));
$('#shopping-ingredient').addEventListener('input', updateIngredientHint);
$('#shopping-ingredient-hint-use').addEventListener('click', () => {
  const similar = IngredientKey.findSimilar($('#shopping-ingredient').value.trim(), state.ingredients);
  if (similar) $('#shopping-ingredient').value = similar.name;
  updateIngredientHint();
  $('#shopping-ingredient').focus();
});

// Sincronización de la lista sin conexión: al volver la señal, al volver a la app y cada 20 s si queda algo
$('#shopping-sync-retry').addEventListener('click', () => syncShopping());
window.addEventListener('online', () => { state.offline = false; syncShopping(); });
window.addEventListener('offline', () => { state.offline = true; renderSyncStatus(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && outbox.count()) syncShopping();
});
setInterval(() => { if (outbox.count() && !syncPromise) syncShopping(); }, 20000);

// Raciones y modo cocina
$('#servings-minus').addEventListener('click', () => changeServings(-1));
$('#servings-plus').addEventListener('click', () => changeServings(1));
$('#servings-reset').addEventListener('click', () => {
  state.servingsTarget = state.activeRecipe.servings;
  renderDetailIngredients();
});
$('#cook-mode-toggle').addEventListener('click', () => setCookMode(!state.cookMode));
$('#detail-steps').addEventListener('click', event => {
  const step = event.target.closest('li');
  if (step && state.cookMode) step.classList.toggle('done');
});

// Gestor de ingredientes
$('#open-ingredient-manager').addEventListener('click', () => {
  $('#ingredient-manager-search').value = '';
  $('#ingredient-manager-unused').checked = false;
  openModal('ingredients-modal');
  loadManagerItems().catch(handleError);
});
$('#ingredient-manager-search').addEventListener('input', renderManager);
$('#ingredient-manager-unused').addEventListener('change', renderManager);
$('#merge-search').addEventListener('input', renderMergeResults);

setupSwipeNavigation();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

async function init() {
  const hashView = { '#recetas': 'recipes', '#menu': 'menu', '#compra': 'shopping' }[location.hash] || 'recipes';
  switchView(hashView);
  // Sin conexión alguna carga puede fallar; la lista de la compra siempre intenta usar su copia guardada
  const results = await Promise.allSettled([loadRecipes(), loadDishes(), loadIngredients(), loadShoppingList()]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) {
    if (failure.reason?.offline) state.offline = true;
    renderSyncStatus();
    if (!failure.reason?.offline) handleError(failure.reason);
  }
  if (hashView === 'menu') await loadMenu();
}

init().catch(handleError);
