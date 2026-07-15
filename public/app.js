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
  menu: null
};

const days = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const mealLabels = { lunch: 'Comida', dinner: 'Cena' };
let toastTimer;
let searchTimer;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se ha podido completar la operación.');
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
}

function switchView(viewName) {
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${viewName}`));
  $$('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === viewName));
  const hashMap = { recipes: 'recetas', menu: 'menu', shopping: 'compra' };
  history.replaceState(null, '', `#${hashMap[viewName]}`);

  if (viewName === 'menu') loadMenu().catch(handleError);
  if (viewName === 'shopping') loadShoppingList().catch(handleError);
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
  if (recipe) {
    $('#recipe-form-title').textContent = 'Editar receta';
    $('#recipe-id').value = recipe.id;
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

  $('#detail-ingredients').innerHTML = recipe.ingredients.map(item => {
    const quantity = [formatNumber(item.quantity), item.unit].filter(Boolean).join(' ');
    const detail = [quantity, item.notes].filter(Boolean).join(' · ');
    return `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(detail)}</span></li>`;
  }).join('') || '<li>No hay ingredientes guardados.</li>';

  $('#detail-steps').innerHTML = recipe.steps
    .map(step => `<li>${escapeHtml(step.instruction)}</li>`)
    .join('') || '<li>No hay pasos guardados.</li>';

  openModal('recipe-detail-modal');
}

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

  days.forEach((dayName, dayIndex) => {
    const date = addDays(state.weekStart, dayIndex);
    const card = document.createElement('article');
    card.className = `day-card${toIsoDate(date) === todayIso ? ' today' : ''}`;
    card.innerHTML = `
      <div class="day-heading">
        <strong>${dayName}</strong>
        <span>${new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(date)}</span>
      </div>
      ${menuSlotHtml(dayIndex, 'lunch', entryMap.get(`${dayIndex}-lunch`))}
      ${menuSlotHtml(dayIndex, 'dinner', entryMap.get(`${dayIndex}-dinner`))}
    `;
    container.appendChild(card);
  });

  $$('.meal-slot input', container).forEach(input => {
    input.addEventListener('input', () => updateSlotActions(input));
    input.addEventListener('change', () => updateSlotActions(input));
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

  state.menu = await apiFetch(`/menus/${toIsoDate(state.weekStart)}`, {
    method: 'PUT',
    body: JSON.stringify({ entries })
  });
  await loadDishes();
  renderMenu();
  showToast('Menú semanal guardado.');
}

function changeWeek(daysToAdd) {
  state.weekStart = addDays(state.weekStart, daysToAdd);
  loadMenu().catch(handleError);
}

// LISTA DE LA COMPRA
async function loadIngredients() {
  state.ingredients = await apiFetch('/ingredients?limit=200');
  $('#ingredient-suggestions').innerHTML = state.ingredients
    .map(item => `<option value="${escapeHtml(item.name)}"></option>`).join('');
}

async function loadShoppingList() {
  state.shoppingList = await apiFetch('/shopping/active');
  renderShoppingList();
}

function renderShoppingList() {
  const list = state.shoppingList;
  $('#shopping-title').textContent = list?.name || 'Lista de la compra';
  const items = list?.items || [];
  const pending = items.filter(item => !item.is_purchased).length;
  $('#shopping-counter').textContent = `${pending} ${pending === 1 ? 'pendiente' : 'pendientes'} · ${items.length} en total`;
  $('#shopping-empty').classList.toggle('hidden', items.length > 0);
  $('#clear-purchased').disabled = !items.some(item => item.is_purchased);

  const tags = $('#shopping-tags');
  tags.innerHTML = '';
  for (const item of items) {
    const tag = document.createElement('div');
    tag.className = `shopping-tag${item.is_purchased ? ' purchased' : ''}`;
    tag.dataset.itemId = item.id;
    const quantity = [formatNumber(item.quantity), item.unit].filter(Boolean).join(' ');
    tag.innerHTML = `
      <span class="tag-check">✓</span>
      <strong>${escapeHtml(item.ingredient_name)}</strong>
      ${quantity ? `<span class="tag-quantity">${escapeHtml(quantity)}</span>` : ''}
      <button class="tag-delete" type="button" aria-label="Eliminar">×</button>
    `;
    tag.addEventListener('click', event => {
      if (event.target.closest('.tag-delete')) return;
      toggleShoppingItem(item).catch(handleError);
    });
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

async function addShoppingItem() {
  const name = $('#shopping-ingredient').value.trim();
  if (!name) return showToast('Escribe un ingrediente.', 'error');
  await apiFetch(`/shopping/${state.shoppingList.id}/items`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      quantity: $('#shopping-quantity').value || null,
      unit: $('#shopping-unit').value.trim()
    })
  });
  $('#shopping-ingredient').value = '';
  $('#shopping-quantity').value = '';
  $('#shopping-unit').value = '';
  await Promise.all([loadShoppingList(), loadIngredients()]);
  $('#shopping-ingredient').focus();
}

async function toggleShoppingItem(item) {
  await apiFetch(`/shopping/items/${item.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_purchased: !item.is_purchased })
  });
  await loadShoppingList();
}

async function deleteShoppingItem(itemId) {
  await apiFetch(`/shopping/items/${itemId}`, { method: 'DELETE' });
  await loadShoppingList();
}

async function clearPurchased() {
  if (!state.shoppingList?.items.some(item => item.is_purchased)) return;
  await apiFetch(`/shopping/${state.shoppingList.id}/purchased`, { method: 'DELETE' });
  await loadShoppingList();
  showToast('Ingredientes comprados eliminados.');
}

async function createShoppingList() {
  const name = prompt('Nombre de la nueva lista:', 'Lista de la compra');
  if (name === null) return;
  state.shoppingList = await apiFetch('/shopping/new', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
  renderShoppingList();
  showToast('Nueva lista creada.');
}

async function addRecipeToShopping() {
  if (!state.activeRecipe) return;
  if (!state.shoppingList) await loadShoppingList();
  state.shoppingList = await apiFetch(
    `/shopping/${state.shoppingList.id}/from-recipe/${state.activeRecipe.id}`,
    { method: 'POST' }
  );
  showToast('Ingredientes añadidos a la lista de la compra.');
}

// EVENTOS
$$('.nav-button').forEach(button => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});

$('#new-recipe-button').addEventListener('click', () => openRecipeForm());
$$('[data-action="new-recipe"]').forEach(button => button.addEventListener('click', () => openRecipeForm()));
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
  if (event.key === 'Escape' && $('.modal.open')) closeModal($('.modal.open'));
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
$('#clear-purchased').addEventListener('click', () => clearPurchased().catch(handleError));
$('#new-shopping-list').addEventListener('click', () => createShoppingList().catch(handleError));

async function init() {
  const hashView = { '#recetas': 'recipes', '#menu': 'menu', '#compra': 'shopping' }[location.hash] || 'recipes';
  switchView(hashView);
  await Promise.all([loadRecipes(), loadDishes(), loadIngredients(), loadShoppingList()]);
  if (hashView === 'menu') await loadMenu();
}

init().catch(handleError);
