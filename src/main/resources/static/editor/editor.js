const BASE = '/game-data';
const SCALE = 4;

// --- Admin Auth ---
let editorSessionToken = localStorage.getItem('editorToken') || null;

// Auto-restore session if token exists
if (editorSessionToken) {
  document.getElementById('editor-login').style.display = 'none';
  document.getElementById('app').style.display = '';
}

document.getElementById('editor-login-btn').addEventListener('click', async () => {
  const email = document.getElementById('editor-email').value;
  const password = document.getElementById('editor-password').value;
  const errorEl = document.getElementById('editor-login-error');
  errorEl.textContent = '';
  try {
    const res = await fetch('/admin/account/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) throw new Error('Login failed');
    const data = await res.json();
    editorSessionToken = data.token || data.data?.token;
    if (!editorSessionToken) throw new Error('No token received');
    localStorage.setItem('editorToken', editorSessionToken);
    document.getElementById('editor-login').style.display = 'none';
    document.getElementById('app').style.display = '';
  } catch (e) {
    errorEl.textContent = e.message;
  }
});

document.getElementById('editor-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('editor-login-btn').click();
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  editorSessionToken = null;
  localStorage.removeItem('editorToken');
  document.getElementById('app').style.display = 'none';
  document.getElementById('editor-login').style.display = '';
});

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (editorSessionToken) h['Authorization'] = editorSessionToken;
  return h;
}

const SPRITE_SHEETS = [
  // Core game sheets
  'rotmg-tiles-all.png','rotmg-tiles.png','rotmg-tiles-1.png','rotmg-tiles-2.png',
  'rotmg-misc.png','rotmg-items.png','rotmg-items-1.png',
  'rotmg-projectiles.png','rotmg-abilities.png',
  'rotmg-bosses.png','rotmg-bosses-1.png',
  'rotmg-classes-0.png','rotmg-classes-1.png','rotmg-classes-2.png','rotmg-classes-3.png',
  // Lofi sheets
  'lofiEnvironment2.png','lofiEnvironment3.png',
  'lofiObj2.png','lofiObj3.png','lofiObjBig.png',
  'lofiProjs.png','lofiProjectiles.png',
  'lofi_dungeon_features.png',
  // New variable-size sheets
  'lofiWorld.png','lofiBosses16x16.png','lofiBosses16x20.png','lofiCharacter10x10.png',
  // Character sheets
  'chars8x8rBeach.png','chars8x8rHero2.png',
  'chars16x16dEncounters.png','chars16x16dEncounters2.png',
  // Dungeon sheets
  'd1Chars16x16r.png','d2LofiObj.png','d3Chars8x8r.png','d3LofiObj.png',
  'archbishopObjects16x16.png','autumnNexusObjects16x16.png',
  'battleOryxObjects8x8.png',
  'crystalCaveChars16x16.png','crystalCaveObjects8x8.png',
  'cursedLibraryChars16x16.png','cursedLibraryChars8x8.png','cursedLibraryObjects8x8.png',
  'epicHiveChars8x8.png',
  'fungalCavernObjects8x8.png',
  'lairOfDraconisChars8x8.png','lairOfDraconisObjects8x8.png',
  'lostHallsObjects8x8.png','magicWoodsObjects8x8.png','mountainTempleObjects8x8.png',
  'oryxHordeChars16x16.png','oryxHordeChars8x8.png',
  'secludedThicketChars16x16.png','summerNexusObjects8x8.png',
  // OpenRealm custom sheets
  'openrealm-items.png','openrealm-classes.png','openrealm-bosses.png',
];

let tiles = [];
let terrains = [];
let items = [];
let projGroups = [];
let maps = [];
let images = {};
let selectedTile = null;
let selectedTerrain = null;
let selectedItem = null;
let selectedProjGroup = null;
let selectedMap = null;
let mapBrushTileId = -1;
let mapPainting = false;
let pickMode = false;
let dirtyTiles = false;
let dirtyTerrains = false;
let dirtyItems = false;
let dirtyProjGroups = false;
let dirtyMaps = false;
let enemies = [];
let selectedEnemy = null;
let dirtyEnemies = false;
let lootGroups = [];
let lootTables = [];
let selectedLootGroup = null;
let dirtyLootGroups = false;
let dirtyLootTables = false;
let animations = [];
let selectedAnim = null;
let dirtyAnimations = false;
let portals = [];
let selectedPortal = null;
let dirtyPortals = false;
let setpieces = [];
let selectedSetPiece = null;
let dirtySetPieces = false;
let spBrushTileId = -1;
let spPainting = false;
let spLayer = '0';
let realmEvents = [];
let selectedRealmEvent = null;
let dirtyRealmEvents = false;
let animPickingFrame = null; // {animName, frameIdx} when picking a frame from the sheet
let currentSheet = SPRITE_SHEETS[0];
let gridSize = 8;
let gridHeight = 0; // 0 = same as gridSize
function getGridH() { return gridHeight > 0 ? gridHeight : gridSize; }
let activeTab = 'tiles';

// Navigation history stack for back-button support across editors
const navHistory = [];

function pushNav(state) {
  navHistory.push(state);
}

function popNav() {
  if (navHistory.length === 0) return null;
  return navHistory.pop();
}

function restoreNav() {
  const state = popNav();
  if (!state) return false;
  switchTab(state.tab);
  if (state.tab === 'enemies' && state.enemyId != null) {
    const enemy = enemies.find(e => e.enemyId === state.enemyId);
    if (enemy) selectEnemy(enemy);
  } else if (state.tab === 'items' && state.itemId != null) {
    const item = items.find(i => i.itemId === state.itemId);
    if (item) selectItem(item);
  }
  return true;
}

// DOM refs
const sheetSelect = document.getElementById('sheetSelect');
const gridSizeSelect = document.getElementById('gridSize');
const sheetCanvas = document.getElementById('sheetCanvas');
const sheetOverlay = document.getElementById('sheetOverlay');
const sheetInfo = document.getElementById('sheetInfo');
const hoverInfo = document.getElementById('hoverInfo');
const tileList = document.getElementById('tileList');
const tileCount = document.getElementById('tileCount');
const tileSearch = document.getElementById('tileSearch');
const tileDetail = document.getElementById('tileDetail');
const saveBtn = document.getElementById('saveBtn');
const saveStatus = document.getElementById('saveStatus');
const addTileBtn = document.getElementById('addTileBtn');
const pickBtn = document.getElementById('pickBtn');
const applyBtn = document.getElementById('applyBtn');
const deleteTileBtn = document.getElementById('deleteTileBtn');
const goToSheetBtn = document.getElementById('goToSheetBtn');

// ========== INIT ==========
async function init() {
  populateSheetSelect();
  await Promise.all([loadTiles(), loadTerrains(), loadItems(), loadProjGroups(), loadMaps(), loadEnemies(), loadLootData(), loadAnimations(), loadPortals(), loadSetPieces(), loadRealmEvents(), loadImages()]);
  renderSheet();
  renderTileList();
  renderTerrainList();
  renderItemList();
  renderMapList();
  renderEnemyList();
  renderPgTabList();
  renderPortalList();
  renderSetPieceList();
  renderRealmEventList();
  bindEvents();

  // Enhance manual ID inputs with searchable dropdowns
  enhanceWithDropdown('dmgProjGroup', projGroupOptions);
  enhanceWithDropdown('enemyAttackId', projGroupOptions);
  enhanceWithDropdown('dpWallTile', tileOptions);
  enhanceWithDropdown('dpBossEnemy', enemyOptions);
}

function populateSheetSelect() {
  SPRITE_SHEETS.forEach(name => {
    sheetSelect.appendChild(new Option(name, name));
    ['detailSprite', 'itemSprite', 'pgSprite', 'enemySprite', 'pgDetailSprite', 'portalSprite'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.appendChild(new Option(name, name));
    });
  });
}

async function loadTiles() {
  tiles = await (await fetch(`${BASE}/tiles.json`)).json();
  tiles.sort((a, b) => a.tileId - b.tileId);
  tileCount.textContent = tiles.length;
}

async function loadTerrains() {
  terrains = await (await fetch(`${BASE}/terrains.json`)).json();
  terrains.sort((a, b) => a.terrainId - b.terrainId);
  document.getElementById('terrainCount').textContent = terrains.length;
}

async function loadItems() {
  items = await (await fetch(`${BASE}/game-items.json`)).json();
  items.sort((a, b) => a.itemId - b.itemId);
  document.getElementById('itemCount').textContent = items.length;
}

async function loadProjGroups() {
  projGroups = await (await fetch(`${BASE}/projectile-groups.json`)).json();
  projGroups.sort((a, b) => a.projectileGroupId - b.projectileGroupId);
}

async function loadMaps() {
  maps = await (await fetch(`${BASE}/maps.json`)).json();
  maps.sort((a, b) => a.mapId - b.mapId);
  document.getElementById('mapCount').textContent = maps.length;
}

async function loadEnemies() {
    enemies = await (await fetch(`${BASE}/enemies.json`)).json();
    enemies.sort((a, b) => a.enemyId - b.enemyId);
    document.getElementById('enemyCount').textContent = enemies.length;
}

async function loadAnimations() {
    animations = await (await fetch(`${BASE}/animations.json`)).json();
    animations.sort((a, b) => a.objectId - b.objectId);
    document.getElementById('animCount').textContent = animations.length;
}

async function loadLootData() {
    lootGroups = await (await fetch(`${BASE}/loot-groups.json`)).json();
    lootGroups.sort((a, b) => a.lootGroupId - b.lootGroupId);
    lootTables = await (await fetch(`${BASE}/loot-tables.json`)).json();
    lootTables.sort((a, b) => a.enemyId - b.enemyId);
    document.getElementById('lgCount').textContent = lootGroups.length;
    document.getElementById('ltCount').textContent = lootTables.length;
}

function getProjGroupById(id) { return projGroups.find(g => g.projectileGroupId === id); }

async function loadImages() {
  await Promise.all(SPRITE_SHEETS.map(name => new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { images[name] = img; resolve(); };
    img.onerror = resolve;
    img.src = `${BASE}/${name}`;
  })));
}

function getTileById(id) { return tiles.find(t => t.tileId === id); }

// ========== SHEET RENDERING ==========
function renderSheet() {
  const img = images[currentSheet];
  if (!img) { sheetInfo.textContent = '(not loaded)'; return; }
  const w = img.width * SCALE, h = img.height * SCALE;
  sheetCanvas.width = w; sheetCanvas.height = h;
  sheetOverlay.width = w; sheetOverlay.height = h;

  const ctx = sheetCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, w, h);
  drawOverlay();

  const gh = getGridH();
  const cols = Math.floor(img.width / gridSize), rows = Math.floor(img.height / gh);
  const sizeLabel = gridSize === gh ? `${gridSize}px` : `${gridSize}x${gh}px`;
  let info = `(${img.width}x${img.height}px, ${cols}x${rows} cells @ ${sizeLabel})`;
  if (pickMode && animPickingFrame) {
    info += ' — Click a cell to assign frame';
  }
  sheetInfo.textContent = info;
}

function drawOverlay() {
  const img = images[currentSheet];
  if (!img) return;
  const w = img.width * SCALE, h = img.height * SCALE;
  const ctx = sheetOverlay.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const gsW = gridSize * SCALE, gsH = getGridH() * SCALE;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += gsW) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y <= h; y += gsH) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  // Highlight assigned tiles on this sheet
  const ss = gridSize, sh = getGridH();
  tiles.forEach(t => {
    if (t.spriteKey !== currentSheet) return;
    const px = t.col * ss * SCALE, py = t.row * sh * SCALE, szW = ss * SCALE, szH = sh * SCALE;
    const isSel = selectedTile && selectedTile.tileId === t.tileId;
    if (isSel) {
      ctx.strokeStyle = '#e94560'; ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, szW - 2, szH - 2);
      ctx.fillStyle = 'rgba(233,69,96,0.3)';
      ctx.fillRect(px, py, szW, szH);
    } else {
      ctx.fillStyle = 'rgba(100,200,255,0.15)';
      ctx.fillRect(px, py, szW, szH);
    }
  });
}

// ========== TILE PREVIEW ==========
function drawTilePreview(canvas, tile) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const img = images[tile.spriteKey];
  if (!img) return;
  const ss = gridSize, sh = getGridH();
  ctx.drawImage(img, tile.col * ss, tile.row * sh, ss, sh, 0, 0, canvas.width, canvas.height);
}

// ========== TILE LIST ==========
function renderTileList(filter = '') {
  tileList.innerHTML = '';
  const lower = filter.toLowerCase();
  tiles.forEach(t => {
    if (lower && !t.name.toLowerCase().includes(lower) && !String(t.tileId).includes(lower)) return;
    const row = document.createElement('div');
    row.className = 'tile-row' + (selectedTile && selectedTile.tileId === t.tileId ? ' selected' : '');

    const cvs = document.createElement('canvas'); cvs.width = 32; cvs.height = 32;
    drawTilePreview(cvs, t);

    const id = document.createElement('span'); id.className = 'tile-id'; id.textContent = t.tileId;
    const name = document.createElement('span'); name.className = 'tile-name'; name.textContent = t.name;
    const flags = document.createElement('span'); flags.className = 'tile-flags';
    if (t.data && t.data.hasCollision) flags.innerHTML += '<span class="flag flag-c">C</span>';
    if (t.data && t.data.slows) flags.innerHTML += '<span class="flag flag-s">S</span>';
    if (t.data && t.data.damaging) flags.innerHTML += '<span class="flag flag-d">D</span>';
    if (t.data && t.data.isWall) flags.innerHTML += '<span class="flag flag-w">W</span>';

    row.append(cvs, id, name, flags);
    row.addEventListener('click', () => selectTile(t));
    tileList.appendChild(row);
  });
}

function selectTile(tile) {
  selectedTile = tile;
  pickMode = false;
  pickBtn.classList.remove('active');
  pickBtn.textContent = 'Pick from Sheet';
  renderTileList(tileSearch.value);
  showDetail(tile);
  // Don't force-switch sheet - just update overlay to show selection if on same sheet
  drawOverlay();
}

function showDetail(tile) {
  tileDetail.style.display = 'block';
  document.getElementById('detailTitle').textContent = `Tile: ${tile.name} (ID ${tile.tileId})`;
  document.getElementById('detailId').value = tile.tileId;
  document.getElementById('detailName').value = tile.name;
  document.getElementById('detailSprite').value = tile.spriteKey;
  document.getElementById('detailRow').value = tile.row;
  document.getElementById('detailCol').value = tile.col;
  document.getElementById('detailSize').value = tile.size || 32;
  document.getElementById('detailCollision').checked = !!(tile.data && tile.data.hasCollision);
  document.getElementById('detailSlows').checked = !!(tile.data && tile.data.slows);
  document.getElementById('detailDamaging').checked = !!(tile.data && tile.data.damaging);
  document.getElementById('detailIsWall').checked = !!(tile.data && tile.data.isWall);
  updatePreview();
}

function updatePreview() {
  if (!selectedTile) return;
  const cvs = document.getElementById('previewCanvas');
  const spriteKey = document.getElementById('detailSprite').value;
  const row = parseInt(document.getElementById('detailRow').value) || 0;
  const col = parseInt(document.getElementById('detailCol').value) || 0;
  drawTilePreview(cvs, { spriteKey, row, col });
  document.getElementById('previewLabel').textContent = `[${spriteKey} @ r${row} c${col}]`;
}

function applyDetail() {
  if (!selectedTile) return;
  const tile = getTileById(selectedTile.tileId);
  if (!tile) return;
  tile.name = document.getElementById('detailName').value;
  tile.spriteKey = document.getElementById('detailSprite').value;
  tile.row = parseInt(document.getElementById('detailRow').value) || 0;
  tile.col = parseInt(document.getElementById('detailCol').value) || 0;
  tile.size = parseInt(document.getElementById('detailSize').value) || 32;
  if (!tile.data) tile.data = {};
  tile.data.hasCollision = document.getElementById('detailCollision').checked ? 1 : 0;
  tile.data.slows = document.getElementById('detailSlows').checked ? 1 : 0;
  tile.data.damaging = document.getElementById('detailDamaging').checked ? 1 : 0;
  tile.data.isWall = document.getElementById('detailIsWall').checked ? 1 : 0;
  selectedTile = tile;
  markDirty('tiles');
  renderTileList(tileSearch.value);
  drawOverlay();
}

function addTile() {
  const maxId = tiles.reduce((max, t) => Math.max(max, t.tileId), -1);
  const newTile = { tileId: maxId + 1, name: 'New_Tile_' + (maxId + 1), spriteKey: currentSheet, row: 0, col: 0, size: 32, data: { hasCollision: 0, slows: 0, damaging: 0, isWall: 0 } };
  tiles.push(newTile);
  tiles.sort((a, b) => a.tileId - b.tileId);
  tileCount.textContent = tiles.length;
  markDirty('tiles');
  selectTile(newTile);
}

function deleteTile() {
  if (!selectedTile) return;
  if (!confirm(`Delete tile ${selectedTile.tileId} (${selectedTile.name})?`)) return;
  tiles = tiles.filter(t => t.tileId !== selectedTile.tileId);
  tileCount.textContent = tiles.length;
  selectedTile = null;
  tileDetail.style.display = 'none';
  markDirty('tiles');
  renderTileList(tileSearch.value);
  drawOverlay();
}

function goToSheet() {
  if (!selectedTile) return;
  if (selectedTile.spriteKey !== currentSheet) {
    currentSheet = selectedTile.spriteKey;
    sheetSelect.value = currentSheet;
    renderSheet();
  }
  const ss = gridSize;
  const px = selectedTile.col * ss * SCALE, py = selectedTile.row * ss * SCALE;
  const scroll = document.querySelector('.sheet-scroll');
  scroll.scrollTo({ left: px - scroll.clientWidth / 2, top: py - scroll.clientHeight / 2, behavior: 'smooth' });
}

// ========== TERRAIN EDITOR ==========
function renderTerrainList(filter = '') {
  const list = document.getElementById('terrainSelectList');
  list.innerHTML = '';
  const lower = (filter || '').toLowerCase();
  terrains.forEach(t => {
    if (lower && !t.name.toLowerCase().includes(lower) && !String(t.terrainId).includes(lower)) return;
    const row = document.createElement('div');
    row.className = 'tile-row' + (selectedTerrain && selectedTerrain.terrainId === t.terrainId ? ' selected' : '');
    const id = document.createElement('span'); id.className = 'tile-id'; id.textContent = t.terrainId;
    const name = document.createElement('span'); name.className = 'tile-name'; name.textContent = t.name;
    const count = document.createElement('span'); count.style.cssText = 'color:#888;font-size:11px';
    const tileIds = t.tileGroups && t.tileGroups[0] ? t.tileGroups[0].tileIds : [];
    count.textContent = `(${tileIds.length} tiles)`;
    row.append(id, name, count);
    row.addEventListener('click', () => selectTerrain(t));
    list.appendChild(row);
  });
}

function selectTerrain(terrain) {
  selectedTerrain = terrain;
  document.getElementById('terrainSelectList').style.display = 'none';
  document.querySelector('#terrainsTab .tile-header').style.display = 'none';
  renderTerrainDetail();
}

function deselectTerrain() {
  selectedTerrain = null;
  document.getElementById('terrainDetail').style.display = 'none';
  document.getElementById('terrainSelectList').style.display = '';
  document.querySelector('#terrainsTab .tile-header').style.display = '';
  renderTerrainList(document.getElementById('terrainSearch').value);
}

function renderTerrainDetail() {
  const t = selectedTerrain;
  if (!t) return;
  const detail = document.getElementById('terrainDetail');
  detail.style.display = 'block';
  document.getElementById('terrainTitle').textContent = `${t.name} (ID ${t.terrainId})`;
  document.getElementById('terrainDims').textContent = `${t.width}x${t.height}, tileSize: ${t.tileSize}`;
  document.getElementById('terrainDensity').value = t.enemyDensity || 0;
  document.getElementById('terrainDensity').onchange = () => {
    t.enemyDensity = parseFloat(document.getElementById('terrainDensity').value) || 0;
    markDirty('terrains');
  };

  // ---- Tile Groups ----
  const container = document.getElementById('terrainTileGroups');
  container.innerHTML = '';
  if (!t.tileGroups || !t.tileGroups.length) { container.textContent = 'No tile groups'; }
  else {
    t.tileGroups.forEach((group, gi) => {
      const section = document.createElement('details');
      section.open = gi === 0;
      section.style.cssText = 'background:#1a1a2e;padding:6px;border-radius:4px;margin-bottom:6px';
      const summary = document.createElement('summary');
      summary.style.cssText = 'cursor:pointer;font-weight:600;font-size:13px';
      summary.textContent = `[${group.ordinal}] ${group.name || 'Group ' + gi} — ${(group.tileIds||[]).length} base, ${(group.decorationTileIds||[]).length} deco`;
      section.appendChild(summary);

      // Base tiles
      const baseLabel = document.createElement('div');
      baseLabel.style.cssText = 'font-size:11px;color:#8cf;margin:6px 0 2px';
      baseLabel.innerHTML = '<b>Base Tiles</b> (tileIds)';
      section.appendChild(baseLabel);
      renderTileIdList(section, group, 'tileIds', gi);

      // Add base tile button
      const addBaseBtn = document.createElement('button');
      addBaseBtn.className = 'btn-add'; addBaseBtn.textContent = '+ Add Base Tile';
      addBaseBtn.style.cssText = 'font-size:11px;padding:2px 6px;margin:4px 0';
      addBaseBtn.addEventListener('click', () => {
        openTilePicker((tileId) => {
          if (!group.tileIds) group.tileIds = [];
          if (group.tileIds.includes(tileId)) return;
          group.tileIds.push(tileId);
          if (!group.rarities) group.rarities = {};
          group.rarities[String(tileId)] = 0.5;
          markDirty('terrains');
          renderTerrainDetail();
        });
      });
      section.appendChild(addBaseBtn);

      // Decoration tiles
      const decoLabel = document.createElement('div');
      decoLabel.style.cssText = 'font-size:11px;color:#fc8;margin:8px 0 2px';
      decoLabel.innerHTML = '<b>Decoration Tiles</b> (decorationTileIds — collision layer)';
      section.appendChild(decoLabel);
      renderTileIdList(section, group, 'decorationTileIds', gi);

      // Add decoration tile button
      const addDecoBtn = document.createElement('button');
      addDecoBtn.className = 'btn-add'; addDecoBtn.textContent = '+ Add Decoration Tile';
      addDecoBtn.style.cssText = 'font-size:11px;padding:2px 6px;margin:4px 0';
      addDecoBtn.addEventListener('click', () => {
        openTilePicker((tileId) => {
          if (!group.decorationTileIds) group.decorationTileIds = [];
          if (group.decorationTileIds.includes(tileId)) return;
          group.decorationTileIds.push(tileId);
          if (!group.rarities) group.rarities = {};
          group.rarities[String(tileId)] = 0.03;
          markDirty('terrains');
          renderTerrainDetail();
        });
      });
      section.appendChild(addDecoBtn);

      container.appendChild(section);
    });
  }

  // ---- Zones ----
  const zonesContainer = document.getElementById('terrainZones');
  zonesContainer.innerHTML = '';
  if (t.zones && t.zones.length) {
    t.zones.forEach(zone => {
      const div = document.createElement('div');
      div.style.cssText = 'background:#1a1a2e;padding:6px;border-radius:4px;margin-bottom:4px;font-size:11px';
      div.innerHTML = `<b>${zone.displayName}</b> (${zone.zoneId}) — radius: ${zone.minRadius}-${zone.maxRadius}, difficulty: ${zone.difficulty}, tileGroup: ${zone.tileGroupOrdinal}, enemyGroup: ${zone.enemyGroupOrdinal}`;
      zonesContainer.appendChild(div);
    });
  } else {
    zonesContainer.textContent = 'No zones defined';
  }

  // ---- Enemy Groups ----
  const egContainer = document.getElementById('terrainEnemyGroups');
  egContainer.innerHTML = '';
  if (t.enemyGroups && t.enemyGroups.length) {
    t.enemyGroups.forEach(eg => {
      const div = document.createElement('div');
      div.style.cssText = 'background:#1a1a2e;padding:6px;border-radius:4px;margin-bottom:4px;font-size:11px';
      const enemyNames = (eg.enemyIds || []).map(id => {
        const e = enemies.find(en => en.enemyId === id);
        return e ? e.name : '#' + id;
      });
      div.innerHTML = `<b>[${eg.ordinal}] ${eg.name}</b>: ${enemyNames.join(', ')}`;
      egContainer.appendChild(div);
    });
  } else {
    egContainer.textContent = 'No enemy groups';
  }

  // ---- SetPiece Placements ----
  const spContainer = document.getElementById('terrainSetPieces');
  spContainer.innerHTML = '';
  if (t.setPieces && t.setPieces.length) {
    t.setPieces.forEach((sp, i) => {
      const model = setpieces.find(s => s.setPieceId === sp.setPieceId);
      const div = document.createElement('div');
      div.style.cssText = 'background:#1a1a2e;padding:6px;border-radius:4px;margin-bottom:4px;font-size:11px;display:flex;align-items:center;gap:6px';
      div.innerHTML = `<b>${model ? model.name : 'SetPiece #' + sp.setPieceId}</b> — count: ${sp.minCount}-${sp.maxCount}, zones: ${(sp.allowedZones||[]).join(', ')}`;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'tg-remove'; removeBtn.textContent = '\u00d7';
      removeBtn.addEventListener('click', () => {
        t.setPieces.splice(i, 1);
        markDirty('terrains');
        renderTerrainDetail();
      });
      div.appendChild(removeBtn);
      spContainer.appendChild(div);
    });
  }
  const addSpBtn = document.createElement('button');
  addSpBtn.className = 'btn-add'; addSpBtn.textContent = '+ Add SetPiece';
  addSpBtn.style.cssText = 'font-size:11px;padding:2px 6px;margin:4px 0';
  addSpBtn.addEventListener('click', () => {
    if (!t.setPieces) t.setPieces = [];
    t.setPieces.push({ setPieceId: 0, minCount: 1, maxCount: 3, allowedZones: [] });
    markDirty('terrains');
    renderTerrainDetail();
  });
  spContainer.appendChild(addSpBtn);
}

// Render a list of tile IDs (base or decoration) within a tileGroup
function renderTileIdList(parent, group, field, groupIdx) {
  const arr = group[field] || [];
  arr.forEach((tileId, idx) => {
    const tile = getTileById(tileId);
    const rarity = group.rarities ? (group.rarities[String(tileId)] || 0) : 0;
    const row = document.createElement('div');
    row.className = 'tg-tile-row';

    const cvs = document.createElement('canvas'); cvs.width = 24; cvs.height = 24;
    if (tile) drawTilePreview(cvs, tile);

    const idSpan = document.createElement('span'); idSpan.className = 'tile-id'; idSpan.textContent = tileId;
    const nameSpan = document.createElement('span'); nameSpan.className = 'tg-name';
    nameSpan.textContent = tile ? tile.name : '(unknown)';
    nameSpan.style.cursor = 'pointer'; nameSpan.title = 'Click to view in Tiles tab';
    nameSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tile) { switchTab('tiles'); selectTile(tile); }
    });

    const rarityInput = document.createElement('input');
    rarityInput.type = 'number'; rarityInput.min = 0; rarityInput.max = 1; rarityInput.step = 0.01;
    rarityInput.value = rarity; rarityInput.title = 'Rarity (0-1)';
    rarityInput.style.width = '60px';
    rarityInput.addEventListener('change', () => {
      if (!group.rarities) group.rarities = {};
      group.rarities[String(tileId)] = parseFloat(rarityInput.value) || 0;
      markDirty('terrains');
    });

    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'btn-add'; replaceBtn.textContent = 'Replace';
    replaceBtn.style.cssText = 'padding:2px 8px;font-size:11px';
    replaceBtn.addEventListener('click', () => {
      openTilePicker((newId) => {
        if (newId === tileId) return;
        group[field][idx] = newId;
        const oldRarity = group.rarities ? (group.rarities[String(tileId)] || 0) : 0;
        if (group.rarities) delete group.rarities[String(tileId)];
        if (!group.rarities) group.rarities = {};
        group.rarities[String(newId)] = oldRarity;
        markDirty('terrains');
        renderTerrainDetail();
      });
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'tg-remove'; removeBtn.textContent = '\u00d7'; removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      group[field].splice(idx, 1);
      if (group.rarities) delete group.rarities[String(tileId)];
      markDirty('terrains');
      renderTerrainDetail();
    });

    row.append(cvs, idSpan, nameSpan, rarityInput, replaceBtn, removeBtn);
    parent.appendChild(row);
  });
}

function addTileToTerrain() {
  // Legacy — kept for backward compat but renderTerrainDetail now has per-group add buttons
  if (!selectedTerrain) return;
  const group = selectedTerrain.tileGroups && selectedTerrain.tileGroups[0];
  if (!group) return;
  const rarity = parseFloat(document.getElementById('terrainAddRarity').value) || 0.05;
  openTilePicker((tileId) => {
    if (group.tileIds.includes(tileId)) { alert('Tile ' + tileId + ' already in this terrain'); return; }
    group.tileIds.push(tileId);
    if (!group.rarities) group.rarities = {};
    group.rarities[String(tileId)] = rarity;
    markDirty('terrains');
    renderTerrainDetail();
  });
}

// ========== ITEMS EDITOR ==========
function drawSpritePreview(canvas, spriteKey, row, col) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const img = images[spriteKey];
  if (!img) return;
  const ss = gridSize;
  ctx.drawImage(img, col * ss, row * ss, ss, ss, 0, 0, canvas.width, canvas.height);
}

function addItem() {
  const maxId = items.reduce((max, i) => Math.max(max, i.itemId), 0);
  const newItem = {
    itemId: maxId + 1, name: 'New_Item_' + (maxId + 1),
    description: '', spriteKey: 'rotmg-items.png', row: 0, col: 0,
    spriteSize: 8, tier: 0, slotType: 0, rateOfFire: 1,
    stats: { hp: 0, mp: 0, def: 0, att: 0, spd: 0, dex: 0, vit: 0, wis: 0 },
    damage: { min: 0, max: 0, projectileGroupId: -1 },
    effect: { effectId: 0, mpCost: 0, duration: 0, cooldownDuration: 0, self: false }
  };
  items.push(newItem);
  items.sort((a, b) => a.itemId - b.itemId);
  document.getElementById('itemCount').textContent = items.length;
  markDirty('items');
  selectItem(newItem);
}

function renderItemList(filter = '') {
  const list = document.getElementById('itemListView');
  list.innerHTML = '';
  const lower = (filter || '').toLowerCase();
  items.forEach(item => {
    if (lower && !item.name.toLowerCase().includes(lower) && !String(item.itemId).includes(lower)) return;
    const row = document.createElement('div');
    row.className = 'tile-row' + (selectedItem && selectedItem.itemId === item.itemId ? ' selected' : '');
    const cvs = document.createElement('canvas'); cvs.width = 28; cvs.height = 28;
    drawSpritePreview(cvs, item.spriteKey, item.row, item.col);
    const id = document.createElement('span'); id.className = 'tile-id'; id.textContent = item.itemId;
    const name = document.createElement('span'); name.className = 'tile-name'; name.textContent = item.name;
    const tier = document.createElement('span'); tier.style.cssText = 'color:#888;font-size:11px';
    tier.textContent = `T${item.tier}`;
    row.append(cvs, id, name, tier);
    row.addEventListener('click', () => selectItem(item));
    list.appendChild(row);
  });
}

function selectItem(item) {
  selectedItem = item;
  selectedProjGroup = null;
  document.getElementById('itemListView').style.display = 'none';
  document.querySelector('#itemsTab .tile-header').style.display = 'none';
  document.getElementById('projGroupDetail').style.display = 'none';
  showItemDetail(item);
}

function deselectItem() {
  selectedItem = null;
  document.getElementById('itemDetail').style.display = 'none';
  document.getElementById('projGroupDetail').style.display = 'none';
  document.getElementById('itemListView').style.display = '';
  document.querySelector('#itemsTab .tile-header').style.display = '';
  renderItemList(document.getElementById('itemSearch').value);
}

function showItemDetail(item) {
  const d = document.getElementById('itemDetail');
  d.style.display = 'block';
  document.getElementById('itemTitle').textContent = `${item.name} (ID ${item.itemId})`;
  document.getElementById('itemId').value = item.itemId;
  document.getElementById('itemName').value = item.name || '';
  document.getElementById('itemDesc').value = item.description || '';
  document.getElementById('itemSprite').value = item.spriteKey || '';
  document.getElementById('itemRow').value = item.row || 0;
  document.getElementById('itemCol').value = item.col || 0;
  document.getElementById('itemTier').value = item.tier || 0;
  document.getElementById('itemSlot').value = item.targetSlot != null ? item.targetSlot : -1;
  document.getElementById('itemClass').value = item.targetClass != null ? item.targetClass : -4;
  document.getElementById('itemFame').value = item.fameBonus || 0;
  document.getElementById('itemConsumable').checked = !!item.consumable;

  const s = item.stats || {};
  document.getElementById('statHp').value = s.hp || 0;
  document.getElementById('statMp').value = s.mp || 0;
  document.getElementById('statAtt').value = s.att || 0;
  document.getElementById('statDef').value = s.def || 0;
  document.getElementById('statSpd').value = s.spd || 0;
  document.getElementById('statDex').value = s.dex || 0;
  document.getElementById('statVit').value = s.vit || 0;
  document.getElementById('statWis').value = s.wis || 0;

  const dmg = item.damage || {};
  document.getElementById('dmgMin').value = dmg.min || 0;
  document.getElementById('dmgMax').value = dmg.max || 0;
  document.getElementById('dmgProjGroup').value = dmg.projectileGroupId != null ? dmg.projectileGroupId : -1;

  const eff = item.effect || {};
  document.getElementById('effectId').value = eff.effectId || 0;
  document.getElementById('effectMp').value = eff.mpCost || 0;
  document.getElementById('effectDur').value = eff.duration || 0;
  document.getElementById('effectCd').value = eff.cooldownDuration || 0;
  document.getElementById('effectSelf').checked = !!eff.self;
}

function applyItemDetail() {
  if (!selectedItem) return;
  const item = items.find(i => i.itemId === selectedItem.itemId);
  if (!item) return;
  item.name = document.getElementById('itemName').value;
  item.description = document.getElementById('itemDesc').value;
  item.spriteKey = document.getElementById('itemSprite').value;
  item.row = parseInt(document.getElementById('itemRow').value) || 0;
  item.col = parseInt(document.getElementById('itemCol').value) || 0;
  item.tier = parseInt(document.getElementById('itemTier').value) || 0;
  item.targetSlot = parseInt(document.getElementById('itemSlot').value);
  item.targetClass = parseInt(document.getElementById('itemClass').value);
  item.fameBonus = parseInt(document.getElementById('itemFame').value) || 0;
  item.consumable = document.getElementById('itemConsumable').checked;

  if (!item.stats) item.stats = {};
  item.stats.hp = parseInt(document.getElementById('statHp').value) || 0;
  item.stats.mp = parseInt(document.getElementById('statMp').value) || 0;
  item.stats.att = parseInt(document.getElementById('statAtt').value) || 0;
  item.stats.def = parseInt(document.getElementById('statDef').value) || 0;
  item.stats.spd = parseInt(document.getElementById('statSpd').value) || 0;
  item.stats.dex = parseInt(document.getElementById('statDex').value) || 0;
  item.stats.vit = parseInt(document.getElementById('statVit').value) || 0;
  item.stats.wis = parseInt(document.getElementById('statWis').value) || 0;

  const dmgMin = parseInt(document.getElementById('dmgMin').value) || 0;
  const dmgMax = parseInt(document.getElementById('dmgMax').value) || 0;
  const pgId = parseInt(document.getElementById('dmgProjGroup').value);
  if (dmgMax > 0 || pgId >= 0) {
    if (!item.damage) item.damage = {};
    item.damage.min = dmgMin;
    item.damage.max = dmgMax;
    item.damage.projectileGroupId = pgId;
  }

  const effId = parseInt(document.getElementById('effectId').value) || 0;
  const mpCost = parseInt(document.getElementById('effectMp').value) || 0;
  if (effId > 0 || mpCost > 0) {
    if (!item.effect) item.effect = {};
    item.effect.effectId = effId;
    item.effect.mpCost = mpCost;
    item.effect.duration = parseInt(document.getElementById('effectDur').value) || 0;
    item.effect.cooldownDuration = parseInt(document.getElementById('effectCd').value) || 0;
    item.effect.self = document.getElementById('effectSelf').checked;
  }

  selectedItem = item;
  markDirty('items');
}

// ========== PROJECTILE GROUP EDITOR ==========
const POS_MODES = { 0: 'TARGET_PLAYER', 1: 'RELATIVE', 2: 'ABSOLUTE' };
// Behavior flags — control projectile movement/rendering (stored in "flags" array)
const FLAG_NAMES = {
  10:'PLAYER_PROJ', 12:'PARAMETRIC', 13:'INV_PARAMETRIC', 20:'ORBITAL'
};
// On-hit status effects — applied to targets on collision (stored in "effects" array)
const EFFECT_NAMES = {
  1:'HEALING', 2:'PARALYZED', 3:'STUNNED', 4:'SPEEDY', 5:'HEAL',
  6:'INVINCIBLE', 11:'DAZED', 14:'DAMAGING', 15:'STASIS',
  16:'CURSED', 17:'POISONED', 18:'ARMORED', 19:'BERSERK'
};

// Searchable dropdown picker for ID fields.
// `options` = [{id, label}], `onSelect` = callback(id), `currentVal` = pre-selected id
function createSearchableSelect(options, onSelect, currentVal, placeholder) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;display:inline-block';
  const input = document.createElement('input');
  input.type = 'text'; input.placeholder = placeholder || 'Search...';
  input.style.cssText = 'width:160px;font-size:11px;padding:2px 4px;background:#1a1820;color:#e0d8c8;border:1px solid #333';
  const cur = options.find(o => o.id === currentVal);
  if (cur) input.value = cur.label;
  const list = document.createElement('div');
  list.style.cssText = 'display:none;position:absolute;top:100%;left:0;z-index:999;max-height:200px;overflow-y:auto;background:#1a1820;border:1px solid #555;width:240px';

  function renderOptions(filter) {
    list.innerHTML = '';
    const lower = (filter || '').toLowerCase();
    let count = 0;
    for (const opt of options) {
      if (lower && !opt.label.toLowerCase().includes(lower) && !String(opt.id).includes(lower)) continue;
      if (++count > 50) break;
      const row = document.createElement('div');
      row.style.cssText = 'padding:3px 6px;font-size:11px;cursor:pointer;color:#e0d8c8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      row.textContent = opt.label;
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = opt.label;
        list.style.display = 'none';
        onSelect(opt.id);
      });
      row.addEventListener('mouseenter', () => { row.style.background = '#333'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      list.appendChild(row);
    }
    if (count === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:4px 6px;font-size:10px;color:#888';
      empty.textContent = 'No matches';
      list.appendChild(empty);
    }
  }

  input.addEventListener('focus', () => { renderOptions(input.value); list.style.display = 'block'; });
  input.addEventListener('input', () => { renderOptions(input.value); list.style.display = 'block'; });
  input.addEventListener('blur', () => { setTimeout(() => { list.style.display = 'none'; }, 150); });
  wrapper.append(input, list);
  return wrapper;
}

// Effects editor — list of {effectId, duration} pairs for on-hit status effects
function createEffectsEditor(currentEffects, onChange) {
  const container = document.createElement('div');
  container.style.cssText = 'padding:2px 0';
  const effects = currentEffects || [];

  function rebuild() {
    container.innerHTML = '';
    effects.forEach((eff, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:2px';
      const sel = document.createElement('select');
      sel.style.cssText = 'font-size:10px;background:#12101a;color:#e0d8c8;border:1px solid #333';
      for (const [id, name] of Object.entries(EFFECT_NAMES).sort((a,b) => parseInt(a[0]) - parseInt(b[0]))) {
        const opt = new Option(`${name}(${id})`, id);
        opt.selected = parseInt(id) === eff.effectId;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => { eff.effectId = parseInt(sel.value); onChange(effects); });
      const durInput = document.createElement('input');
      durInput.type = 'number'; durInput.value = eff.duration || 3000;
      durInput.style.cssText = 'width:60px;font-size:10px;background:#12101a;color:#e0d8c8;border:1px solid #333';
      durInput.addEventListener('change', () => { eff.duration = parseInt(durInput.value) || 0; onChange(effects); });
      const durLabel = document.createElement('span');
      durLabel.style.cssText = 'font-size:9px;color:#888';
      durLabel.textContent = 'ms';
      const rmBtn = document.createElement('button');
      rmBtn.textContent = '\u00d7'; rmBtn.className = 'tg-remove';
      rmBtn.style.cssText = 'font-size:10px;padding:0 4px';
      rmBtn.addEventListener('click', () => { effects.splice(idx, 1); onChange(effects); rebuild(); });
      row.append(sel, durInput, durLabel, rmBtn);
      container.appendChild(row);
    });
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add'; addBtn.textContent = '+ Effect';
    addBtn.style.cssText = 'font-size:9px;padding:1px 6px';
    addBtn.addEventListener('click', () => { effects.push({effectId: 2, duration: 3000}); onChange(effects); rebuild(); });
    container.appendChild(addBtn);
  }
  rebuild();
  return container;
}

// Checkbox grid for projectile flags
function createFlagCheckboxes(currentFlags, onChange) {
  const container = document.createElement('div');
  container.style.cssText = 'display:flex;flex-wrap:wrap;gap:2px 8px;padding:2px 0';
  const sorted = Object.entries(FLAG_NAMES).sort((a,b) => parseInt(a[0]) - parseInt(b[0]));
  for (const [id, name] of sorted) {
    const flagId = parseInt(id);
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:2px;font-size:10px;color:#c8a86e;cursor:pointer;white-space:nowrap';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = (currentFlags || []).includes(flagId);
    cb.style.cssText = 'margin:0;cursor:pointer';
    cb.addEventListener('change', () => {
      const flags = [];
      container.querySelectorAll('input[type=checkbox]').forEach((box, i) => {
        if (box.checked) flags.push(parseInt(sorted[i][0]));
      });
      onChange(flags);
    });
    label.append(cb, document.createTextNode(`${name}(${id})`));
    container.appendChild(label);
  }
  return container;
}

// Helper to build option lists from loaded data
function itemOptions() { return items.map(i => ({id: i.itemId, label: `[${i.itemId}] ${i.name || 'Unnamed'}`})); }
function enemyOptions() { return enemies.map(e => ({id: e.enemyId, label: `[${e.enemyId}] ${e.name || 'Unnamed'}`})); }
function projGroupOptions() { return [{id: -1, label: '[-1] None/Scripted'}, ...projGroups.map(g => ({id: g.projectileGroupId, label: `[${g.projectileGroupId}] PG ${g.projectileGroupId}`}))]; }
function tileOptions() { return tiles.map(t => ({id: t.tileId, label: `[${t.tileId}] ${t.name || 'Tile ' + t.tileId}`})); }
function lootGroupOptions() { return lootGroups.map(g => ({id: g.lootGroupId, label: `[${g.lootGroupId}] ${g.name || 'Group ' + g.lootGroupId}`})); }

// Enhance a number input by adding a searchable dropdown next to it.
// The hidden input keeps working for data read/write; the dropdown sets its value.
function enhanceWithDropdown(inputId, optionsFn) {
  const input = document.getElementById(inputId);
  if (!input || input._enhanced) return;
  input._enhanced = true;
  input.style.width = '50px';
  const picker = createSearchableSelect(optionsFn(), (id) => {
    input.value = id;
    input.dispatchEvent(new Event('change'));
  }, parseInt(input.value), 'Search...');
  input.parentElement.appendChild(picker);
}

// Show a searchable picker dialog and return the selected ID via callback
function showPickerDialog(title, optionsFn, callback) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center';
  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#1a1820;border:1px solid #555;border-radius:6px;padding:12px;min-width:280px;max-height:400px;display:flex;flex-direction:column';
  const header = document.createElement('div');
  header.style.cssText = 'font-size:13px;color:#c8a86e;margin-bottom:8px;font-weight:bold';
  header.textContent = title;
  const searchInput = document.createElement('input');
  searchInput.type = 'text'; searchInput.placeholder = 'Type to search...';
  searchInput.style.cssText = 'width:100%;font-size:12px;padding:4px 6px;background:#12101a;color:#e0d8c8;border:1px solid #333;margin-bottom:6px;box-sizing:border-box';
  const listDiv = document.createElement('div');
  listDiv.style.cssText = 'overflow-y:auto;max-height:280px';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel'; cancelBtn.className = 'btn-pick';
  cancelBtn.style.cssText = 'margin-top:8px;align-self:flex-end';
  cancelBtn.addEventListener('click', () => document.body.removeChild(overlay));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });

  function renderList(filter) {
    listDiv.innerHTML = '';
    const lower = (filter || '').toLowerCase();
    const opts = optionsFn();
    let count = 0;
    for (const opt of opts) {
      if (lower && !opt.label.toLowerCase().includes(lower) && !String(opt.id).includes(lower)) continue;
      if (++count > 80) break;
      const row = document.createElement('div');
      row.style.cssText = 'padding:4px 8px;font-size:12px;cursor:pointer;color:#e0d8c8;border-bottom:1px solid #222';
      row.textContent = opt.label;
      row.addEventListener('click', () => { document.body.removeChild(overlay); callback(opt.id); });
      row.addEventListener('mouseenter', () => { row.style.background = '#333'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      listDiv.appendChild(row);
    }
  }
  searchInput.addEventListener('input', () => renderList(searchInput.value));
  renderList('');
  dialog.append(header, searchInput, listDiv, cancelBtn);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  searchInput.focus();
}

function viewProjGroup() {
  const pgId = parseInt(document.getElementById('dmgProjGroup').value);
  if (pgId < 0) return;
  const group = getProjGroupById(pgId);
  if (!group) { alert('Projectile group ' + pgId + ' not found'); return; }
  selectedProjGroup = group;
  document.getElementById('itemDetail').style.display = 'none';
  showProjGroupDetail(group);
}

function closeProjGroup() {
  selectedProjGroup = null;
  document.getElementById('projGroupDetail').style.display = 'none';
  // If there is navigation history, restore the previous editing context
  if (navHistory.length > 0) {
    restoreNav();
    return;
  }
  if (selectedItem) {
    document.getElementById('itemDetail').style.display = 'block';
  }
}

function showProjGroupDetail(group) {
  const d = document.getElementById('projGroupDetail');
  d.style.display = 'block';
  document.getElementById('projGroupTitle').textContent = `Projectile Group ${group.projectileGroupId}`;
  document.getElementById('pgId').value = group.projectileGroupId;
  document.getElementById('pgSprite').value = group.spriteKey || '';
  document.getElementById('pgRow').value = group.row || 0;
  document.getElementById('pgCol').value = group.col || 0;
  document.getElementById('pgAngleOffset').value = group.angleOffset || '';

  const cvs = document.getElementById('pgPreviewCanvas');
  drawSpritePreview(cvs, group.spriteKey, group.row || 0, group.col || 0);

  renderProjList(group);
}

function makeLabeledField(labelText, key, val, obj, dirtyKey) {
  const lbl = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = labelText;
  lbl.appendChild(span);
  const inp = document.createElement('input');
  inp.type = key === 'angle' ? 'text' : 'number';
  inp.value = val != null ? val : '';
  if (key !== 'angle' && key !== 'flags') inp.step = 'any';
  inp.addEventListener('change', () => {
    if (key === 'angle') { obj[key] = inp.value; }
    else if (key === 'flags') { obj[key] = inp.value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)); }
    else { obj[key] = parseFloat(inp.value) || 0; }
    markDirty(dirtyKey);
  });
  lbl.appendChild(inp);
  return lbl;
}

function renderProjList(group) {
  const container = document.getElementById('pgProjectiles');
  container.innerHTML = '';
  if (!group.projectiles) return;

  group.projectiles.forEach((p, idx) => {
    // Row 1: Mode, Angle, Damage, Range, Speed, remove
    const row1 = document.createElement('div');
    row1.className = 'proj-row';

    const numBadge = document.createElement('span');
    numBadge.className = 'proj-num';
    numBadge.textContent = '#' + (idx + 1);

    const modeLbl = document.createElement('label');
    const modeSpan = document.createElement('span'); modeSpan.textContent = 'Mode';
    modeLbl.appendChild(modeSpan);
    const modeSelect = document.createElement('select');
    [0, 2].forEach(m => { const opt = new Option(POS_MODES[m] || m, m); opt.selected = p.positionMode === m; modeSelect.appendChild(opt); });
    modeSelect.addEventListener('change', () => { p.positionMode = parseInt(modeSelect.value); markDirty('projGroups'); });
    modeLbl.appendChild(modeSelect);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'tg-remove'; removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => { group.projectiles.splice(idx, 1); markDirty('projGroups'); renderProjList(group); });

    row1.append(numBadge, modeLbl,
      makeLabeledField('Angle', 'angle', p.angle, p, 'projGroups'),
      makeLabeledField('Damage', 'damage', p.damage, p, 'projGroups'),
      makeLabeledField('Range', 'range', p.range, p, 'projGroups'),
      makeLabeledField('Speed', 'magnitude', p.magnitude, p, 'projGroups'),
      removeBtn);
    container.appendChild(row1);

    // Row 2: Size, Amplitude, Frequency, Flags
    const row2 = document.createElement('div');
    row2.className = 'proj-row row2';
    row2.style.borderTop = 'none';
    row2.style.marginTop = '-4px';
    row2.style.paddingTop = '0';
    const spacer = document.createElement('span'); spacer.textContent = '';
    row2.append(spacer,
      makeLabeledField('Size', 'size', p.size, p, 'projGroups'),
      makeLabeledField('Amplitude', 'amplitude', p.amplitude, p, 'projGroups'),
      makeLabeledField('Frequency', 'frequency', p.frequency, p, 'projGroups'));
    container.appendChild(row2);
    const flagRow = document.createElement('div');
    flagRow.className = 'proj-row row2';
    flagRow.style.cssText = 'border-top:none;margin-top:-4px;padding:2px 6px';
    const flagLabel = document.createElement('span');
    flagLabel.style.cssText = 'font-size:10px;color:#aaa;margin-right:4px';
    flagLabel.textContent = 'Flags:';
    flagRow.append(flagLabel, createFlagCheckboxes(p.flags, (flags) => { p.flags = flags; markDirty('projGroups'); }));
    container.appendChild(flagRow);
    // Effects editor (on-hit status effects with durations)
    const effectRow = document.createElement('div');
    effectRow.className = 'proj-row row2';
    effectRow.style.cssText = 'border-top:none;margin-top:-4px;padding:2px 6px';
    const effectLabel = document.createElement('span');
    effectLabel.style.cssText = 'font-size:10px;color:#aaa;margin-right:4px';
    effectLabel.textContent = 'Effects:';
    effectRow.append(effectLabel, createEffectsEditor(p.effects, (effects) => { p.effects = effects; markDirty('projGroups'); }));
    container.appendChild(effectRow);
  });
}

function addProjectile() {
  if (!selectedProjGroup) return;
  if (!selectedProjGroup.projectiles) selectedProjGroup.projectiles = [];
  selectedProjGroup.projectiles.push({
    projectileId: selectedProjGroup.projectiles.length,
    positionMode: 0, angle: '0', range: 6, size: 8, magnitude: 5.0,
    damage: 10, amplitude: 0, frequency: 0, flags: [0, 10]
  });
  markDirty('projGroups');
  renderProjList(selectedProjGroup);
}

function applyProjGroup() {
  if (!selectedProjGroup) return;
  const g = getProjGroupById(selectedProjGroup.projectileGroupId);
  if (!g) return;
  g.spriteKey = document.getElementById('pgSprite').value;
  g.row = parseInt(document.getElementById('pgRow').value) || 0;
  g.col = parseInt(document.getElementById('pgCol').value) || 0;
  g.angleOffset = document.getElementById('pgAngleOffset').value || undefined;
  markDirty('projGroups');
  const cvs = document.getElementById('pgPreviewCanvas');
  drawSpritePreview(cvs, g.spriteKey, g.row, g.col);
}

// ========== ENEMIES EDITOR ==========
function drawEnemySpritePreview(canvas, enemy) {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = images[enemy.spriteKey];
    if (!img) return;
    const ss = enemy.spriteSize || 8;
    const sh = enemy.spriteHeight || ss;
    ctx.drawImage(img, (enemy.col || 0) * ss, (enemy.row || 0) * sh, ss, sh, 0, 0, canvas.width, canvas.height);
}

function renderEnemyList(filter) {
    const list = document.getElementById('enemyListView');
    list.innerHTML = '';
    const lower = (filter || '').toLowerCase();
    enemies.forEach(enemy => {
        if (lower && !enemy.name.toLowerCase().includes(lower) && !String(enemy.enemyId).includes(lower)) return;
        const row = document.createElement('div');
        row.className = 'tile-row' + (selectedEnemy && selectedEnemy.enemyId === enemy.enemyId ? ' selected' : '');
        const cvs = document.createElement('canvas'); cvs.width = 32; cvs.height = 32;
        drawEnemySpritePreview(cvs, enemy);
        const id = document.createElement('span'); id.className = 'tile-id'; id.textContent = enemy.enemyId;
        const name = document.createElement('span'); name.className = 'tile-name'; name.textContent = enemy.name;
        const info = document.createElement('span'); info.style.cssText = 'color:#888;font-size:11px';
        info.textContent = `HP:${enemy.health} XP:${enemy.xp}`;
        const phaseCount = document.createElement('span'); phaseCount.style.cssText = 'color:#8cf;font-size:10px';
        phaseCount.textContent = enemy.phases ? `${enemy.phases.length}P` : '';
        row.append(cvs, id, name, info, phaseCount);
        row.addEventListener('click', () => selectEnemy(enemy));
        list.appendChild(row);
    });
}

function selectEnemy(enemy) {
    selectedEnemy = enemy;
    document.getElementById('enemyListView').style.display = 'none';
    document.querySelector('#enemiesTab .tile-header').style.display = 'none';
    showEnemyDetail(enemy);
}

function deselectEnemy() {
    selectedEnemy = null;
    document.getElementById('enemyDetail').style.display = 'none';
    document.getElementById('enemyListView').style.display = '';
    document.querySelector('#enemiesTab .tile-header').style.display = '';
    renderEnemyList(document.getElementById('enemySearch').value);
}

function showEnemyDetail(enemy) {
    const d = document.getElementById('enemyDetail');
    d.style.display = 'block';
    document.getElementById('enemyTitle').textContent = `${enemy.name} (ID ${enemy.enemyId})`;
    document.getElementById('enemyId').value = enemy.enemyId;
    document.getElementById('enemyName').value = enemy.name || '';
    document.getElementById('enemySprite').value = enemy.spriteKey || '';
    document.getElementById('enemyRow').value = enemy.row || 0;
    document.getElementById('enemyCol').value = enemy.col || 0;
    document.getElementById('enemySpriteSize').value = enemy.spriteSize || 8;
    document.getElementById('enemySpriteHeight').value = enemy.spriteHeight || 0;
    document.getElementById('enemySize').value = enemy.size || 32;
    document.getElementById('enemyAttackId').value = enemy.attackId != null ? enemy.attackId : -1;
    // Show context for attackId: -1 = scripted, >= 0 = projectile group
    const atkId = enemy.attackId != null ? enemy.attackId : -1;
    const atkInfo = document.getElementById('attackIdInfo');
    const atkBtn = document.getElementById('editAttackIdBtn');
    if (atkId === -1) {
        atkInfo.textContent = '(Server-scripted attack)';
        atkInfo.style.color = '#c8a86e';
        atkBtn.style.display = 'none';
    } else {
        const pg = getProjGroupById(atkId);
        atkInfo.textContent = pg ? '(Proj Group exists)' : '(Group not found!)';
        atkInfo.style.color = pg ? '#4a4' : '#e44';
        atkBtn.style.display = 'inline-block';
    }
    document.getElementById('enemyXp').value = enemy.xp || 0;
    document.getElementById('enemyHealth').value = enemy.health || 0;
    document.getElementById('enemyMaxSpeed').value = enemy.maxSpeed || 0;
    document.getElementById('enemyChaseRange').value = enemy.chaseRange || 0;
    document.getElementById('enemyAttackRange').value = enemy.attackRange || 0;
    const s = enemy.stats || {};
    document.getElementById('eStatHp').value = s.hp || 0;
    document.getElementById('eStatMp').value = s.mp || 0;
    document.getElementById('eStatAtt').value = s.att || 0;
    document.getElementById('eStatDef').value = s.def || 0;
    document.getElementById('eStatSpd').value = s.spd || 0;
    document.getElementById('eStatDex').value = s.dex || 0;
    document.getElementById('eStatVit').value = s.vit || 0;
    document.getElementById('eStatWis').value = s.wis || 0;
    updateEnemyPreview();
    renderEnemyLootSection(enemy);
    renderPhases(enemy);
}

function updateEnemyPreview() {
    if (!selectedEnemy) return;
    const cvs = document.getElementById('enemyPreviewCanvas');
    const spriteKey = document.getElementById('enemySprite').value;
    const row = parseInt(document.getElementById('enemyRow').value) || 0;
    const col = parseInt(document.getElementById('enemyCol').value) || 0;
    const ss = parseInt(document.getElementById('enemySpriteSize').value) || 8;
    const sh = parseInt(document.getElementById('enemySpriteHeight').value) || ss;
    const ctx = cvs.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    const img = images[spriteKey];
    if (img) ctx.drawImage(img, col * ss, row * sh, ss, sh, 0, 0, cvs.width, cvs.height);
    const sizeLabel = ss === sh ? `${ss}px` : `${ss}x${sh}px`;
    document.getElementById('enemyPreviewLabel').textContent = `[${spriteKey} @ r${row} c${col} ${sizeLabel}]`;
}

function applyEnemyDetail() {
    if (!selectedEnemy) return;
    const enemy = enemies.find(e => e.enemyId === selectedEnemy.enemyId);
    if (!enemy) return;
    enemy.name = document.getElementById('enemyName').value;
    enemy.spriteKey = document.getElementById('enemySprite').value;
    enemy.row = parseInt(document.getElementById('enemyRow').value) || 0;
    enemy.col = parseInt(document.getElementById('enemyCol').value) || 0;
    enemy.spriteSize = parseInt(document.getElementById('enemySpriteSize').value) || 8;
    enemy.spriteHeight = parseInt(document.getElementById('enemySpriteHeight').value) || 0;
    enemy.size = parseInt(document.getElementById('enemySize').value) || 32;
    enemy.attackId = parseInt(document.getElementById('enemyAttackId').value);
    enemy.xp = parseInt(document.getElementById('enemyXp').value) || 0;
    enemy.health = parseInt(document.getElementById('enemyHealth').value) || 0;
    enemy.maxSpeed = parseFloat(document.getElementById('enemyMaxSpeed').value) || 0;
    enemy.chaseRange = parseFloat(document.getElementById('enemyChaseRange').value) || 0;
    enemy.attackRange = parseFloat(document.getElementById('enemyAttackRange').value) || 0;
    if (!enemy.stats) enemy.stats = {};
    enemy.stats.hp = parseInt(document.getElementById('eStatHp').value) || 0;
    enemy.stats.mp = parseInt(document.getElementById('eStatMp').value) || 0;
    enemy.stats.att = parseInt(document.getElementById('eStatAtt').value) || 0;
    enemy.stats.def = parseInt(document.getElementById('eStatDef').value) || 0;
    enemy.stats.spd = parseInt(document.getElementById('eStatSpd').value) || 0;
    enemy.stats.dex = parseInt(document.getElementById('eStatDex').value) || 0;
    enemy.stats.vit = parseInt(document.getElementById('eStatVit').value) || 0;
    enemy.stats.wis = parseInt(document.getElementById('eStatWis').value) || 0;
    selectedEnemy = enemy;
    markDirty('enemies');
    renderEnemyList(document.getElementById('enemySearch').value);
}

function addEnemy() {
    const maxId = enemies.reduce((max, e) => Math.max(max, e.enemyId), 0);
    const newEnemy = {
        enemyId: maxId + 1, name: 'New_Enemy_' + (maxId + 1),
        spriteKey: 'lofi_char.png', row: 0, col: 0, spriteSize: 8,
        size: 32, attackId: -1, xp: 100, health: 100,
        maxSpeed: 1.4, chaseRange: 390, attackRange: 210,
        stats: { hp: 100, def: 0, dex: 5 },
        phases: []
    };
    enemies.push(newEnemy);
    enemies.sort((a, b) => a.enemyId - b.enemyId);
    document.getElementById('enemyCount').textContent = enemies.length;
    markDirty('enemies');
    selectEnemy(newEnemy);
}

function deleteEnemy() {
    if (!selectedEnemy) return;
    if (!confirm(`Delete enemy ${selectedEnemy.enemyId} (${selectedEnemy.name})?`)) return;
    enemies = enemies.filter(e => e.enemyId !== selectedEnemy.enemyId);
    document.getElementById('enemyCount').textContent = enemies.length;
    selectedEnemy = null;
    deselectEnemy();
    markDirty('enemies');
}

// --- Phase Editor ---
const MOVEMENT_TYPES = ['CHASE','ORBIT','STRAFE','CHARGE','FLEE','WANDER','ANCHOR','FIGURE_EIGHT'];
const MOVEMENT_FIELDS = {
    CHASE: ['speed'],
    ORBIT: ['speed','radius','direction'],
    STRAFE: ['speed','preferredRange'],
    CHARGE: ['speed','chargeDistanceMin','pauseMs'],
    FLEE: ['speed','fleeRange'],
    WANDER: ['speed'],
    ANCHOR: ['speed','anchorRadius'],
    FIGURE_EIGHT: ['speed','radius'],
};

function makePhaseInput(label, value, onChange, type, step) {
    const lbl = document.createElement('label');
    lbl.textContent = label + ': ';
    const inp = document.createElement('input');
    inp.type = type || 'text';
    inp.value = value;
    if (step) inp.step = step;
    inp.addEventListener('change', () => { onChange(inp.value); markDirty('enemies'); });
    lbl.appendChild(inp);
    return lbl;
}

function renderPhases(enemy) {
    const container = document.getElementById('enemyPhases');
    container.innerHTML = '';
    if (!enemy.phases) enemy.phases = [];

    enemy.phases.forEach((phase, idx) => {
        const card = document.createElement('div');
        card.className = 'phase-card';

        // Header
        const header = document.createElement('div');
        header.className = 'phase-header';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'phase-name';
        nameSpan.textContent = '#' + (idx + 1) + ': ' + (phase.name || 'unnamed');
        const hpSpan = document.createElement('span');
        hpSpan.className = 'phase-hp';
        hpSpan.textContent = 'HP<=' + ((phase.hpThreshold || 1.0) * 100).toFixed(0) + '%';

        const actions = document.createElement('span');
        actions.className = 'phase-actions';
        if (idx > 0) {
            const up = document.createElement('button'); up.textContent = '\u25B2'; up.title = 'Move up';
            up.addEventListener('click', (e) => { e.stopPropagation(); enemy.phases.splice(idx - 1, 0, enemy.phases.splice(idx, 1)[0]); markDirty('enemies'); renderPhases(enemy); });
            actions.appendChild(up);
        }
        if (idx < enemy.phases.length - 1) {
            const dn = document.createElement('button'); dn.textContent = '\u25BC'; dn.title = 'Move down';
            dn.addEventListener('click', (e) => { e.stopPropagation(); enemy.phases.splice(idx + 1, 0, enemy.phases.splice(idx, 1)[0]); markDirty('enemies'); renderPhases(enemy); });
            actions.appendChild(dn);
        }
        const rm = document.createElement('button'); rm.textContent = '\u00D7'; rm.title = 'Remove';
        rm.addEventListener('click', (e) => { e.stopPropagation(); enemy.phases.splice(idx, 1); markDirty('enemies'); renderPhases(enemy); });
        actions.appendChild(rm);

        header.append(nameSpan, hpSpan, actions);
        header.addEventListener('click', () => card.classList.toggle('collapsed'));

        // Body
        const body = document.createElement('div');
        body.className = 'phase-body';

        // Phase name + threshold fields
        const topFields = document.createElement('div');
        topFields.className = 'phase-move-fields';
        topFields.appendChild(makePhaseInput('Name', phase.name || '', (v) => { phase.name = v; nameSpan.textContent = '#' + (idx+1) + ': ' + v; }, 'text'));
        topFields.appendChild(makePhaseInput('HP Threshold', phase.hpThreshold || 1.0, (v) => { phase.hpThreshold = parseFloat(v) || 1.0; hpSpan.textContent = 'HP<=' + (phase.hpThreshold*100).toFixed(0) + '%'; }, 'number', '0.01'));
        body.appendChild(topFields);

        // Movement editor
        renderMovementEditor(body, phase);

        // Attack patterns editor
        renderAttackPatternsEditor(body, phase, enemy);

        card.append(header, body);
        container.appendChild(card);
    });
}

function renderMovementEditor(body, phase) {
    const h = document.createElement('h5'); h.textContent = 'Movement';
    body.appendChild(h);

    if (!phase.movement) phase.movement = { type: 'CHASE', speed: 1.4 };
    const mov = phase.movement;

    const wrap = document.createElement('div');
    wrap.className = 'phase-move-fields';

    // Type dropdown
    const typeLbl = document.createElement('label');
    typeLbl.textContent = 'Type: ';
    const typeSel = document.createElement('select');
    MOVEMENT_TYPES.forEach(t => { const o = new Option(t, t); o.selected = mov.type === t; typeSel.appendChild(o); });
    typeLbl.appendChild(typeSel);
    wrap.appendChild(typeLbl);

    const fieldsDiv = document.createElement('div');
    fieldsDiv.className = 'phase-move-fields';
    fieldsDiv.style.gridColumn = '1 / -1';

    function rebuildFields() {
        fieldsDiv.innerHTML = '';
        const fields = MOVEMENT_FIELDS[mov.type] || ['speed'];
        fields.forEach(f => {
            if (f === 'direction') {
                const lbl = document.createElement('label'); lbl.textContent = 'Direction: ';
                const sel = document.createElement('select');
                ['CW','CCW'].forEach(d => { const o = new Option(d,d); o.selected = mov.direction === d; sel.appendChild(o); });
                sel.addEventListener('change', () => { mov.direction = sel.value; markDirty('enemies'); });
                lbl.appendChild(sel);
                fieldsDiv.appendChild(lbl);
            } else {
                fieldsDiv.appendChild(makePhaseInput(f, mov[f] != null ? mov[f] : 0, (v) => { mov[f] = parseFloat(v) || 0; }, 'number', '0.1'));
            }
        });
    }

    typeSel.addEventListener('change', () => { mov.type = typeSel.value; markDirty('enemies'); rebuildFields(); });
    rebuildFields();
    wrap.appendChild(fieldsDiv);
    body.appendChild(wrap);
}

// Navigate to the Projectiles tab and open a specific group by ID
function navigateToProjGroup(pgId) {
    const group = getProjGroupById(pgId);
    if (!group) { alert('Projectile group ' + pgId + ' not found'); return; }
    // Save current editing context so back button returns here
    if (activeTab === 'enemies' && selectedEnemy) {
        pushNav({ tab: 'enemies', enemyId: selectedEnemy.enemyId });
    } else if (activeTab === 'items' && selectedItem) {
        pushNav({ tab: 'items', itemId: selectedItem.itemId });
    }
    switchTab('projgroups');
    selectPgTab(group);
}

function renderAttackPatternsEditor(body, phase, enemy) {
    const h = document.createElement('h5'); h.textContent = 'Attacks';
    body.appendChild(h);

    if (!phase.attacks) phase.attacks = [];
    const container = document.createElement('div');

    phase.attacks.forEach((atk, atkIdx) => {
        const row = document.createElement('div');
        row.className = 'attack-row';
        const badge = document.createElement('span'); badge.style.cssText = 'color:#c8a86e;font-weight:600';
        badge.textContent = '#' + (atkIdx + 1);

        function mkField(label, key, width, step) {
            const lbl = document.createElement('label'); lbl.textContent = label;
            const inp = document.createElement('input'); inp.type = 'number';
            inp.value = atk[key] != null ? atk[key] : '';
            inp.style.width = Math.max(70, Math.floor((width || 50) * 1.5)) + 'px';
            if (step) inp.step = step;
            inp.addEventListener('change', () => { atk[key] = parseFloat(inp.value) || 0; markDirty('enemies'); });
            lbl.appendChild(inp);
            return lbl;
        }

        const predLbl = document.createElement('label'); predLbl.textContent = 'Pred ';
        const predCb = document.createElement('input'); predCb.type = 'checkbox'; predCb.checked = !!atk.predictive;
        predCb.addEventListener('change', () => { atk.predictive = predCb.checked; markDirty('enemies'); });
        predLbl.appendChild(predCb);

        // Mirror checkbox
        const mirrorLbl = document.createElement('label'); mirrorLbl.textContent = 'Mirror ';
        const mirrorCb = document.createElement('input'); mirrorCb.type = 'checkbox'; mirrorCb.checked = !!atk.mirror;
        mirrorCb.addEventListener('change', () => { atk.mirror = mirrorCb.checked; markDirty('enemies'); });
        mirrorLbl.appendChild(mirrorCb);

        // AimMode dropdown
        const aimLbl = document.createElement('label'); aimLbl.textContent = 'Aim ';
        const aimSel = document.createElement('select');
        aimSel.style.cssText = 'width:70px;font-size:11px';
        ['PLAYER','RING','FIXED'].forEach(m => {
            const opt = document.createElement('option'); opt.value = m; opt.textContent = m;
            if ((atk.aimMode || 'PLAYER') === m) opt.selected = true;
            aimSel.appendChild(opt);
        });
        aimSel.addEventListener('change', () => { atk.aimMode = aimSel.value; markDirty('enemies'); });
        aimLbl.appendChild(aimSel);

        const rmBtn = document.createElement('button'); rmBtn.className = 'tg-remove'; rmBtn.textContent = '\u00D7';
        rmBtn.addEventListener('click', () => { phase.attacks.splice(atkIdx, 1); markDirty('enemies'); renderPhases(enemy); });

        // PG field with searchable dropdown + "Edit" link
        const pgWrapper = document.createElement('div');
        pgWrapper.style.cssText = 'display:flex;align-items:flex-end;gap:4px';
        const pgLabel = document.createElement('span');
        pgLabel.style.cssText = 'font-size:11px;color:#aaa';
        pgLabel.textContent = 'PG:';
        pgWrapper.appendChild(pgLabel);
        pgWrapper.appendChild(createSearchableSelect(projGroupOptions(), (id) => {
          atk.projectileGroupId = id; markDirty('enemies');
        }, atk.projectileGroupId, 'Proj Group...'));
        const editPgBtn = document.createElement('button');
        editPgBtn.className = 'btn-pick';
        editPgBtn.textContent = 'Edit';
        editPgBtn.style.cssText = 'font-size:10px;padding:2px 6px;height:22px';
        editPgBtn.addEventListener('click', () => navigateToProjGroup(atk.projectileGroupId));
        pgWrapper.appendChild(editPgBtn);

        row.append(badge,
            pgWrapper,
            mkField('Cooldown:', 'cooldownMs', 50),
            mkField('Burst:', 'burstCount', 35),
            mkField('Burst Delay:', 'burstDelayMs', 42),
            mkField('Angle Offset:', 'angleOffsetPerBurst', 42),
            mkField('Min Range:', 'minRange', 42),
            mkField('Max Range:', 'maxRange', 45),
            mkField('Shots:', 'shotCount', 35),
            mkField('Spread:', 'spreadAngle', 45, '0.01'),
            mkField('Src Noise:', 'sourceNoise', 45),
            aimLbl, predLbl, mirrorLbl, rmBtn
        );
        container.appendChild(row);
    });

    const addBtn = document.createElement('button'); addBtn.className = 'btn-add';
    addBtn.textContent = '+ Attack'; addBtn.style.cssText = 'margin-top:3px;font-size:11px';
    addBtn.addEventListener('click', () => {
        phase.attacks.push({ projectileGroupId: 0, cooldownMs: 1000, burstCount: 1, burstDelayMs: 100, aimMode: 'PLAYER', shotCount: 1, spreadAngle: 0, mirror: false, sourceNoise: 0 });
        markDirty('enemies');
        renderPhases(enemy);
    });
    container.appendChild(addBtn);
    body.appendChild(container);
}

function addPhase() {
    if (!selectedEnemy) return;
    if (!selectedEnemy.phases) selectedEnemy.phases = [];
    selectedEnemy.phases.push({
        name: 'phase_' + (selectedEnemy.phases.length + 1),
        hpThreshold: selectedEnemy.phases.length === 0 ? 1.0 : 0.5,
        movement: { type: 'CHASE', speed: 1.4 },
        attacks: []
    });
    markDirty('enemies');
    renderPhases(selectedEnemy);
}

// ========== PROJECTILE GROUPS TAB ==========
let selectedPgTab = null;

function renderPgTabList(filter) {
  const list = document.getElementById('pgListView');
  list.innerHTML = '';
  const lower = (filter || '').toLowerCase();
  document.getElementById('pgCount').textContent = projGroups.length;
  projGroups.forEach(group => {
    const idStr = String(group.projectileGroupId);
    const key = (group.spriteKey || '') + ' r' + (group.row||0) + ' c' + (group.col||0);
    if (lower && !idStr.includes(lower) && !key.toLowerCase().includes(lower)) return;
    const row = document.createElement('div');
    row.className = 'tile-row' + (selectedPgTab && selectedPgTab.projectileGroupId === group.projectileGroupId ? ' selected' : '');
    const cvs = document.createElement('canvas'); cvs.width = 32; cvs.height = 32;
    drawSpritePreview(cvs, group.spriteKey, group.row || 0, group.col || 0);
    const id = document.createElement('span'); id.className = 'tile-id'; id.textContent = group.projectileGroupId;
    const info = document.createElement('span'); info.className = 'tile-name';
    info.textContent = (group.spriteKey || '?') + ' r' + (group.row||0) + 'c' + (group.col||0);
    const projCount = document.createElement('span'); projCount.style.cssText = 'color:#8cf;font-size:10px';
    projCount.textContent = (group.projectiles ? group.projectiles.length : 0) + ' proj';
    const ao = document.createElement('span'); ao.style.cssText = 'color:#888;font-size:10px';
    ao.textContent = group.angleOffset ? group.angleOffset : '';
    row.append(cvs, id, info, projCount, ao);
    row.addEventListener('click', () => selectPgTab(group));
    list.appendChild(row);
  });
}

function selectPgTab(group) {
  selectedPgTab = group;
  document.getElementById('pgListView').style.display = 'none';
  document.querySelector('#projgroupsTab .tile-header').style.display = 'none';
  showPgTabDetail(group);
}

function deselectPgTab() {
  selectedPgTab = null;
  document.getElementById('pgDetail').style.display = 'none';
  // If there is navigation history, restore the previous editing context
  if (navHistory.length > 0) {
    restoreNav();
    return;
  }
  document.getElementById('pgListView').style.display = '';
  document.querySelector('#projgroupsTab .tile-header').style.display = '';
  renderPgTabList(document.getElementById('pgSearch').value);
}

function showPgTabDetail(group) {
  const d = document.getElementById('pgDetail');
  d.style.display = 'block';
  document.getElementById('pgDetailTitle').textContent = 'Projectile Group ' + group.projectileGroupId;
  document.getElementById('pgDetailId').value = group.projectileGroupId;
  document.getElementById('pgDetailSprite').value = group.spriteKey || '';
  document.getElementById('pgDetailRow').value = group.row || 0;
  document.getElementById('pgDetailCol').value = group.col || 0;
  document.getElementById('pgDetailAngleOffset').value = group.angleOffset || '';
  updatePgTabPreview();
  renderPgTabProjList(group);
}

function updatePgTabPreview() {
  if (!selectedPgTab) return;
  const cvs = document.getElementById('pgDetailPreview');
  const spriteKey = document.getElementById('pgDetailSprite').value;
  const row = parseInt(document.getElementById('pgDetailRow').value) || 0;
  const col = parseInt(document.getElementById('pgDetailCol').value) || 0;
  drawSpritePreview(cvs, spriteKey, row, col);
  document.getElementById('pgDetailPreviewLabel').textContent = '[' + spriteKey + ' @ r' + row + ' c' + col + ']';
}

function renderPgTabProjList(group) {
  const container = document.getElementById('pgDetailProjectiles');
  container.innerHTML = '';
  if (!group.projectiles) return;

  group.projectiles.forEach((p, idx) => {
    const numBadge = document.createElement('span');
    numBadge.className = 'proj-num';
    numBadge.textContent = '#' + (idx + 1);

    const modeLbl = document.createElement('label');
    const modeSpan = document.createElement('span'); modeSpan.textContent = 'Mode';
    modeLbl.appendChild(modeSpan);
    const modeSelect = document.createElement('select');
    [0, 2].forEach(m => { const opt = new Option(POS_MODES[m] || m, m); opt.selected = p.positionMode === m; modeSelect.appendChild(opt); });
    modeSelect.addEventListener('change', () => { p.positionMode = parseInt(modeSelect.value); markDirty('projGroups'); });
    modeLbl.appendChild(modeSelect);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'tg-remove'; removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => { group.projectiles.splice(idx, 1); markDirty('projGroups'); renderPgTabProjList(group); });

    const row1 = document.createElement('div');
    row1.className = 'proj-row';
    row1.append(numBadge, modeLbl,
      makeLabeledField('Angle', 'angle', p.angle, p, 'projGroups'),
      makeLabeledField('Damage', 'damage', p.damage, p, 'projGroups'),
      makeLabeledField('Range', 'range', p.range, p, 'projGroups'),
      makeLabeledField('Speed', 'magnitude', p.magnitude, p, 'projGroups'),
      removeBtn);
    container.appendChild(row1);

    const row2 = document.createElement('div');
    row2.className = 'proj-row row2';
    row2.style.borderTop = 'none'; row2.style.marginTop = '-4px'; row2.style.paddingTop = '0';
    const spacer = document.createElement('span');
    row2.append(spacer,
      makeLabeledField('Size', 'size', p.size, p, 'projGroups'),
      makeLabeledField('Amplitude', 'amplitude', p.amplitude, p, 'projGroups'),
      makeLabeledField('Frequency', 'frequency', p.frequency, p, 'projGroups'));
    container.appendChild(row2);
    const flagRow = document.createElement('div');
    flagRow.className = 'proj-row row2';
    flagRow.style.cssText = 'border-top:none;margin-top:-4px;padding:2px 6px';
    const flagLabel = document.createElement('span');
    flagLabel.style.cssText = 'font-size:10px;color:#aaa;margin-right:4px';
    flagLabel.textContent = 'Flags:';
    flagRow.append(flagLabel, createFlagCheckboxes(p.flags, (flags) => { p.flags = flags; markDirty('projGroups'); }));
    container.appendChild(flagRow);
    // Effects editor (on-hit status effects with durations)
    const effectRow = document.createElement('div');
    effectRow.className = 'proj-row row2';
    effectRow.style.cssText = 'border-top:none;margin-top:-4px;padding:2px 6px';
    const effectLabel = document.createElement('span');
    effectLabel.style.cssText = 'font-size:10px;color:#aaa;margin-right:4px';
    effectLabel.textContent = 'Effects:';
    effectRow.append(effectLabel, createEffectsEditor(p.effects, (effects) => { p.effects = effects; markDirty('projGroups'); }));
    container.appendChild(effectRow);
  });
}

function applyPgTabDetail() {
  if (!selectedPgTab) return;
  const g = getProjGroupById(selectedPgTab.projectileGroupId);
  if (!g) return;
  g.spriteKey = document.getElementById('pgDetailSprite').value;
  g.row = parseInt(document.getElementById('pgDetailRow').value) || 0;
  g.col = parseInt(document.getElementById('pgDetailCol').value) || 0;
  g.angleOffset = document.getElementById('pgDetailAngleOffset').value || undefined;
  markDirty('projGroups');
  updatePgTabPreview();
  renderPgTabList(document.getElementById('pgSearch').value);
}

function addPgTab() {
  const maxId = projGroups.reduce((max, g) => Math.max(max, g.projectileGroupId), 0);
  const newGroup = {
    projectileGroupId: maxId + 1, row: 0, col: 0,
    spriteKey: 'rotmg-projectiles.png', angleOffset: '0',
    projectiles: [{ projectileId: maxId + 1, positionMode: 0, angle: '0', range: 150, size: 16, magnitude: 5.0, damage: 25, amplitude: 0, frequency: 0, flags: [0] }]
  };
  projGroups.push(newGroup);
  projGroups.sort((a, b) => a.projectileGroupId - b.projectileGroupId);
  markDirty('projGroups');
  selectPgTab(newGroup);
}

function deletePgTab() {
  if (!selectedPgTab) return;
  if (!confirm('Delete projectile group ' + selectedPgTab.projectileGroupId + '?')) return;
  projGroups = projGroups.filter(g => g.projectileGroupId !== selectedPgTab.projectileGroupId);
  selectedPgTab = null;
  deselectPgTab();
  markDirty('projGroups');
}

function addPgTabProjectile() {
  if (!selectedPgTab) return;
  if (!selectedPgTab.projectiles) selectedPgTab.projectiles = [];
  selectedPgTab.projectiles.push({
    projectileId: selectedPgTab.projectileGroupId, positionMode: 0, angle: '0',
    range: 150, size: 16, magnitude: 5.0, damage: 25, amplitude: 0, frequency: 0, flags: [0]
  });
  markDirty('projGroups');
  renderPgTabProjList(selectedPgTab);
}

// ========== MAPS EDITOR ==========
const MAP_TILE_PX = 16; // pixel size per cell on the map canvas

function getMapType(m) {
  if (m.data) return 'static';
  if (m.dungeonId >= 0 && m.dungeonParams) return 'dungeon';
  if (m.terrainId >= 0) return 'terrain';
  return 'unknown';
}

function addMap() {
  // Prompt for dimensions
  const widthStr = window.prompt('Map width (tiles):', '32');
  if (widthStr === null) return;
  const heightStr = window.prompt('Map height (tiles):', widthStr);
  if (heightStr === null) return;
  const w = Math.max(1, parseInt(widthStr) || 32);
  const h = Math.max(1, parseInt(heightStr) || 32);
  const maxId = maps.reduce((max, m) => Math.max(max, m.mapId), 0);
  // Build layer data as object with 2D arrays (layer "0" = base, "1" = collision)
  const layer0 = [];
  const layer1 = [];
  for (let r = 0; r < h; r++) {
    layer0.push(new Array(w).fill(0));
    layer1.push(new Array(w).fill(0));
  }
  const newMap = {
    mapId: maxId + 1, mapName: 'New_Map_' + (maxId + 1),
    width: w, height: h, tileSize: 32,
    data: { "0": layer0, "1": layer1 }
  };
  maps.push(newMap);
  maps.sort((a, b) => a.mapId - b.mapId);
  document.getElementById('mapCount').textContent = maps.length;
  markDirty('maps');
  selectMap(newMap);
}

function renderMapList(filter = '') {
  const list = document.getElementById('mapListView');
  list.innerHTML = '';
  const lower = (filter || '').toLowerCase();
  maps.forEach(m => {
    if (lower && !m.mapName.toLowerCase().includes(lower) && !String(m.mapId).includes(lower)) return;
    const row = document.createElement('div');
    row.className = 'tile-row' + (selectedMap && selectedMap.mapId === m.mapId ? ' selected' : '');
    const id = document.createElement('span'); id.className = 'tile-id'; id.textContent = m.mapId;
    const name = document.createElement('span'); name.className = 'tile-name'; name.textContent = m.mapName;
    const type = getMapType(m);
    const badge = document.createElement('span');
    badge.className = 'map-type-badge map-type-' + type;
    badge.textContent = type;
    const dims = document.createElement('span'); dims.style.cssText = 'color:#888;font-size:11px';
    dims.textContent = `${m.width}x${m.height}`;
    row.append(id, name, badge, dims);
    row.addEventListener('click', () => selectMap(m));
    list.appendChild(row);
  });
}

function selectMap(m) {
  selectedMap = m;
  mapBrushTileId = -1;
  document.getElementById('mapListView').style.display = 'none';
  document.querySelector('#mapsTab .tile-header').style.display = 'none';
  showMapDetail(m);
}

function deselectMap() {
  selectedMap = null;
  document.getElementById('mapDetail').style.display = 'none';
  document.getElementById('mapListView').style.display = '';
  document.querySelector('#mapsTab .tile-header').style.display = '';
  renderMapList(document.getElementById('mapSearch').value);
}

function showMapDetail(m) {
  const detail = document.getElementById('mapDetail');
  detail.style.display = 'flex';
  document.getElementById('mapTitle').textContent = `${m.mapName} (ID ${m.mapId})`;
  document.getElementById('mapInfo').textContent = `${m.width}x${m.height}, tileSize: ${m.tileSize}`;

  const type = getMapType(m);
  const dungeonEditor = document.getElementById('dungeonParamsEditor');
  const staticEditor = document.getElementById('staticMapEditor');

  dungeonEditor.style.display = 'none';
  staticEditor.style.display = 'none';

  if (type === 'static') {
    staticEditor.style.display = 'flex';
    staticEditor.style.flexDirection = 'column';
    staticEditor.style.flex = '1';
    staticEditor.style.minHeight = '0';
    updateMapBrushInfo();
    renderMapCanvas();
    renderStaticSpawnList();
    renderSpawnPointList();
    renderStaticPortalList();
    cancelPlaceEnemy();
  } else if (type === 'dungeon') {
    dungeonEditor.style.display = 'block';
    showDungeonParams(m);
  } else if (type === 'terrain') {
    const terrain = terrains.find(t => t.terrainId === m.terrainId);
    document.getElementById('mapInfo').textContent += ` | Terrain: ${terrain ? terrain.name : m.terrainId} (edit in Terrains tab)`;
  }
}

// ---- Dungeon params editor ----
function showDungeonParams(m) {
  const dp = m.dungeonParams || {};
  document.getElementById('dpMinRooms').value = dp.minRooms || 10;
  document.getElementById('dpMaxRooms').value = dp.maxRooms || 20;
  document.getElementById('dpMinRoomW').value = dp.minRoomWidth || 6;
  document.getElementById('dpMaxRoomW').value = dp.maxRoomWidth || 14;
  document.getElementById('dpMinRoomH').value = dp.minRoomHeight || 6;
  document.getElementById('dpMaxRoomH').value = dp.maxRoomHeight || 14;
  document.getElementById('dpWallTile').value = dp.wallTileId || 0;
  document.getElementById('dpBossEnemy').value = dp.bossEnemyId != null ? dp.bossEnemyId : -1;
  updateDpWallTilePreview();
  updateDpBossEnemyPreview();

  const shapes = dp.shapeTemplates || [];
  document.querySelectorAll('#dpShapes input').forEach(cb => {
    cb.checked = shapes.includes(cb.value);
  });
  const halls = dp.hallwayStyles || [];
  document.querySelectorAll('#dpHalls input').forEach(cb => {
    cb.checked = halls.includes(cb.value);
  });

  renderDungeonFloorTiles(dp);
}

function renderDungeonFloorTiles(dp) {
  const container = document.getElementById('dpFloorTiles');
  container.innerHTML = '';
  const floorIds = dp.floorTileIds || [];
  floorIds.forEach((tileId, idx) => {
    const tile = getTileById(tileId);
    const row = document.createElement('div');
    row.className = 'tg-tile-row';
    const cvs = document.createElement('canvas'); cvs.width = 24; cvs.height = 24;
    if (tile) drawTilePreview(cvs, tile);
    const idSpan = document.createElement('span'); idSpan.className = 'tile-id'; idSpan.textContent = tileId;
    const nameSpan = document.createElement('span'); nameSpan.className = 'tg-name';
    nameSpan.textContent = tile ? tile.name : '(unknown)';
    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'btn-add'; replaceBtn.textContent = 'Replace';
    replaceBtn.style.cssText = 'padding:2px 8px;font-size:11px';
    replaceBtn.addEventListener('click', () => {
      openTilePicker((newId) => {
        floorIds[idx] = newId;
        markDirty('maps');
        renderDungeonFloorTiles(dp);
      });
    });
    const removeBtn = document.createElement('button');
    removeBtn.className = 'tg-remove'; removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => {
      floorIds.splice(idx, 1);
      markDirty('maps');
      renderDungeonFloorTiles(dp);
    });
    row.append(cvs, idSpan, nameSpan, replaceBtn, removeBtn);
    container.appendChild(row);
  });
}

function updateDpWallTilePreview() {
  const cvs = document.getElementById('dpWallTilePreview');
  const tileId = parseInt(document.getElementById('dpWallTile').value);
  const tile = getTileById(tileId);
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  if (tile) drawTilePreview(cvs, tile);
}

function updateDpBossEnemyPreview() {
  const cvs = document.getElementById('dpBossEnemyPreview');
  const enemyId = parseInt(document.getElementById('dpBossEnemy').value);
  const enemy = enemies.find(e => e.enemyId === enemyId);
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  if (enemy) drawEnemySpritePreview(cvs, enemy);
}

function applyDungeonParams() {
  if (!selectedMap) return;
  const m = maps.find(x => x.mapId === selectedMap.mapId);
  if (!m) return;
  if (!m.dungeonParams) m.dungeonParams = {};
  const dp = m.dungeonParams;
  dp.minRooms = parseInt(document.getElementById('dpMinRooms').value) || 10;
  dp.maxRooms = parseInt(document.getElementById('dpMaxRooms').value) || 20;
  dp.minRoomWidth = parseInt(document.getElementById('dpMinRoomW').value) || 6;
  dp.maxRoomWidth = parseInt(document.getElementById('dpMaxRoomW').value) || 14;
  dp.minRoomHeight = parseInt(document.getElementById('dpMinRoomH').value) || 6;
  dp.maxRoomHeight = parseInt(document.getElementById('dpMaxRoomH').value) || 14;
  dp.wallTileId = parseInt(document.getElementById('dpWallTile').value) || 0;
  const boss = parseInt(document.getElementById('dpBossEnemy').value);
  if (boss >= 0) dp.bossEnemyId = boss;
  else delete dp.bossEnemyId;

  dp.shapeTemplates = [];
  document.querySelectorAll('#dpShapes input:checked').forEach(cb => dp.shapeTemplates.push(cb.value));
  dp.hallwayStyles = [];
  document.querySelectorAll('#dpHalls input:checked').forEach(cb => dp.hallwayStyles.push(cb.value));
  if (dp.hallwayStyles.length === 0) delete dp.hallwayStyles;

  markDirty('maps');
}

function addDungeonFloorTile() {
  if (!selectedMap || !selectedMap.dungeonParams) return;
  openTilePicker((tileId) => {
    if (!selectedMap.dungeonParams.floorTileIds) selectedMap.dungeonParams.floorTileIds = [];
    if (selectedMap.dungeonParams.floorTileIds.includes(tileId)) { alert('Tile already in floor list'); return; }
    selectedMap.dungeonParams.floorTileIds.push(tileId);
    markDirty('maps');
    renderDungeonFloorTiles(selectedMap.dungeonParams);
  });
}

// ---- Static map layer canvas editor ----
function getMapLayer() {
  return document.getElementById('mapLayerSelect').value;
}

function updateMapBrushInfo() {
  const info = document.getElementById('mapBrushInfo');
  if (mapBrushTileId < 0) {
    info.innerHTML = 'Brush: (none)';
  } else {
    const tile = getTileById(mapBrushTileId);
    const cvs = document.createElement('canvas'); cvs.width = 20; cvs.height = 20;
    if (tile) drawTilePreview(cvs, tile);
    info.innerHTML = '';
    info.appendChild(document.createTextNode('Brush: '));
    info.appendChild(cvs);
    info.appendChild(document.createTextNode(` ${tile ? tile.name : mapBrushTileId}`));
  }
}

function renderMapCanvas() {
  if (!selectedMap || !selectedMap.data) return;
  const m = selectedMap;
  const layer = getMapLayer();
  const layerData = m.data[layer];
  if (!layerData) return;

  const w = m.width * MAP_TILE_PX;
  const h = m.height * MAP_TILE_PX;
  const canvas = document.getElementById('mapCanvas');
  const overlay = document.getElementById('mapOverlayCanvas');
  canvas.width = w; canvas.height = h;
  overlay.width = w; overlay.height = h;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);

  // Draw base layer always
  const baseData = m.data['0'];
  if (baseData) {
    for (let r = 0; r < m.height && r < baseData.length; r++) {
      for (let c = 0; c < m.width && c < baseData[r].length; c++) {
        const tileId = baseData[r][c];
        const tile = getTileById(tileId);
        if (tile) {
          const img = images[tile.spriteKey];
          if (img) {
            const ss = tile.size || 32;
            // Use spriteKey's native tile size for source coords
            const srcSize = gridSize;
            ctx.drawImage(img, tile.col * srcSize, tile.row * srcSize, srcSize, srcSize,
              c * MAP_TILE_PX, r * MAP_TILE_PX, MAP_TILE_PX, MAP_TILE_PX);
          }
        }
      }
    }
  }

  // Draw collision layer on top if viewing layer 1 or always show both
  if (layer === '1' || layer === '0') {
    const colData = m.data['1'];
    if (colData && layer === '1') {
      // Dim the base layer
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(0, 0, w, h);
    }
    if (colData) {
      for (let r = 0; r < m.height && r < colData.length; r++) {
        for (let c = 0; c < m.width && c < colData[r].length; c++) {
          const tileId = colData[r][c];
          if (tileId === 0 && layer === '1') continue; // skip empty on collision layer view
          if (layer === '0') continue; // don't draw collision on base view
          const tile = getTileById(tileId);
          if (tile) {
            const img = images[tile.spriteKey];
            if (img) {
              const srcSize = gridSize;
              ctx.drawImage(img, tile.col * srcSize, tile.row * srcSize, srcSize, srcSize,
                c * MAP_TILE_PX, r * MAP_TILE_PX, MAP_TILE_PX, MAP_TILE_PX);
            }
          }
        }
      }
    }
  }

  drawMapOverlay();
}

function drawMapOverlay() {
  if (!selectedMap || !selectedMap.data) return;
  const m = selectedMap;
  const w = m.width * MAP_TILE_PX;
  const h = m.height * MAP_TILE_PX;
  const ctx = document.getElementById('mapOverlayCanvas').getContext('2d');
  ctx.clearRect(0, 0, w, h);

  if (document.getElementById('mapShowGrid').checked) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += MAP_TILE_PX) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y <= h; y += MAP_TILE_PX) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }
  drawEnemySpawnsOnOverlay();
  drawSpawnPointsOnOverlay();
  drawStaticPortalsOnOverlay();
}

// ========== PLAYER SPAWN POINTS ==========
let placingSpawnPoint = false;

function renderSpawnPointList() {
  const container = document.getElementById('spawnPointList');
  container.innerHTML = '';
  if (!selectedMap) return;
  const points = selectedMap.spawnPoints || [];
  if (points.length === 0) {
    container.innerHTML = '<span style="color:#666;font-size:12px">No spawn points. Players will spawn at map center.</span>';
    return;
  }
  points.forEach((sp, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 4px;border-bottom:1px solid #222';
    const marker = document.createElement('span');
    marker.style.cssText = 'color:#4f4;font-size:14px;font-weight:bold';
    marker.textContent = '\u25C9'; // circle marker
    const posLabel = document.createElement('span');
    posLabel.style.cssText = 'flex:1;font-size:12px;color:#ccc';
    posLabel.textContent = `(${sp[0]}, ${sp[1]})`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'tg-remove'; removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => {
      selectedMap.spawnPoints.splice(idx, 1);
      markDirty('maps');
      renderSpawnPointList();
      drawMapOverlay();
    });
    row.append(marker, posLabel, removeBtn);
    container.appendChild(row);
  });
}

function drawSpawnPointsOnOverlay() {
  if (!selectedMap || !selectedMap.spawnPoints || selectedMap.spawnPoints.length === 0) return;
  const canvas = document.getElementById('mapOverlayCanvas');
  const ctx = canvas.getContext('2d');
  const tileSize = selectedMap.tileSize || 32;
  selectedMap.spawnPoints.forEach(sp => {
    const px = (sp[0] / tileSize) * MAP_TILE_PX;
    const py = (sp[1] / tileSize) * MAP_TILE_PX;
    // Green circle marker for player spawn points
    ctx.fillStyle = 'rgba(80, 255, 80, 0.4)';
    ctx.beginPath();
    ctx.arc(px + MAP_TILE_PX / 2, py + MAP_TILE_PX / 2, MAP_TILE_PX / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4f4';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // "S" label
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + Math.max(8, MAP_TILE_PX * 0.6) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('S', px + MAP_TILE_PX / 2, py + MAP_TILE_PX / 2);
  });
}

function drawStaticPortalsOnOverlay() {
  if (!selectedMap || !selectedMap.staticPortals || selectedMap.staticPortals.length === 0) return;
  const canvas = document.getElementById('mapOverlayCanvas');
  const ctx = canvas.getContext('2d');
  const tileSize = selectedMap.tileSize || 32;
  selectedMap.staticPortals.forEach(sp => {
    const px = (sp.x / tileSize) * MAP_TILE_PX;
    const py = (sp.y / tileSize) * MAP_TILE_PX;
    ctx.fillStyle = 'rgba(160, 80, 255, 0.4)';
    ctx.beginPath();
    ctx.arc(px + MAP_TILE_PX / 2, py + MAP_TILE_PX / 2, MAP_TILE_PX * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#a050ff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + Math.max(7, MAP_TILE_PX * 0.5) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('P', px + MAP_TILE_PX / 2, py + MAP_TILE_PX / 2);
  });
}

document.getElementById('mapAddSpawnPointBtn').addEventListener('click', () => {
  if (!selectedMap) return;
  if (!selectedMap.spawnPoints) selectedMap.spawnPoints = [];
  // Add at map center by default
  const cx = Math.floor(selectedMap.width / 2) * selectedMap.tileSize;
  const cy = Math.floor(selectedMap.height / 2) * selectedMap.tileSize;
  selectedMap.spawnPoints.push([cx, cy]);
  markDirty('maps');
  renderSpawnPointList();
  drawMapOverlay();
});

document.getElementById('mapPlaceSpawnPointBtn').addEventListener('click', () => {
  if (!selectedMap) return;
  placingSpawnPoint = true;
  document.getElementById('mapPlaceSpawnPointBtn').style.display = 'none';
  document.getElementById('mapCancelPlaceSpawnBtn').style.display = '';
  document.getElementById('mapOverlayCanvas').style.cursor = 'crosshair';
});

document.getElementById('mapCancelPlaceSpawnBtn').addEventListener('click', () => {
  placingSpawnPoint = false;
  document.getElementById('mapPlaceSpawnPointBtn').style.display = '';
  document.getElementById('mapCancelPlaceSpawnBtn').style.display = 'none';
  document.getElementById('mapOverlayCanvas').style.cursor = '';
});

function placeSpawnPointOnMap(e) {
  if (!selectedMap) return;
  const canvas = document.getElementById('mapOverlayCanvas');
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const col = Math.floor((e.clientX - rect.left) * scaleX / MAP_TILE_PX);
  const row = Math.floor((e.clientY - rect.top) * scaleY / MAP_TILE_PX);
  if (row < 0 || row >= selectedMap.height || col < 0 || col >= selectedMap.width) return;
  const pixelX = col * selectedMap.tileSize;
  const pixelY = row * selectedMap.tileSize;
  if (!selectedMap.spawnPoints) selectedMap.spawnPoints = [];
  selectedMap.spawnPoints.push([pixelX, pixelY]);
  markDirty('maps');
  // Stay in placement mode for easy multi-point placement
  renderSpawnPointList();
  drawMapOverlay();
}

// ========== STATIC PORTALS ON MAPS ==========
let placingPortal = false;

function renderStaticPortalList() {
  const container = document.getElementById('staticPortalList');
  if (!container) return;
  container.innerHTML = '';
  if (!selectedMap) return;
  const portals = selectedMap.staticPortals || [];
  if (portals.length === 0) {
    container.innerHTML = '<span style="color:#666;font-size:12px">No static portals on this map.</span>';
    return;
  }
  portals.forEach((sp, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px solid #222;font-size:11px';
    const marker = document.createElement('span');
    marker.style.cssText = 'color:#c080ff;font-size:14px';
    marker.textContent = '\u25C6';
    const info = document.createElement('span');
    info.style.cssText = 'flex:1;color:#ccc';
    const portalDef = (typeof portals !== 'undefined' && window._editorPortals) ? window._editorPortals.find(p => p.portalId === sp.portalId) : null;
    const name = sp.label || (portalDef ? portalDef.portalName : 'Portal ' + sp.portalId);
    info.textContent = `${name} @ (${sp.x}, ${sp.y}) -> ${sp.targetNodeId || 'vault'}`;

    const idInput = document.createElement('input'); idInput.type = 'number'; idInput.value = sp.portalId;
    idInput.style.width = '50px'; idInput.title = 'Portal ID';
    idInput.addEventListener('change', () => { sp.portalId = parseInt(idInput.value) || 0; markDirty('maps'); renderStaticPortalList(); });

    const nodeInput = document.createElement('input'); nodeInput.type = 'text'; nodeInput.value = sp.targetNodeId || '';
    nodeInput.style.width = '80px'; nodeInput.placeholder = 'node'; nodeInput.title = 'Target node ID';
    nodeInput.addEventListener('change', () => { sp.targetNodeId = nodeInput.value || null; markDirty('maps'); });

    const labelInput = document.createElement('input'); labelInput.type = 'text'; labelInput.value = sp.label || '';
    labelInput.style.width = '80px'; labelInput.placeholder = 'label';
    labelInput.addEventListener('change', () => { sp.label = labelInput.value || null; markDirty('maps'); });

    const rmBtn = document.createElement('button'); rmBtn.className = 'tg-remove'; rmBtn.textContent = '\u00d7';
    rmBtn.addEventListener('click', () => { selectedMap.staticPortals.splice(idx, 1); markDirty('maps'); renderStaticPortalList(); drawMapOverlay(); });

    row.append(marker, info, idInput, nodeInput, labelInput, rmBtn);
    container.appendChild(row);
  });
}

function addStaticPortal(x, y) {
  if (!selectedMap) return;
  if (!selectedMap.staticPortals) selectedMap.staticPortals = [];
  selectedMap.staticPortals.push({ portalId: 0, x: x, y: y, targetNodeId: 'beach', label: '' });
  markDirty('maps');
  renderStaticPortalList();
  drawMapOverlay();
}

function placePortalOnMap(e) {
  if (!selectedMap) return;
  const canvas = document.getElementById('mapOverlayCanvas');
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const col = Math.floor((e.clientX - rect.left) * scaleX / MAP_TILE_PX);
  const row = Math.floor((e.clientY - rect.top) * scaleY / MAP_TILE_PX);
  const tileSize = selectedMap.tileSize || 32;
  const pixelX = col * tileSize;
  const pixelY = row * tileSize;
  addStaticPortal(pixelX, pixelY);
}

document.getElementById('addStaticPortalBtn')?.addEventListener('click', () => {
  if (!selectedMap) return;
  const ts = selectedMap.tileSize || 32;
  addStaticPortal(ts * 5, ts * 5);
});

document.getElementById('placePortalOnMapBtn')?.addEventListener('click', () => {
  placingPortal = true;
  document.getElementById('placePortalOnMapBtn').style.display = 'none';
  document.getElementById('cancelPlacePortalBtn').style.display = '';
  document.getElementById('mapOverlayCanvas').style.cursor = 'crosshair';
});

document.getElementById('cancelPlacePortalBtn')?.addEventListener('click', () => {
  placingPortal = false;
  document.getElementById('placePortalOnMapBtn').style.display = '';
  document.getElementById('cancelPlacePortalBtn').style.display = 'none';
  document.getElementById('mapOverlayCanvas').style.cursor = '';
});

// ========== STATIC ENEMY SPAWNS ==========
let placingEnemy = false;
let placingEnemyId = -1;
let enemyPickerCb = null;

function openEnemyPicker(onSelect) {
  enemyPickerCb = onSelect;
  document.getElementById('enemyPickerOverlay').style.display = 'flex';
  const search = document.getElementById('enemyPickerSearch');
  search.value = '';
  renderEnemyPickerList('');
  search.focus();
}

function closeEnemyPicker() {
  document.getElementById('enemyPickerOverlay').style.display = 'none';
  enemyPickerCb = null;
}

function renderEnemyPickerList(filter) {
  const list = document.getElementById('enemyPickerList');
  list.innerHTML = '';
  const lower = filter.toLowerCase();
  enemies.forEach(en => {
    if (lower && !en.name.toLowerCase().includes(lower) && !String(en.enemyId).includes(lower)) return;
    const row = document.createElement('div');
    row.className = 'picker-row';
    const cvs = document.createElement('canvas'); cvs.width = 28; cvs.height = 28;
    const img = images[en.spriteKey];
    if (img) {
      const ss = en.spriteSize || 8, esh = en.spriteHeight || ss;
      const ctx = cvs.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, en.col * ss, en.row * esh, ss, esh, 0, 0, 28, 28);
    }
    const id = document.createElement('span'); id.className = 'tile-id'; id.textContent = en.enemyId;
    const name = document.createElement('span'); name.className = 'tile-name'; name.textContent = en.name;
    const hp = document.createElement('span'); hp.style.cssText = 'color:#e44;font-size:11px';
    hp.textContent = `HP:${en.health}`;
    row.append(cvs, id, name, hp);
    row.addEventListener('click', () => { if (enemyPickerCb) enemyPickerCb(en); closeEnemyPicker(); });
    list.appendChild(row);
  });
}

function startPlaceEnemy() {
  openEnemyPicker((en) => {
    placingEnemy = true;
    placingEnemyId = en.enemyId;
    document.getElementById('mapPlaceEnemyBtn').style.display = 'none';
    document.getElementById('mapCancelPlaceBtn').style.display = '';
    document.getElementById('mapEnemyPlaceInfo').textContent = `Click map to place: ${en.name} (ID ${en.enemyId})`;
    document.getElementById('mapOverlayCanvas').style.cursor = 'crosshair';
  });
}

function cancelPlaceEnemy() {
  placingEnemy = false;
  placingEnemyId = -1;
  document.getElementById('mapPlaceEnemyBtn').style.display = '';
  document.getElementById('mapCancelPlaceBtn').style.display = 'none';
  document.getElementById('mapEnemyPlaceInfo').textContent = '';
  document.getElementById('mapOverlayCanvas').style.cursor = '';
}

function placeEnemyOnMap(e) {
  if (!selectedMap) return;
  const canvas = document.getElementById('mapOverlayCanvas');
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const col = Math.floor((e.clientX - rect.left) * scaleX / MAP_TILE_PX);
  const row = Math.floor((e.clientY - rect.top) * scaleY / MAP_TILE_PX);
  if (row < 0 || row >= selectedMap.height || col < 0 || col >= selectedMap.width) return;

  const pixelX = col * selectedMap.tileSize;
  const pixelY = row * selectedMap.tileSize;

  // Moving an existing spawn
  if (movingSpawnIdx >= 0 && selectedMap.staticSpawns && movingSpawnIdx < selectedMap.staticSpawns.length) {
    selectedMap.staticSpawns[movingSpawnIdx].x = pixelX;
    selectedMap.staticSpawns[movingSpawnIdx].y = pixelY;
    movingSpawnIdx = -1;
    document.getElementById('mapEnemyPlaceInfo').textContent = '';
    document.getElementById('mapOverlayCanvas').style.cursor = '';
    markDirty('maps');
    renderStaticSpawnList();
    drawMapOverlay();
    return;
  }

  // Placing a new spawn
  if (!placingEnemy) return;
  if (!selectedMap.staticSpawns) selectedMap.staticSpawns = [];
  selectedMap.staticSpawns.push({ enemyId: placingEnemyId, x: pixelX, y: pixelY });
  markDirty('maps');
  cancelPlaceEnemy();
  renderStaticSpawnList();
  drawMapOverlay();
}

let movingSpawnIdx = -1;

function moveStaticSpawn(idx) {
  movingSpawnIdx = idx;
  const en = enemies.find(e => e.enemyId === selectedMap.staticSpawns[idx].enemyId);
  document.getElementById('mapEnemyPlaceInfo').textContent = `Click map to move ${en ? en.name : 'Enemy'} to new location`;
  document.getElementById('mapOverlayCanvas').style.cursor = 'crosshair';
}

function removeStaticSpawn(idx) {
  if (!selectedMap || !selectedMap.staticSpawns) return;
  if (movingSpawnIdx === idx) movingSpawnIdx = -1;
  selectedMap.staticSpawns.splice(idx, 1);
  markDirty('maps');
  renderStaticSpawnList();
  drawMapOverlay();
}

function renderStaticSpawnList() {
  const container = document.getElementById('staticSpawnList');
  container.innerHTML = '';
  if (!selectedMap) return;
  const spawns = selectedMap.staticSpawns || [];
  if (spawns.length === 0) {
    container.innerHTML = '<span style="color:#666;font-size:12px">No enemy spawns. Click "+ Place Enemy" to add.</span>';
    return;
  }
  spawns.forEach((ss, idx) => {
    const en = enemies.find(e => e.enemyId === ss.enemyId);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px solid #222';

    const cvs = document.createElement('canvas'); cvs.width = 20; cvs.height = 20;
    if (en) {
      const img = images[en.spriteKey];
      if (img) {
        const ess = en.spriteSize || 8, esh = en.spriteHeight || ess;
        const ctx = cvs.getContext('2d'); ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, en.col * ess, en.row * esh, ess, esh, 0, 0, 20, 20);
      }
    }
    const name = document.createElement('span');
    name.style.cssText = 'flex:1;font-size:12px;color:#ccc';
    name.textContent = en ? `${en.name} (${ss.enemyId})` : `Enemy ${ss.enemyId}`;
    const pos = document.createElement('span');
    pos.style.cssText = 'font-size:11px;color:#888';
    const tileCol = Math.round(ss.x / selectedMap.tileSize);
    const tileRow = Math.round(ss.y / selectedMap.tileSize);
    pos.textContent = `[${tileCol},${tileRow}]`;
    const moveBtn = document.createElement('button');
    moveBtn.className = 'btn-pick'; moveBtn.textContent = 'Move';
    moveBtn.style.cssText = 'font-size:9px;padding:1px 6px';
    moveBtn.addEventListener('click', () => moveStaticSpawn(idx));
    const removeBtn = document.createElement('button');
    removeBtn.className = 'tg-remove'; removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => removeStaticSpawn(idx));
    row.append(cvs, name, pos, moveBtn, removeBtn);
    container.appendChild(row);
  });
}

function drawEnemySpawnsOnOverlay() {
  if (!selectedMap || !selectedMap.staticSpawns || selectedMap.staticSpawns.length === 0) return;
  const canvas = document.getElementById('mapOverlayCanvas');
  const ctx = canvas.getContext('2d');
  const tileSize = selectedMap.tileSize || 32;

  selectedMap.staticSpawns.forEach(ss => {
    const en = enemies.find(e => e.enemyId === ss.enemyId);
    const px = (ss.x / tileSize) * MAP_TILE_PX;
    const py = (ss.y / tileSize) * MAP_TILE_PX;

    // Draw enemy sprite if available
    if (en) {
      const img = images[en.spriteKey];
      if (img) {
        const ess = en.spriteSize || 8, esh = en.spriteHeight || ess;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, en.col * ess, en.row * esh, ess, esh, px, py, MAP_TILE_PX, MAP_TILE_PX);
      }
    }
    // Red diamond marker
    ctx.strokeStyle = '#f44';
    ctx.lineWidth = 1.5;
    const cx = px + MAP_TILE_PX / 2, cy = py + MAP_TILE_PX / 2, r = MAP_TILE_PX / 2 + 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
    ctx.closePath(); ctx.stroke();
  });
}

let stampingSetPiece = null; // SetPiece model being stamped, or null

function startStampSetPiece() {
  if (!selectedMap || !selectedMap.data) { alert('Select a static map first'); return; }
  // Show a simple prompt to pick a setPieceId
  const idStr = window.prompt('SetPiece ID to stamp:', '0');
  if (idStr === null) return;
  const id = parseInt(idStr);
  const sp = setpieces.find(s => s.setPieceId === id);
  if (!sp) { alert('SetPiece #' + id + ' not found'); return; }
  stampingSetPiece = sp;
  document.getElementById('mapBrushInfo').innerHTML = `<b style="color:#8cf">Stamping: ${sp.name} (${sp.width}x${sp.height}) — click map to place</b>`;
}

function stampSetPieceOnMap(e) {
  const cvs = document.getElementById('mapCanvas');
  const rect = cvs.getBoundingClientRect();
  const col = Math.floor((e.clientX - rect.left) / MAP_TILE_PX);
  const row = Math.floor((e.clientY - rect.top) / MAP_TILE_PX);
  const sp = stampingSetPiece;
  const m = selectedMap;
  if (!sp || !m || !m.data) return;

  for (let dy = 0; dy < sp.height; dy++) {
    for (let dx = 0; dx < sp.width; dx++) {
      const tr = row + dy, tc = col + dx;
      if (tr < 0 || tr >= m.height || tc < 0 || tc >= m.width) continue;
      // Stamp base layer
      if (sp.baseLayout && sp.baseLayout[dy] && sp.baseLayout[dy][dx] > 0) {
        if (m.data['0'] && m.data['0'][tr]) m.data['0'][tr][tc] = sp.baseLayout[dy][dx];
      }
      // Stamp collision layer
      if (sp.collisionLayout && sp.collisionLayout[dy] && sp.collisionLayout[dy][dx] > 0) {
        if (m.data['1'] && m.data['1'][tr]) m.data['1'][tr][tc] = sp.collisionLayout[dy][dx];
      }
    }
  }

  stampingSetPiece = null;
  markDirty('maps');
  renderMapCanvas();
  updateMapBrushInfo();
}

function mapCanvasClick(e) {
  if (stampingSetPiece) { stampSetPieceOnMap(e); return; }
  if (placingSpawnPoint) { placeSpawnPointOnMap(e); return; }
  if (placingPortal) { placePortalOnMap(e); return; }
  if (placingEnemy) { placeEnemyOnMap(e); return; }
  if (!selectedMap || !selectedMap.data || mapBrushTileId < 0) return;
  const canvas = document.getElementById('mapOverlayCanvas');
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const col = Math.floor((e.clientX - rect.left) * scaleX / MAP_TILE_PX);
  const row = Math.floor((e.clientY - rect.top) * scaleY / MAP_TILE_PX);
  paintMapCell(row, col);
}

function mapCanvasDrag(e) {
  if (!mapPainting) return;
  mapCanvasClick(e);
}

function paintMapCell(row, col) {
  if (!selectedMap || !selectedMap.data || mapBrushTileId < 0) return;
  const m = selectedMap;
  const layer = getMapLayer();
  if (row < 0 || row >= m.height || col < 0 || col >= m.width) return;
  if (!m.data[layer]) return;
  if (m.data[layer][row][col] === mapBrushTileId) return;
  m.data[layer][row][col] = mapBrushTileId;
  markDirty('maps');
  // Redraw just the affected cell
  redrawMapCell(row, col);
}

function redrawMapCell(row, col) {
  const m = selectedMap;
  const canvas = document.getElementById('mapCanvas');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const layer = getMapLayer();
  const x = col * MAP_TILE_PX, y = row * MAP_TILE_PX;

  // Clear cell
  ctx.fillStyle = '#111';
  ctx.fillRect(x, y, MAP_TILE_PX, MAP_TILE_PX);

  // Draw base tile
  const baseTileId = m.data['0'] ? m.data['0'][row][col] : 0;
  const baseTile = getTileById(baseTileId);
  if (baseTile) {
    const img = images[baseTile.spriteKey];
    if (img) {
      const srcSize = gridSize;
      ctx.drawImage(img, baseTile.col * srcSize, baseTile.row * srcSize, srcSize, srcSize, x, y, MAP_TILE_PX, MAP_TILE_PX);
    }
  }

  // If viewing collision layer, dim base and draw collision tile
  if (layer === '1') {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x, y, MAP_TILE_PX, MAP_TILE_PX);
    const colTileId = m.data['1'] ? m.data['1'][row][col] : 0;
    if (colTileId !== 0) {
      const colTile = getTileById(colTileId);
      if (colTile) {
        const img = images[colTile.spriteKey];
        if (img) {
          const srcSize = gridSize;
          ctx.drawImage(img, colTile.col * srcSize, colTile.row * srcSize, srcSize, srcSize, x, y, MAP_TILE_PX, MAP_TILE_PX);
        }
      }
    }
  }
}

function mapCanvasHover(e) {
  if (!selectedMap || !selectedMap.data) return;
  const canvas = document.getElementById('mapOverlayCanvas');
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const col = Math.floor((e.clientX - rect.left) * scaleX / MAP_TILE_PX);
  const row = Math.floor((e.clientY - rect.top) * scaleY / MAP_TILE_PX);
  const layer = getMapLayer();
  const m = selectedMap;
  if (row < 0 || row >= m.height || col < 0 || col >= m.width) return;
  const tileId = m.data[layer] ? m.data[layer][row][col] : -1;
  const tile = getTileById(tileId);
  document.getElementById('mapHoverInfo').textContent =
    `Row: ${row}, Col: ${col} | Layer ${layer} | Tile: ${tileId} (${tile ? tile.name : '?'})`;
}

// ========== TILE PICKER MODAL ==========
let pickerCallback = null;

function openTilePicker(onSelect) {
  pickerCallback = onSelect;
  const overlay = document.getElementById('tilePickerOverlay');
  overlay.style.display = 'flex';
  const search = document.getElementById('pickerSearch');
  search.value = '';
  renderPickerList('');
  search.focus();
}

function closeTilePicker() {
  document.getElementById('tilePickerOverlay').style.display = 'none';
  pickerCallback = null;
}

function renderPickerList(filter) {
  const list = document.getElementById('pickerList');
  list.innerHTML = '';
  const lower = filter.toLowerCase();
  tiles.forEach(t => {
    if (lower && !t.name.toLowerCase().includes(lower) && !String(t.tileId).includes(lower)) return;
    const row = document.createElement('div');
    row.className = 'picker-row';

    const cvs = document.createElement('canvas'); cvs.width = 28; cvs.height = 28;
    drawTilePreview(cvs, t);

    const id = document.createElement('span'); id.className = 'tile-id'; id.textContent = t.tileId;
    const name = document.createElement('span'); name.className = 'tile-name'; name.textContent = t.name;
    const flags = document.createElement('span'); flags.className = 'tile-flags';
    if (t.data && t.data.hasCollision) flags.innerHTML += '<span class="flag flag-c">C</span>';
    if (t.data && t.data.slows) flags.innerHTML += '<span class="flag flag-s">S</span>';
    if (t.data && t.data.damaging) flags.innerHTML += '<span class="flag flag-d">D</span>';
    if (t.data && t.data.isWall) flags.innerHTML += '<span class="flag flag-w">W</span>';

    row.append(cvs, id, name, flags);
    row.addEventListener('click', () => {
      if (pickerCallback) pickerCallback(t.tileId);
      closeTilePicker();
    });
    list.appendChild(row);
  });
}

// ========== ANIMATIONS ==========
const ANIM_SET_NAMES = ['idle_side','walk_side','attack_side','idle_front','walk_front','attack_down','idle_back','walk_back','attack_up'];

function renderAnimList(filter = '') {
  const list = document.getElementById('animListView');
  list.innerHTML = '';
  const lower = (filter || '').toLowerCase();
  animations.forEach(a => {
    const label = a.className || a.objectType + ':' + a.objectId;
    if (lower && !label.toLowerCase().includes(lower) && !String(a.objectId).includes(lower)) return;
    const row = document.createElement('div');
    row.className = 'tile-row' + (selectedAnim && selectedAnim.objectId === a.objectId && selectedAnim.objectType === a.objectType ? ' selected' : '');
    const id = document.createElement('span'); id.className = 'tile-id'; id.textContent = a.objectId;
    const name = document.createElement('span'); name.className = 'tile-name'; name.textContent = label;
    const type = document.createElement('span'); type.style.cssText = 'color:#888;font-size:11px'; type.textContent = a.objectType;
    row.append(id, name, type);
    row.addEventListener('click', () => selectAnim(a));
    list.appendChild(row);
  });
}

function selectAnim(a) {
  selectedAnim = a;
  document.getElementById('animListView').style.display = 'none';
  document.querySelector('#animationsTab .tile-header').style.display = 'none';
  showAnimDetail(a);
}

function deselectAnim() {
  selectedAnim = null;
  animPickingFrame = null;
  document.getElementById('animDetail').style.display = 'none';
  document.getElementById('animListView').style.display = '';
  document.querySelector('#animationsTab .tile-header').style.display = '';
  renderAnimList(document.getElementById('animSearch').value);
}

function showAnimDetail(a) {
  document.getElementById('animDetail').style.display = '';
  document.getElementById('animDetailTitle').textContent = a.className || (a.objectType + ':' + a.objectId);
  document.getElementById('animObjId').value = a.objectId;
  document.getElementById('animObjType').value = a.objectType;
  // Populate sprite key dropdown
  const sel = document.getElementById('animSpriteKey');
  sel.innerHTML = '';
  SPRITE_SHEETS.forEach(s => {
    const opt = document.createElement('option'); opt.value = s; opt.textContent = s;
    if (s === a.spriteKey) opt.selected = true;
    sel.appendChild(opt);
  });
  document.getElementById('animSpriteSize').value = a.spriteSize || 8;
  document.getElementById('animSpriteHeight').value = a.spriteHeight || 0;
  renderAnimSets(a);
  updateAnimPreview(a);
}

function updateAnimPreview(a) {
  const cvs = document.getElementById('animPreview');
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);
  const idle = a.animations?.idle_side;
  if (!idle || !idle.frames.length) return;
  const frame = idle.frames[0];
  const img = images[a.spriteKey];
  if (!img) return;
  const ss = a.spriteSize || 8;
  const sh = a.spriteHeight || ss;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, frame.col * ss, frame.row * sh, ss, sh, 0, 0, 64, 64);
}

function renderAnimSets(a) {
  const container = document.getElementById('animSetsContainer');
  container.innerHTML = '';
  if (!a.animations) a.animations = {};
  const ss = a.spriteSize || 8;
  const sh = a.spriteHeight || ss;

  ANIM_SET_NAMES.forEach(animName => {
    if (!a.animations[animName]) a.animations[animName] = { frames: [], durations: [] };
    const animSet = a.animations[animName];

    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid #333;border-radius:4px;margin-bottom:4px;background:#1a1820;overflow:hidden';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 6px;cursor:pointer;user-select:none;background:#12122a';
    const titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'display:flex;align-items:center;gap:6px';
    const arrow = document.createElement('span');
    arrow.style.cssText = 'font-size:10px;color:#888;transition:transform 0.15s';
    arrow.textContent = '\u25B6';
    const title = document.createElement('span');
    title.style.cssText = 'font-weight:bold;font-size:12px;color:#c8a86e';
    title.textContent = animName;
    const frameCount = document.createElement('span');
    frameCount.style.cssText = 'font-size:10px;color:#666';
    frameCount.textContent = `(${animSet.frames.length}f)`;
    titleWrap.append(arrow, title, frameCount);
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add'; addBtn.textContent = '+ Frame';
    addBtn.style.cssText = 'font-size:9px;padding:1px 6px';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      animSet.frames.push({ row: 0, col: 0 });
      animSet.durations.push(8);
      markDirty('animations');
      renderAnimSets(a);
    });
    header.append(titleWrap, addBtn);
    card.appendChild(header);

    const body = document.createElement('div');
    body.style.cssText = 'padding:6px;display:none';

    header.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      arrow.style.transform = open ? '' : 'rotate(90deg)';
    });

    const framesRow = document.createElement('div');
    framesRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';

    animSet.frames.forEach((frame, idx) => {
      const frameDiv = document.createElement('div');
      frameDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;border:1px solid #2a2a38;border-radius:3px;padding:3px;background:#12101a';

      // Sprite preview canvas - clickable to pick from sheet
      const cvs = document.createElement('canvas'); cvs.width = 32; cvs.height = 32;
      cvs.style.cssText = 'cursor:pointer;border:1px solid #444;image-rendering:pixelated';
      cvs.title = 'Click to pick from sprite sheet';
      const img = images[a.spriteKey];
      if (img) {
        const ctx = cvs.getContext('2d'); ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, frame.col * ss, frame.row * sh, ss, sh, 0, 0, 32, 32);
      }
      cvs.addEventListener('click', () => {
        // Switch to the correct sprite sheet and enter pick mode
        if (a.spriteKey !== currentSheet) {
          currentSheet = a.spriteKey; sheetSelect.value = currentSheet; renderSheet();
        }
        animPickingFrame = { anim: a, animName, frameIdx: idx };
        pickMode = true;
        document.querySelectorAll('.btn-pick').forEach(b => b.classList.remove('active'));
        // Scroll to the frame location on sheet
        const px = frame.col * ss * SCALE, py = frame.row * sh * SCALE;
        const scroll = document.querySelector('.sheet-scroll');
        scroll.scrollTo({ left: px - scroll.clientWidth / 2, top: py - scroll.clientHeight / 2, behavior: 'smooth' });
      });

      // Row/Col labels
      const posLabel = document.createElement('span');
      posLabel.style.cssText = 'font-size:9px;color:#888';
      posLabel.textContent = `r${frame.row} c${frame.col}`;

      // Duration input
      const durInput = document.createElement('input');
      durInput.type = 'number'; durInput.min = '1'; durInput.value = animSet.durations[idx] || 8;
      durInput.style.cssText = 'width:30px;font-size:9px;text-align:center';
      durInput.title = 'Frame duration (ticks)';
      durInput.addEventListener('change', () => {
        animSet.durations[idx] = parseInt(durInput.value) || 8;
        markDirty('animations');
      });

      // Remove button
      const rmBtn = document.createElement('button');
      rmBtn.className = 'tg-remove'; rmBtn.textContent = '×';
      rmBtn.style.cssText = 'font-size:10px;padding:0 3px';
      rmBtn.addEventListener('click', () => {
        animSet.frames.splice(idx, 1);
        animSet.durations.splice(idx, 1);
        markDirty('animations');
        renderAnimSets(a);
      });

      frameDiv.append(cvs, posLabel, durInput, rmBtn);
      framesRow.appendChild(frameDiv);
    });

    body.appendChild(framesRow);
    card.appendChild(body);
    container.appendChild(card);
  });
}

function applyAnimDetail() {
  if (!selectedAnim) return;
  selectedAnim.spriteKey = document.getElementById('animSpriteKey').value;
  selectedAnim.spriteSize = parseInt(document.getElementById('animSpriteSize').value) || 8;
  selectedAnim.spriteHeight = parseInt(document.getElementById('animSpriteHeight').value) || 0;
  markDirty('animations');
  renderAnimSets(selectedAnim);
  updateAnimPreview(selectedAnim);
}

// ========== LOOT GROUPS ==========
function renderLgList(filter = '') {
  const list = document.getElementById('lgListView');
  list.innerHTML = '';
  const lower = (filter || '').toLowerCase();
  lootGroups.forEach(lg => {
    if (lower && !lg.lootGroupName.toLowerCase().includes(lower) && !String(lg.lootGroupId).includes(lower)) return;
    const row = document.createElement('div');
    row.className = 'tile-row' + (selectedLootGroup && selectedLootGroup.lootGroupId === lg.lootGroupId ? ' selected' : '');
    const id = document.createElement('span'); id.className = 'tile-id'; id.textContent = lg.lootGroupId;
    const name = document.createElement('span'); name.className = 'tile-name'; name.textContent = lg.lootGroupName;
    const count = document.createElement('span'); count.style.cssText = 'color:#888;font-size:11px';
    count.textContent = `${lg.potentialDrops.length} items`;
    row.append(id, name, count);
    row.addEventListener('click', () => selectLootGroup(lg));
    list.appendChild(row);
  });
}

function selectLootGroup(lg) {
  selectedLootGroup = lg;
  document.getElementById('lgListView').style.display = 'none';
  document.querySelector('#lootgroupsTab .tile-header').style.display = 'none';
  showLgDetail(lg);
}

function deselectLootGroup() {
  selectedLootGroup = null;
  document.getElementById('lgDetail').style.display = 'none';
  document.getElementById('lgListView').style.display = '';
  document.querySelector('#lootgroupsTab .tile-header').style.display = '';
  renderLgList(document.getElementById('lgSearch').value);
}

function showLgDetail(lg) {
  document.getElementById('lgDetail').style.display = '';
  document.getElementById('lgDetailTitle').textContent = lg.lootGroupName;
  document.getElementById('lgDetailId').value = lg.lootGroupId;
  document.getElementById('lgDetailName').value = lg.lootGroupName;
  renderLgItems(lg);
  renderLgEnemyUsage(lg);
}

function renderLgItems(lg) {
  const container = document.getElementById('lgDetailItems');
  container.innerHTML = '';
  lg.potentialDrops.forEach((itemId, idx) => {
    const item = items.find(i => i.itemId === itemId);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px solid #222';
    const cvs = document.createElement('canvas'); cvs.width = 24; cvs.height = 24;
    if (item) {
      const img = images[item.spriteKey];
      if (img) {
        const ss = gridSize;
        const ctx = cvs.getContext('2d'); ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, (item.col || 0) * ss, (item.row || 0) * ss, ss, ss, 0, 0, 24, 24);
      }
    }
    const idSpan = document.createElement('span'); idSpan.className = 'tile-id'; idSpan.textContent = itemId;
    const nameSpan = document.createElement('span'); nameSpan.style.cssText = 'flex:1;font-size:12px;color:#ccc';
    nameSpan.textContent = item ? item.name : '(unknown)';
    const tierSpan = document.createElement('span'); tierSpan.style.cssText = 'font-size:10px;color:#888';
    tierSpan.textContent = item ? `T${item.tier}` : '';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'tg-remove'; removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      lg.potentialDrops.splice(idx, 1);
      markDirty('lootGroups');
      renderLgItems(lg);
    });
    row.append(cvs, idSpan, nameSpan, tierSpan, removeBtn);
    container.appendChild(row);
  });
}

function renderLgEnemyUsage(lg) {
  const container = document.getElementById('lgEnemyUsage');
  container.innerHTML = '';
  const groupKey = `group:${lg.lootGroupId}`;
  for (const lt of lootTables) {
    if (lt.drops && lt.drops[groupKey] !== undefined) {
      const en = enemies.find(e => e.enemyId === lt.enemyId);
      const div = document.createElement('div');
      div.style.cssText = 'padding:2px 0';
      div.textContent = `Enemy ${lt.enemyId} (${en ? en.name : '?'}) — ${(lt.drops[groupKey] * 100).toFixed(0)}% chance`;
      container.appendChild(div);
    }
  }
  if (!container.children.length) {
    container.innerHTML = '<span style="color:#555">Not used by any enemy</span>';
  }
}

function applyLgDetail() {
  if (!selectedLootGroup) return;
  selectedLootGroup.lootGroupName = document.getElementById('lgDetailName').value;
  markDirty('lootGroups');
  document.getElementById('lgDetailTitle').textContent = selectedLootGroup.lootGroupName;
}

function addLootGroup() {
  const maxId = lootGroups.reduce((m, g) => Math.max(m, g.lootGroupId), -1);
  const lg = { lootGroupId: maxId + 1, lootGroupName: 'New Loot Group', potentialDrops: [] };
  lootGroups.push(lg);
  markDirty('lootGroups');
  renderLgList();
  selectLootGroup(lg);
}

function deleteLootGroup() {
  if (!selectedLootGroup) return;
  if (!confirm(`Delete loot group "${selectedLootGroup.lootGroupName}"?`)) return;
  lootGroups = lootGroups.filter(g => g.lootGroupId !== selectedLootGroup.lootGroupId);
  markDirty('lootGroups');
  deselectLootGroup();
}

function addItemToLootGroup() {
  if (!selectedLootGroup) return;
  showPickerDialog('Select Item to Add', itemOptions, (itemId) => {
    selectedLootGroup.potentialDrops.push(itemId);
    markDirty('lootGroups');
    renderLgItems(selectedLootGroup);
  });
}

// ========== ENEMY LOOT TABLE INLINE EDITOR ==========
function getLootTableForEnemy(enemyId) {
  return lootTables.find(lt => lt.enemyId === enemyId);
}

function renderEnemyLootSection(enemy) {
  const container = document.getElementById('enemyLootSection');
  if (!container) return;
  container.innerHTML = '';

  let lt = getLootTableForEnemy(enemy.enemyId);
  if (!lt) {
    const btn = document.createElement('button');
    btn.className = 'btn-add'; btn.textContent = '+ Create Loot Table';
    btn.addEventListener('click', () => {
      lootTables.push({ enemyId: enemy.enemyId, drops: { 'group:0': 1.0 }, portalDrops: {} });
      markDirty('lootTables');
      renderEnemyLootSection(enemy);
    });
    container.appendChild(btn);
    return;
  }

  // Drops section
  const dropsH = document.createElement('h4'); dropsH.textContent = 'Drops'; dropsH.style.margin = '4px 0';
  container.appendChild(dropsH);

  const dropsList = document.createElement('div');
  dropsList.style.cssText = 'max-height:150px;overflow-y:auto';
  Object.entries(lt.drops).forEach(([key, prob]) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:2px 0;border-bottom:1px solid #222;font-size:12px';
    const isGroup = key.startsWith('group:');
    const refId = parseInt(key.split(':')[1]);
    const label = document.createElement('span'); label.style.cssText = 'flex:1;color:#ccc';
    if (isGroup) {
      const lg = lootGroups.find(g => g.lootGroupId === refId);
      label.textContent = `${key} (${lg ? lg.lootGroupName : '?'})`;
      label.style.color = '#c8a86e';
    } else {
      const item = items.find(i => i.itemId === refId);
      label.textContent = `${key} (${item ? item.name : '?'})`;
    }
    const probInput = document.createElement('input');
    probInput.type = 'number'; probInput.step = '0.01'; probInput.min = '0'; probInput.max = '1';
    probInput.value = prob; probInput.style.cssText = 'width:55px;font-size:11px';
    probInput.addEventListener('change', () => {
      lt.drops[key] = parseFloat(probInput.value) || 0;
      markDirty('lootTables');
    });
    const removeBtn = document.createElement('button');
    removeBtn.className = 'tg-remove'; removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      delete lt.drops[key];
      markDirty('lootTables');
      renderEnemyLootSection(enemy);
    });
    row.append(label, probInput, removeBtn);
    dropsList.appendChild(row);
  });
  container.appendChild(dropsList);

  // Add drop buttons
  const addRow = document.createElement('div');
  addRow.style.cssText = 'display:flex;gap:4px;margin-top:4px';
  const addGroupBtn = document.createElement('button');
  addGroupBtn.className = 'btn-add'; addGroupBtn.textContent = '+ Group';
  addGroupBtn.style.cssText = 'font-size:10px;padding:2px 6px';
  addGroupBtn.addEventListener('click', () => {
    showPickerDialog('Select Loot Group', lootGroupOptions, (gid) => {
      lt.drops[`group:${gid}`] = 0.1;
      markDirty('lootTables');
      renderEnemyLootSection(enemy);
    });
  });
  const addItemBtn = document.createElement('button');
  addItemBtn.className = 'btn-add'; addItemBtn.textContent = '+ Item';
  addItemBtn.style.cssText = 'font-size:10px;padding:2px 6px';
  addItemBtn.addEventListener('click', () => {
    showPickerDialog('Select Item', itemOptions, (iid) => {
      lt.drops[`item:${iid}`] = 0.05;
      markDirty('lootTables');
      renderEnemyLootSection(enemy);
    });
  });
  addRow.append(addGroupBtn, addItemBtn);
  container.appendChild(addRow);

  // Portal drops
  if (lt.portalDrops && Object.keys(lt.portalDrops).length > 0) {
    const portalH = document.createElement('h4'); portalH.textContent = 'Portal Drops'; portalH.style.margin = '8px 0 4px';
    container.appendChild(portalH);
    Object.entries(lt.portalDrops).forEach(([portalId, prob]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:2px 0;font-size:12px';
      const label = document.createElement('span'); label.style.cssText = 'flex:1;color:#8080e0';
      label.textContent = `Portal ${portalId}`;
      const probInput = document.createElement('input');
      probInput.type = 'number'; probInput.step = '0.01'; probInput.min = '0'; probInput.max = '1';
      probInput.value = prob; probInput.style.cssText = 'width:55px;font-size:11px';
      probInput.addEventListener('change', () => {
        lt.portalDrops[portalId] = parseFloat(probInput.value) || 0;
        markDirty('lootTables');
      });
      row.append(label, probInput);
      container.appendChild(row);
    });
  }
}

// ========== TABS ==========
// ========== PORTALS EDITOR ==========
async function loadPortals() {
  portals = await (await fetch(`${BASE}/portals.json`)).json();
  portals.sort((a, b) => a.portalId - b.portalId);
  document.getElementById('portalCount').textContent = portals.length;
}

function portalOptions() { return portals.map(p => ({id: p.portalId, label: `[${p.portalId}] ${p.portalName}`})); }
function mapOptions() { return maps.map(m => ({id: m.mapId, label: `[${m.mapId}] ${m.mapName}`})); }

function renderPortalList(filter) {
  const list = document.getElementById('portalListView');
  list.innerHTML = '';
  const lower = (filter || '').toLowerCase();
  portals.forEach(p => {
    if (lower && !p.portalName.toLowerCase().includes(lower) && !String(p.portalId).includes(lower)) return;
    const row = document.createElement('div');
    row.className = 'tile-row' + (selectedPortal && selectedPortal.portalId === p.portalId ? ' selected' : '');
    const cvs = document.createElement('canvas'); cvs.width = 28; cvs.height = 28;
    drawSpritePreview(cvs, p.spriteKey, p.row || 0, p.col || 0);
    const id = document.createElement('span'); id.className = 'tile-id'; id.textContent = p.portalId;
    const name = document.createElement('span'); name.className = 'tile-name'; name.textContent = p.portalName;
    const mapName = maps.find(m => m.mapId === p.mapId);
    const target = document.createElement('span'); target.style.cssText = 'color:#8080e0;font-size:11px';
    target.textContent = mapName ? `→ ${mapName.mapName}` : `→ map:${p.mapId}`;
    row.append(cvs, id, name, target);
    row.addEventListener('click', () => selectPortal(p));
    list.appendChild(row);
  });
}

function selectPortal(p) {
  selectedPortal = p;
  document.getElementById('portalListView').style.display = 'none';
  document.querySelector('#portalsTab .tile-header').style.display = 'none';
  showPortalDetail(p);
}

function deselectPortal() {
  selectedPortal = null;
  document.getElementById('portalDetail').style.display = 'none';
  document.getElementById('portalListView').style.display = '';
  document.querySelector('#portalsTab .tile-header').style.display = '';
  renderPortalList(document.getElementById('portalSearch').value);
}

function showPortalDetail(p) {
  document.getElementById('portalDetail').style.display = '';
  document.getElementById('portalTitle').textContent = `Portal ${p.portalId}: ${p.portalName}`;
  document.getElementById('portalIdField').value = p.portalId;
  document.getElementById('portalNameField').value = p.portalName || '';
  document.getElementById('portalMapId').value = p.mapId != null ? p.mapId : 0;
  document.getElementById('portalTargetNodeId').value = p.targetNodeId || '';
  document.getElementById('portalSprite').value = p.spriteKey || '';
  document.getElementById('portalRow').value = p.row || 0;
  document.getElementById('portalCol').value = p.col || 0;
  updatePortalPreview();
  // Enhance target map with dropdown
  enhanceWithDropdown('portalMapId', mapOptions);
}

function updatePortalPreview() {
  const cvs = document.getElementById('portalPreviewCanvas');
  const spriteKey = document.getElementById('portalSprite').value;
  const row = parseInt(document.getElementById('portalRow').value) || 0;
  const col = parseInt(document.getElementById('portalCol').value) || 0;
  drawSpritePreview(cvs, spriteKey, row, col);
}

function applyPortalDetail() {
  if (!selectedPortal) return;
  const p = portals.find(x => x.portalId === selectedPortal.portalId);
  if (!p) return;
  p.portalName = document.getElementById('portalNameField').value;
  p.mapId = parseInt(document.getElementById('portalMapId').value) || 0;
  const nodeId = document.getElementById('portalTargetNodeId').value.trim();
  if (nodeId) p.targetNodeId = nodeId; else delete p.targetNodeId;
  p.spriteKey = document.getElementById('portalSprite').value;
  p.row = parseInt(document.getElementById('portalRow').value) || 0;
  p.col = parseInt(document.getElementById('portalCol').value) || 0;
  markDirty('portals');
  document.getElementById('portalTitle').textContent = `Portal ${p.portalId}: ${p.portalName}`;
  updatePortalPreview();
}

function addPortal() {
  const maxId = portals.reduce((max, p) => Math.max(max, p.portalId), 0);
  const newPortal = {
    portalId: maxId + 1, portalName: 'New_Portal_' + (maxId + 1),
    mapId: 0,
    row: 0, col: 0, spriteKey: 'rotmg-tiles-2.png'
  };
  portals.push(newPortal);
  portals.sort((a, b) => a.portalId - b.portalId);
  document.getElementById('portalCount').textContent = portals.length;
  markDirty('portals');
  selectPortal(newPortal);
}

function deletePortal() {
  if (!selectedPortal) return;
  if (!confirm(`Delete portal ${selectedPortal.portalId} (${selectedPortal.portalName})?`)) return;
  portals = portals.filter(p => p.portalId !== selectedPortal.portalId);
  document.getElementById('portalCount').textContent = portals.length;
  markDirty('portals');
  deselectPortal();
}

// ========== SET PIECES ==========
async function loadSetPieces() {
  try {
    setpieces = await (await fetch(`${BASE}/setpieces.json`)).json();
    setpieces.sort((a, b) => a.setPieceId - b.setPieceId);
  } catch (e) { setpieces = []; }
  const el = document.getElementById('spCount');
  if (el) el.textContent = setpieces.length;
}

function renderSetPieceList(filter = '') {
  const list = document.getElementById('spListView');
  if (!list) return;
  list.innerHTML = '';
  const lf = filter.toLowerCase();
  setpieces.filter(sp => !lf || sp.name.toLowerCase().includes(lf) || String(sp.setPieceId).includes(lf))
    .forEach(sp => {
      const row = document.createElement('div');
      row.className = 'tile-row' + (selectedSetPiece === sp ? ' selected' : '');
      row.innerHTML = `<span class="tile-id">${sp.setPieceId}</span><span class="tile-name">${sp.name} (${sp.width}x${sp.height})</span>`;
      row.addEventListener('click', () => selectSetPiece(sp));
      list.appendChild(row);
    });
}

function selectSetPiece(sp) {
  selectedSetPiece = sp;
  renderSetPieceList();
  const detail = document.getElementById('spDetail');
  if (!detail) return;
  detail.style.display = '';
  document.getElementById('spId').value = sp.setPieceId;
  document.getElementById('spName').value = sp.name;
  document.getElementById('spWidth').value = sp.width;
  document.getElementById('spHeight').value = sp.height;
  renderSpCanvas();
}

function applySetPiece() {
  if (!selectedSetPiece) return;
  selectedSetPiece.name = document.getElementById('spName').value;
  const newW = parseInt(document.getElementById('spWidth').value) || selectedSetPiece.width;
  const newH = parseInt(document.getElementById('spHeight').value) || selectedSetPiece.height;
  // Resize layouts if dimensions changed
  if (newW !== selectedSetPiece.width || newH !== selectedSetPiece.height) {
    selectedSetPiece.baseLayout = resizeLayout(selectedSetPiece.baseLayout, selectedSetPiece.width, selectedSetPiece.height, newW, newH);
    selectedSetPiece.collisionLayout = resizeLayout(selectedSetPiece.collisionLayout, selectedSetPiece.width, selectedSetPiece.height, newW, newH);
    selectedSetPiece.width = newW;
    selectedSetPiece.height = newH;
  }
  markDirty('setpieces');
  renderSetPieceList();
  renderSpCanvas();
}

function resizeLayout(layout, oldW, oldH, newW, newH) {
  const result = [];
  for (let r = 0; r < newH; r++) {
    const row = [];
    for (let c = 0; c < newW; c++) {
      row.push(layout && r < oldH && c < oldW ? layout[r][c] : 0);
    }
    result.push(row);
  }
  return result;
}

function addSetPiece() {
  const maxId = setpieces.reduce((max, sp) => Math.max(max, sp.setPieceId), -1);
  const w = 7, h = 7;
  const base = [], coll = [];
  for (let r = 0; r < h; r++) { base.push(new Array(w).fill(0)); coll.push(new Array(w).fill(0)); }
  const sp = { setPieceId: maxId + 1, name: 'New_SetPiece_' + (maxId + 1), width: w, height: h, baseLayout: base, collisionLayout: coll };
  setpieces.push(sp);
  setpieces.sort((a, b) => a.setPieceId - b.setPieceId);
  markDirty('setpieces');
  selectSetPiece(sp);
  renderSetPieceList();
}

const SP_TILE_PX = 24;

function renderSpCanvas() {
  const cvs = document.getElementById('spCanvas');
  if (!cvs || !selectedSetPiece) return;
  const sp = selectedSetPiece;
  cvs.width = sp.width * SP_TILE_PX;
  cvs.height = sp.height * SP_TILE_PX;
  const ctx = cvs.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, cvs.width, cvs.height);

  const layer = document.getElementById('spLayerSelect') ? document.getElementById('spLayerSelect').value : '0';

  // Always draw base layer first
  const baseData = sp.baseLayout;
  if (baseData) {
    for (let r = 0; r < sp.height && r < baseData.length; r++) {
      for (let c = 0; c < sp.width && c < baseData[r].length; c++) {
        const tileId = baseData[r][c];
        if (tileId > 0) {
          const t = getTileById(tileId);
          if (t) drawTileAt(ctx, t, c * SP_TILE_PX, r * SP_TILE_PX, SP_TILE_PX);
          else { ctx.fillStyle = '#335'; ctx.fillRect(c * SP_TILE_PX, r * SP_TILE_PX, SP_TILE_PX, SP_TILE_PX); }
        }
      }
    }
  }

  // Draw collision layer on top
  const collData = sp.collisionLayout;
  if (collData) {
    for (let r = 0; r < sp.height && r < collData.length; r++) {
      for (let c = 0; c < sp.width && c < collData[r].length; c++) {
        const tileId = collData[r][c];
        if (tileId > 0) {
          const t = getTileById(tileId);
          if (t) drawTileAt(ctx, t, c * SP_TILE_PX, r * SP_TILE_PX, SP_TILE_PX);
        }
      }
    }
  }

  // Grid overlay
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  for (let r = 0; r <= sp.height; r++) {
    ctx.beginPath(); ctx.moveTo(0, r * SP_TILE_PX); ctx.lineTo(sp.width * SP_TILE_PX, r * SP_TILE_PX); ctx.stroke();
  }
  for (let c = 0; c <= sp.width; c++) {
    ctx.beginPath(); ctx.moveTo(c * SP_TILE_PX, 0); ctx.lineTo(c * SP_TILE_PX, sp.height * SP_TILE_PX); ctx.stroke();
  }
}

function drawTileAt(ctx, tile, x, y, size) {
  const img = images[tile.spriteKey];
  if (!img) { ctx.fillStyle = '#555'; ctx.fillRect(x, y, size, size); return; }
  const ts = tile.size || 32;
  const srcSize = ts === 32 ? 8 : ts;
  ctx.drawImage(img, tile.col * srcSize, tile.row * srcSize, srcSize, srcSize, x, y, size, size);
}

function updateSpBrushInfo() {
  const info = document.getElementById('spBrushInfo');
  if (!info) return;
  if (spBrushTileId < 0) {
    info.innerHTML = 'Brush: (none)';
  } else {
    const tile = getTileById(spBrushTileId);
    const cvs = document.createElement('canvas'); cvs.width = 20; cvs.height = 20;
    if (tile) drawTilePreview(cvs, tile);
    info.innerHTML = '';
    info.appendChild(document.createTextNode('Brush: '));
    info.appendChild(cvs);
    info.appendChild(document.createTextNode(` ${tile ? tile.name : spBrushTileId}`));
  }
}

function paintSpCell(row, col) {
  if (!selectedSetPiece || spBrushTileId < 0) return;
  const sp = selectedSetPiece;
  if (row < 0 || row >= sp.height || col < 0 || col >= sp.width) return;
  const layer = document.getElementById('spLayerSelect') ? document.getElementById('spLayerSelect').value : '0';
  const layout = layer === '1' ? sp.collisionLayout : sp.baseLayout;
  if (!layout || !layout[row]) return;
  if (layout[row][col] === spBrushTileId) return;
  layout[row][col] = spBrushTileId;
  markDirty('setpieces');
  // Redraw just the cell
  const cvs = document.getElementById('spCanvas');
  const ctx = cvs.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const x = col * SP_TILE_PX, y = row * SP_TILE_PX;
  // Redraw base
  ctx.fillStyle = '#111'; ctx.fillRect(x, y, SP_TILE_PX, SP_TILE_PX);
  const baseId = sp.baseLayout && sp.baseLayout[row] ? sp.baseLayout[row][col] : 0;
  if (baseId > 0) { const t = getTileById(baseId); if (t) drawTileAt(ctx, t, x, y, SP_TILE_PX); }
  const collId = sp.collisionLayout && sp.collisionLayout[row] ? sp.collisionLayout[row][col] : 0;
  if (collId > 0) { const t = getTileById(collId); if (t) drawTileAt(ctx, t, x, y, SP_TILE_PX); }
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.strokeRect(x, y, SP_TILE_PX, SP_TILE_PX);
}

function initSpCanvasEvents() {
  const cvs = document.getElementById('spCanvas');
  if (!cvs) return;
  cvs.addEventListener('mousedown', (e) => {
    spPainting = true;
    const rect = cvs.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / SP_TILE_PX);
    const row = Math.floor((e.clientY - rect.top) / SP_TILE_PX);
    paintSpCell(row, col);
  });
  cvs.addEventListener('mousemove', (e) => {
    if (!spPainting) return;
    const rect = cvs.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / SP_TILE_PX);
    const row = Math.floor((e.clientY - rect.top) / SP_TILE_PX);
    paintSpCell(row, col);
  });
  window.addEventListener('mouseup', () => { spPainting = false; });
}

// ========== REALM EVENTS ==========
async function loadRealmEvents() {
  try {
    realmEvents = await (await fetch(`${BASE}/realm-events.json`)).json();
    realmEvents.sort((a, b) => a.eventId - b.eventId);
  } catch (e) { realmEvents = []; }
  const el = document.getElementById('reCount');
  if (el) el.textContent = realmEvents.length;
}

function renderRealmEventList(filter = '') {
  const list = document.getElementById('reListView');
  if (!list) return;
  list.innerHTML = '';
  const lf = filter.toLowerCase();
  realmEvents.filter(ev => !lf || ev.name.toLowerCase().includes(lf) || String(ev.eventId).includes(lf))
    .forEach(ev => {
      const row = document.createElement('div');
      row.className = 'tile-row' + (selectedRealmEvent === ev ? ' selected' : '');
      const bossName = enemies.find(e => e.enemyId === ev.bossEnemyId);
      row.innerHTML = `<span class="tile-id">${ev.eventId}</span><span class="tile-name">${ev.name}</span><span class="tile-flags"><span class="flag flag-c">${ev.durationSeconds}s</span></span>`;
      row.addEventListener('click', () => selectRealmEvent(ev));
      list.appendChild(row);
    });
}

function selectRealmEvent(ev) {
  selectedRealmEvent = ev;
  renderRealmEventList();
  const detail = document.getElementById('reDetail');
  if (!detail) return;
  detail.style.display = '';
  document.getElementById('reId').value = ev.eventId;
  document.getElementById('reName').value = ev.name;
  document.getElementById('reBossId').value = ev.bossEnemyId;
  document.getElementById('reEventMult').value = ev.eventMultiplier;
  document.getElementById('reSetPieceId').value = ev.setPieceId;
  document.getElementById('reDuration').value = ev.durationSeconds;
  document.getElementById('reAnnounce').value = ev.announceMessage || '';
  document.getElementById('reDefeat').value = ev.defeatMessage || '';
  document.getElementById('reTimeout').value = ev.timeoutMessage || '';
  document.getElementById('reZones').value = (ev.allowedZones || []).join(', ');
  renderMinionWaves();
}

function applyRealmEvent() {
  if (!selectedRealmEvent) return;
  const ev = selectedRealmEvent;
  ev.name = document.getElementById('reName').value;
  ev.bossEnemyId = parseInt(document.getElementById('reBossId').value) || 0;
  ev.eventMultiplier = parseInt(document.getElementById('reEventMult').value) || 1;
  ev.setPieceId = parseInt(document.getElementById('reSetPieceId').value) || -1;
  ev.durationSeconds = parseInt(document.getElementById('reDuration').value) || 300;
  ev.announceMessage = document.getElementById('reAnnounce').value;
  ev.defeatMessage = document.getElementById('reDefeat').value;
  ev.timeoutMessage = document.getElementById('reTimeout').value;
  ev.allowedZones = document.getElementById('reZones').value.split(',').map(s => s.trim()).filter(Boolean);
  markDirty('realmEvents');
  renderRealmEventList();
}

function addRealmEvent() {
  const maxId = realmEvents.reduce((max, ev) => Math.max(max, ev.eventId), -1);
  const ev = {
    eventId: maxId + 1, name: 'New_Event_' + (maxId + 1),
    announceMessage: 'A %s has appeared!', defeatMessage: 'The event boss has been defeated!',
    timeoutMessage: 'The event boss has vanished...', bossEnemyId: 1, eventMultiplier: 4,
    setPieceId: -1, allowedZones: ['grasslands'], durationSeconds: 300, minionWaves: []
  };
  realmEvents.push(ev);
  realmEvents.sort((a, b) => a.eventId - b.eventId);
  markDirty('realmEvents');
  selectRealmEvent(ev);
  renderRealmEventList();
}

function renderMinionWaves() {
  const container = document.getElementById('reWaves');
  if (!container || !selectedRealmEvent) return;
  container.innerHTML = '';
  const waves = selectedRealmEvent.minionWaves || [];
  waves.forEach((w, i) => {
    const enemyName = enemies.find(e => e.enemyId === w.enemyId);
    const div = document.createElement('div');
    div.style.cssText = 'background:#1a1a2e;padding:6px;border-radius:4px;margin-bottom:4px;font-size:11px';
    div.innerHTML = `<b>Wave ${i + 1}</b> @${Math.round(w.triggerHpPercent * 100)}% HP: ${w.count}x enemy#${w.enemyId}${enemyName ? ' (' + enemyName.name + ')' : ''} hp×${w.eventMultiplier} offset=${w.offset}px `
      + `<button onclick="removeWave(${i})" style="font-size:10px;color:#f66;background:none;border:1px solid #f66;padding:1px 4px;cursor:pointer">X</button>`;
    container.appendChild(div);
  });
}

function addMinionWave() {
  if (!selectedRealmEvent) return;
  if (!selectedRealmEvent.minionWaves) selectedRealmEvent.minionWaves = [];
  selectedRealmEvent.minionWaves.push({ triggerHpPercent: 0.5, enemyId: 1, count: 4, eventMultiplier: 2, offset: 128 });
  markDirty('realmEvents');
  renderMinionWaves();
}

function removeWave(idx) {
  if (!selectedRealmEvent || !selectedRealmEvent.minionWaves) return;
  selectedRealmEvent.minionWaves.splice(idx, 1);
  markDirty('realmEvents');
  renderMinionWaves();
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('tilesTab').style.display = tab === 'tiles' ? '' : 'none';
  document.getElementById('terrainsTab').style.display = tab === 'terrains' ? '' : 'none';
  document.getElementById('mapsTab').style.display = tab === 'maps' ? '' : 'none';
  document.getElementById('itemsTab').style.display = tab === 'items' ? '' : 'none';
  document.getElementById('enemiesTab').style.display = tab === 'enemies' ? '' : 'none';
  document.getElementById('projgroupsTab').style.display = tab === 'projgroups' ? '' : 'none';
  document.getElementById('lootgroupsTab').style.display = tab === 'lootgroups' ? '' : 'none';
  document.getElementById('animationsTab').style.display = tab === 'animations' ? '' : 'none';
  document.getElementById('portalsTab').style.display = tab === 'portals' ? '' : 'none';
  document.getElementById('setpiecesTab').style.display = tab === 'setpieces' ? '' : 'none';
  document.getElementById('realmeventsTab').style.display = tab === 'realmevents' ? '' : 'none';
  if (tab === 'lootgroups') renderLgList();
  if (tab === 'animations') renderAnimList();
  if (tab === 'portals') renderPortalList();
  if (tab === 'setpieces') renderSetPieceList();
  if (tab === 'realmevents') renderRealmEventList();
}

// ========== SAVE ==========
function markDirty(which) {
  if (which === 'tiles') dirtyTiles = true;
  if (which === 'terrains') dirtyTerrains = true;
  if (which === 'items') dirtyItems = true;
  if (which === 'projGroups') dirtyProjGroups = true;
  if (which === 'maps') dirtyMaps = true;
  if (which === 'enemies') dirtyEnemies = true;
  if (which === 'lootGroups') dirtyLootGroups = true;
  if (which === 'lootTables') dirtyLootTables = true;
  if (which === 'animations') dirtyAnimations = true;
  if (which === 'portals') dirtyPortals = true;
  if (which === 'setpieces') dirtySetPieces = true;
  if (which === 'realmEvents') dirtyRealmEvents = true;
  saveBtn.disabled = false;
  const parts = [];
  if (dirtyTiles) parts.push('tiles');
  if (dirtyTerrains) parts.push('terrains');
  if (dirtyItems) parts.push('items');
  if (dirtyProjGroups) parts.push('projectiles');
  if (dirtyMaps) parts.push('maps');
  if (dirtyEnemies) parts.push('enemies');
  if (dirtyLootGroups) parts.push('loot groups');
  if (dirtyLootTables) parts.push('loot tables');
  if (dirtyAnimations) parts.push('animations');
  if (dirtyPortals) parts.push('portals');
  if (dirtySetPieces) parts.push('set pieces');
  if (dirtyRealmEvents) parts.push('realm events');
  saveStatus.textContent = `(unsaved: ${parts.join(', ')})`;
  saveStatus.style.color = '#fa0';
}

function _isLocalhost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function _downloadJson(filename, data, indent) {
  const blob = new Blob([JSON.stringify(data, null, indent || '\t')], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

async function saveAll() {
  const isLocal = _isLocalhost();
  saveBtn.disabled = true;
  saveStatus.textContent = isLocal ? 'Saving...' : 'Downloading...';
  saveStatus.style.color = '#ff0';

  // Map of dirty flag -> { endpoint, filename, data, indent, dirtyRef }
  const sections = [
    { dirty: () => dirtyTiles,       clear: () => { dirtyTiles = false; },       endpoint: '/gamedata/tiles',       filename: 'tiles.json',        data: tiles,       indent: 4,     label: 'tiles' },
    { dirty: () => dirtyTerrains,    clear: () => { dirtyTerrains = false; },    endpoint: '/gamedata/terrains',    filename: 'terrains.json',     data: terrains,    indent: '\t',  label: 'terrains' },
    { dirty: () => dirtyItems,       clear: () => { dirtyItems = false; },       endpoint: '/gamedata/items',       filename: 'game-items.json',   data: items,       indent: '\t',  label: 'items' },
    { dirty: () => dirtyProjGroups,  clear: () => { dirtyProjGroups = false; },  endpoint: '/gamedata/projectiles', filename: 'projectile-groups.json', data: projGroups, indent: '\t', label: 'projectiles' },
    { dirty: () => dirtyMaps,        clear: () => { dirtyMaps = false; },        endpoint: '/gamedata/maps',        filename: 'maps.json',         data: maps,        indent: '\t',  label: 'maps' },
    { dirty: () => dirtyEnemies,     clear: () => { dirtyEnemies = false; },     endpoint: '/gamedata/enemies',     filename: 'enemies.json',      data: enemies,     indent: '\t',  label: 'enemies' },
    { dirty: () => dirtyLootGroups,  clear: () => { dirtyLootGroups = false; },  endpoint: '/gamedata/lootgroups',  filename: 'loot-groups.json',  data: lootGroups,  indent: '\t',  label: 'loot groups' },
    { dirty: () => dirtyLootTables,  clear: () => { dirtyLootTables = false; },  endpoint: '/gamedata/loottables',  filename: 'loot-tables.json',  data: lootTables,  indent: '\t',  label: 'loot tables' },
    { dirty: () => dirtyAnimations,  clear: () => { dirtyAnimations = false; },  endpoint: '/gamedata/animations',  filename: 'animations.json',   data: animations,  indent: '\t',  label: 'animations' },
    { dirty: () => dirtyPortals,     clear: () => { dirtyPortals = false; },     endpoint: '/gamedata/portals',     filename: 'portals.json',      data: portals,     indent: '\t',  label: 'portals' },
    { dirty: () => dirtySetPieces,   clear: () => { dirtySetPieces = false; },   endpoint: '/gamedata/setpieces',   filename: 'setpieces.json',    data: setpieces,   indent: '\t',  label: 'set pieces' },
    { dirty: () => dirtyRealmEvents, clear: () => { dirtyRealmEvents = false; }, endpoint: '/gamedata/realm-events', filename: 'realm-events.json', data: realmEvents, indent: '\t',  label: 'realm events' },
  ];

  try {
    const results = [];
    for (const sec of sections) {
      if (!sec.dirty()) continue;
      if (isLocal) {
        // Local dev: save to filesystem via server endpoint
        const res = await fetch(sec.endpoint, {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(sec.data, null, sec.indent)
        });
        if (!res.ok) throw new Error(sec.label + ': ' + res.statusText);
      } else {
        // Production: download file to user's machine
        _downloadJson(sec.filename, sec.data, sec.indent);
      }
      sec.clear();
      results.push(sec.label);
    }
    if (results.length === 0) {
      saveStatus.textContent = 'Nothing to save';
      saveStatus.style.color = '#aaa';
    } else {
      saveStatus.textContent = isLocal
        ? `Saved ${results.join(', ')}!`
        : `Downloaded ${results.join(', ')}!`;
      saveStatus.style.color = '#8f8';
    }
  } catch (e) {
    saveStatus.textContent = 'Error: ' + e.message;
    saveStatus.style.color = '#f88';
  }
  saveBtn.disabled = false;
}

// ========== EVENTS ==========
function bindEvents() {
  sheetSelect.addEventListener('change', () => { currentSheet = sheetSelect.value; renderSheet(); });
  gridSizeSelect.addEventListener('change', () => { gridSize = parseInt(gridSizeSelect.value) || 8; renderSheet(); });
  document.getElementById('gridHeight').addEventListener('change', () => { gridHeight = parseInt(document.getElementById('gridHeight').value) || 0; renderSheet(); });

  // Tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Sheet hover
  const scrollEl = document.querySelector('.sheet-scroll');
  scrollEl.addEventListener('mousemove', (e) => {
    const rect = sheetCanvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / (gridSize * SCALE));
    const row = Math.floor((e.clientY - rect.top) / (getGridH() * SCALE));
    hoverInfo.textContent = pickMode
      ? `Click to pick: Row ${row}, Col ${col}`
      : `Row: ${row}  Col: ${col}  (px: ${col * gridSize}, ${row * getGridH()})`;
    scrollEl.style.cursor = pickMode ? 'crosshair' : '';
  });

  // Sheet click - pick sprite (works for both tiles and items)
  scrollEl.addEventListener('click', (e) => {
    if (!pickMode) return;
    const rect = sheetCanvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / (gridSize * SCALE));
    const row = Math.floor((e.clientY - rect.top) / (getGridH() * SCALE));

    if (activeTab === 'tiles' && selectedTile) {
      document.getElementById('detailRow').value = row;
      document.getElementById('detailCol').value = col;
      document.getElementById('detailSprite').value = currentSheet;
      updatePreview();
      applyDetail();
      pickBtn.classList.remove('active');
      pickBtn.textContent = 'Pick from Sheet';
    } else if (activeTab === 'items' && selectedItem) {
      document.getElementById('itemRow').value = row;
      document.getElementById('itemCol').value = col;
      document.getElementById('itemSprite').value = currentSheet;
      applyItemDetail();
      document.getElementById('pickItemSpriteBtn').classList.remove('active');
      document.getElementById('pickItemSpriteBtn').textContent = 'Pick Sprite';
    } else if (activeTab === 'enemies' && selectedEnemy) {
      document.getElementById('enemyRow').value = row;
      document.getElementById('enemyCol').value = col;
      document.getElementById('enemySprite').value = currentSheet;
      document.getElementById('enemySpriteSize').value = gridSize;
      document.getElementById('enemySpriteHeight').value = gridHeight;
      updateEnemyPreview();
      applyEnemyDetail();
      const btn = document.getElementById('pickEnemySpriteBtn');
      btn.classList.remove('active');
      btn.textContent = 'Pick Sprite';
    } else if (activeTab === 'projgroups' && selectedPgTab) {
      document.getElementById('pgDetailRow').value = row;
      document.getElementById('pgDetailCol').value = col;
      document.getElementById('pgDetailSprite').value = currentSheet;
      updatePgTabPreview();
      applyPgTabDetail();
      const btn = document.getElementById('pickPgSpriteBtn');
      btn.classList.remove('active');
      btn.textContent = 'Pick Sprite';
    } else if (activeTab === 'portals' && selectedPortal) {
      document.getElementById('portalRow').value = row;
      document.getElementById('portalCol').value = col;
      document.getElementById('portalSprite').value = currentSheet;
      updatePortalPreview();
      applyPortalDetail();
      const btn = document.getElementById('pickPortalSpriteBtn');
      btn.classList.remove('active');
      btn.textContent = 'Pick Sprite';
    } else if (activeTab === 'animations' && animPickingFrame) {
      const { anim, animName, frameIdx } = animPickingFrame;
      // If picking from a different sheet, update the animation's spriteKey to match
      if (currentSheet !== anim.spriteKey) {
        anim.spriteKey = currentSheet;
        document.getElementById('animSpriteKey').value = currentSheet;
      }
      // Also sync sprite size to current grid size
      anim.spriteSize = gridSize;
      anim.spriteHeight = gridHeight;
      document.getElementById('animSpriteSize').value = gridSize;
      document.getElementById('animSpriteHeight').value = gridHeight;
      anim.animations[animName].frames[frameIdx] = { row, col };
      markDirty('animations');
      renderAnimSets(anim);
      updateAnimPreview(anim);
      animPickingFrame = null;
    }
    pickMode = false;
  });

  tileSearch.addEventListener('input', () => renderTileList(tileSearch.value));
  document.getElementById('terrainSearch').addEventListener('input', (e) => renderTerrainList(e.target.value));

  saveBtn.addEventListener('click', saveAll);
  // Show download vs save label based on environment
  if (!_isLocalhost()) {
    saveBtn.textContent = 'Download All';
  }
  addTileBtn.addEventListener('click', addTile);
  deleteTileBtn.addEventListener('click', deleteTile);
  applyBtn.addEventListener('click', applyDetail);
  goToSheetBtn.addEventListener('click', goToSheet);

  pickBtn.addEventListener('click', () => {
    pickMode = !pickMode;
    pickBtn.classList.toggle('active', pickMode);
    pickBtn.textContent = pickMode ? 'Click on Sheet...' : 'Pick from Sheet';
  });

  ['detailRow', 'detailCol', 'detailSprite'].forEach(id => {
    document.getElementById(id).addEventListener('change', updatePreview);
    document.getElementById(id).addEventListener('input', updatePreview);
  });

  document.getElementById('terrainBackBtn').addEventListener('click', deselectTerrain);
  document.getElementById('saveTerrainBtn').addEventListener('click', () => { markDirty('terrains'); });

  // Items
  document.getElementById('itemSearch').addEventListener('input', (e) => renderItemList(e.target.value));
  document.getElementById('addItemBtn').addEventListener('click', addItem);
  document.getElementById('itemBackBtn').addEventListener('click', deselectItem);
  document.getElementById('applyItemBtn').addEventListener('click', applyItemDetail);
  document.getElementById('viewProjGroupBtn').addEventListener('click', viewProjGroup);
  document.getElementById('editProjGroupTabBtn').addEventListener('click', () => {
    const pgId = parseInt(document.getElementById('dmgProjGroup').value);
    if (pgId >= 0) navigateToProjGroup(pgId);
  });
  document.getElementById('pickItemSpriteBtn').addEventListener('click', () => {
    pickMode = !pickMode;
    const btn = document.getElementById('pickItemSpriteBtn');
    btn.classList.toggle('active', pickMode);
    btn.textContent = pickMode ? 'Click on Sheet...' : 'Pick Sprite';
  });
  document.getElementById('goToItemSheetBtn').addEventListener('click', () => {
    if (!selectedItem) return;
    if (selectedItem.spriteKey !== currentSheet) {
      currentSheet = selectedItem.spriteKey; sheetSelect.value = currentSheet; renderSheet();
    }
    const ss = gridSize;
    const px = selectedItem.col * ss * SCALE, py = selectedItem.row * ss * SCALE;
    const scroll = document.querySelector('.sheet-scroll');
    scroll.scrollTo({ left: px - scroll.clientWidth / 2, top: py - scroll.clientHeight / 2, behavior: 'smooth' });
  });

  // Simulate from item detail — fires the item's projectile group in player mode
  document.getElementById('simItemProjBtn').addEventListener('click', () => {
    const pgId = parseInt(document.getElementById('dmgProjGroup').value);
    if (pgId < 0) return;
    applyItemDetail();
    const pg = getProjGroupById(pgId);
    if (!pg) { alert('Projectile group ' + pgId + ' not found'); return; }
    const name = selectedItem ? selectedItem.name : 'Item';
    document.getElementById('simMode').value = 'player';
    const dex = selectedItem && selectedItem.stats ? (selectedItem.stats.dex || 0) : 0;
    document.getElementById('simDex').value = Math.max(10, 30 + dex);
    SIM.open(pg, `${name} — Simulate (Group ${pgId})`);
  });

  // Simulate from inline projectile group editor
  document.getElementById('simInlinePgBtn').addEventListener('click', () => {
    if (!selectedProjGroup) return;
    applyProjGroup();
    document.getElementById('simMode').value = 'player';
    SIM.open(selectedProjGroup, `Projectile Group ${selectedProjGroup.projectileGroupId} — Simulate`);
  });

  // Projectile groups
  document.getElementById('projGroupBackBtn').addEventListener('click', closeProjGroup);
  document.getElementById('applyProjGroupBtn').addEventListener('click', applyProjGroup);
  document.getElementById('addProjBtn').addEventListener('click', addProjectile);

  // Maps
  document.getElementById('mapSearch').addEventListener('input', (e) => renderMapList(e.target.value));
  document.getElementById('addMapBtn').addEventListener('click', addMap);
  document.getElementById('mapBackBtn').addEventListener('click', deselectMap);
  document.getElementById('mapLayerSelect').addEventListener('change', renderMapCanvas);
  document.getElementById('mapShowGrid').addEventListener('change', drawMapOverlay);
  document.getElementById('mapPickTileBtn').addEventListener('click', () => {
    openTilePicker((tileId) => {
      mapBrushTileId = tileId;
      updateMapBrushInfo();
    });
  });

  // Map setpiece stamping
  document.getElementById('mapStampSpBtn').addEventListener('click', startStampSetPiece);

  // SetPiece editor
  document.getElementById('spPickTileBtn').addEventListener('click', () => {
    openTilePicker((tileId) => {
      spBrushTileId = tileId;
      updateSpBrushInfo();
    });
  });
  document.getElementById('spLayerSelect').addEventListener('change', renderSpCanvas);
  initSpCanvasEvents();
  document.getElementById('applyMapBtn').addEventListener('click', () => { markDirty('maps'); });
  document.getElementById('mapPlaceEnemyBtn').addEventListener('click', startPlaceEnemy);
  document.getElementById('mapCancelPlaceBtn').addEventListener('click', cancelPlaceEnemy);
  document.getElementById('applyDungeonBtn').addEventListener('click', applyDungeonParams);
  document.getElementById('dpAddFloorTileBtn').addEventListener('click', addDungeonFloorTile);
  document.getElementById('dpWallTile').addEventListener('change', updateDpWallTilePreview);
  document.getElementById('dpBossEnemy').addEventListener('change', updateDpBossEnemyPreview);
  document.getElementById('dpPickWallTileBtn').addEventListener('click', () => {
    openTilePicker((tileId) => {
      document.getElementById('dpWallTile').value = tileId;
      updateDpWallTilePreview();
    });
  });
  document.getElementById('dpPickBossEnemyBtn').addEventListener('click', () => {
    openEnemyPicker((enemy) => {
      document.getElementById('dpBossEnemy').value = enemy.enemyId;
      updateDpBossEnemyPreview();
    });
  });

  // Map canvas paint events
  const mapOverlay = document.getElementById('mapOverlayCanvas');
  mapOverlay.addEventListener('mousedown', (e) => { mapPainting = true; mapCanvasClick(e); });
  mapOverlay.addEventListener('mousemove', (e) => { mapCanvasHover(e); mapCanvasDrag(e); });
  document.addEventListener('mouseup', () => { mapPainting = false; });
  mapOverlay.addEventListener('mouseleave', () => { mapPainting = false; });

  // Right-click to erase (set to 0)
  mapOverlay.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!selectedMap || !selectedMap.data) return;
    const rect = mapOverlay.getBoundingClientRect();
    const scaleX = mapOverlay.width / rect.width;
    const scaleY = mapOverlay.height / rect.height;
    const col = Math.floor((e.clientX - rect.left) * scaleX / MAP_TILE_PX);
    const row = Math.floor((e.clientY - rect.top) * scaleY / MAP_TILE_PX);
    const layer = getMapLayer();
    if (row >= 0 && row < selectedMap.height && col >= 0 && col < selectedMap.width) {
      selectedMap.data[layer][row][col] = 0;
      markDirty('maps');
      redrawMapCell(row, col);
    }
  });

  // Enemies
  document.getElementById('enemySearch').addEventListener('input', (e) => renderEnemyList(e.target.value));
  document.getElementById('enemyBackBtn').addEventListener('click', deselectEnemy);
  document.getElementById('applyEnemyBtn').addEventListener('click', applyEnemyDetail);
  document.getElementById('addEnemyBtn').addEventListener('click', addEnemy);
  document.getElementById('deleteEnemyBtn').addEventListener('click', deleteEnemy);
  document.getElementById('addPhaseBtn').addEventListener('click', addPhase);
  document.getElementById('editAttackIdBtn').addEventListener('click', () => {
    const atkId = parseInt(document.getElementById('enemyAttackId').value);
    if (atkId >= 0) navigateToProjGroup(atkId);
  });
  document.getElementById('enemyAttackId').addEventListener('change', () => {
    if (!selectedEnemy) return;
    const atkId = parseInt(document.getElementById('enemyAttackId').value);
    const info = document.getElementById('attackIdInfo');
    const btn = document.getElementById('editAttackIdBtn');
    if (atkId === -1) { info.textContent = '(Server-scripted attack)'; info.style.color = '#c8a86e'; btn.style.display = 'none'; }
    else { const pg = getProjGroupById(atkId); info.textContent = pg ? '(Proj Group exists)' : '(Group not found!)'; info.style.color = pg ? '#4a4' : '#e44'; btn.style.display = 'inline-block'; }
  });
  document.getElementById('pickEnemySpriteBtn').addEventListener('click', () => {
    pickMode = !pickMode;
    const btn = document.getElementById('pickEnemySpriteBtn');
    btn.classList.toggle('active', pickMode);
    btn.textContent = pickMode ? 'Click on Sheet...' : 'Pick Sprite';
  });
  document.getElementById('goToEnemySheetBtn').addEventListener('click', () => {
    if (!selectedEnemy) return;
    const ss = parseInt(document.getElementById('enemySpriteSize').value) || 8;
    const esh = parseInt(document.getElementById('enemySpriteHeight').value) || ss;
    if (selectedEnemy.spriteKey !== currentSheet) {
      currentSheet = selectedEnemy.spriteKey; sheetSelect.value = currentSheet; renderSheet();
    }
    const px = selectedEnemy.col * ss * SCALE, py = selectedEnemy.row * esh * SCALE;
    const scroll = document.querySelector('.sheet-scroll');
    scroll.scrollTo({ left: px - scroll.clientWidth / 2, top: py - scroll.clientHeight / 2, behavior: 'smooth' });
  });
  ['enemyRow','enemyCol','enemySprite','enemySpriteSize','enemySpriteHeight'].forEach(id => {
    document.getElementById(id).addEventListener('change', updateEnemyPreview);
    document.getElementById(id).addEventListener('input', updateEnemyPreview);
  });

  // Projectile Groups tab
  document.getElementById('pgSearch').addEventListener('input', (e) => renderPgTabList(e.target.value));
  document.getElementById('pgBackBtn').addEventListener('click', deselectPgTab);
  document.getElementById('applyPgDetailBtn').addEventListener('click', applyPgTabDetail);
  document.getElementById('addPgBtn').addEventListener('click', addPgTab);
  document.getElementById('deletePgBtn').addEventListener('click', deletePgTab);
  document.getElementById('addPgProjBtn').addEventListener('click', addPgTabProjectile);
  document.getElementById('pickPgSpriteBtn').addEventListener('click', () => {
    pickMode = !pickMode;
    const btn = document.getElementById('pickPgSpriteBtn');
    btn.classList.toggle('active', pickMode);
    btn.textContent = pickMode ? 'Click on Sheet...' : 'Pick Sprite';
  });
  document.getElementById('goToPgSheetBtn').addEventListener('click', () => {
    if (!selectedPgTab) return;
    if (selectedPgTab.spriteKey !== currentSheet) {
      currentSheet = selectedPgTab.spriteKey; sheetSelect.value = currentSheet; renderSheet();
    }
    const ss = gridSize;
    const px = (selectedPgTab.col || 0) * ss * SCALE, py = (selectedPgTab.row || 0) * ss * SCALE;
    const scroll = document.querySelector('.sheet-scroll');
    scroll.scrollTo({ left: px - scroll.clientWidth / 2, top: py - scroll.clientHeight / 2, behavior: 'smooth' });
  });
  ['pgDetailRow','pgDetailCol','pgDetailSprite'].forEach(id => {
    document.getElementById(id).addEventListener('change', updatePgTabPreview);
    document.getElementById(id).addEventListener('input', updatePgTabPreview);
  });

  // Animations tab
  document.getElementById('animSearch').addEventListener('input', (e) => renderAnimList(e.target.value));
  document.getElementById('animBackBtn').addEventListener('click', deselectAnim);
  document.getElementById('applyAnimBtn').addEventListener('click', applyAnimDetail);
  document.getElementById('animSpriteKey').addEventListener('change', () => {
    applyAnimDetail();
    // Sync top sheet dropdown to the animation's sheet so picking works
    const newSheet = document.getElementById('animSpriteKey').value;
    if (newSheet !== currentSheet) {
      currentSheet = newSheet;
      sheetSelect.value = currentSheet;
      renderSheet();
    }
  });
  document.getElementById('animSpriteSize').addEventListener('change', () => {
    applyAnimDetail();
    // Sync grid size to the animation's sprite size
    const newSize = parseInt(document.getElementById('animSpriteSize').value) || 8;
    if (newSize !== gridSize) {
      gridSize = newSize;
      gridSizeSelect.value = gridSize;
      renderSheet();
    }
  });
  document.getElementById('animSpriteHeight').addEventListener('change', () => {
    applyAnimDetail();
    const newH = parseInt(document.getElementById('animSpriteHeight').value) || 0;
    if (newH !== gridHeight) {
      gridHeight = newH;
      document.getElementById('gridHeight').value = gridHeight;
      renderSheet();
    }
  });

  // Loot Groups tab
  document.getElementById('lgSearch').addEventListener('input', (e) => renderLgList(e.target.value));
  document.getElementById('lgBackBtn').addEventListener('click', deselectLootGroup);
  document.getElementById('applyLgBtn').addEventListener('click', applyLgDetail);
  document.getElementById('addLgBtn').addEventListener('click', addLootGroup);
  document.getElementById('deleteLgBtn').addEventListener('click', deleteLootGroup);
  document.getElementById('lgAddItemBtn').addEventListener('click', addItemToLootGroup);

  // Portals
  document.getElementById('portalSearch').addEventListener('input', (e) => renderPortalList(e.target.value));
  document.getElementById('portalBackBtn').addEventListener('click', deselectPortal);
  document.getElementById('applyPortalBtn').addEventListener('click', applyPortalDetail);
  document.getElementById('addPortalBtn').addEventListener('click', addPortal);
  document.getElementById('deletePortalBtn').addEventListener('click', deletePortal);
  document.getElementById('pickPortalSpriteBtn').addEventListener('click', () => {
    pickMode = !pickMode;
    const btn = document.getElementById('pickPortalSpriteBtn');
    btn.classList.toggle('active', pickMode);
    btn.textContent = pickMode ? 'Click on Sheet...' : 'Pick Sprite';
  });
  document.getElementById('portalSprite').addEventListener('change', updatePortalPreview);
  document.getElementById('portalRow').addEventListener('change', updatePortalPreview);
  document.getElementById('portalCol').addEventListener('change', updatePortalPreview);

  // Tile picker modal
  document.getElementById('pickerCloseBtn').addEventListener('click', closeTilePicker);
  document.getElementById('pickerSearch').addEventListener('input', (e) => renderPickerList(e.target.value));
  document.getElementById('tilePickerOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeTilePicker();
  });

  // Enemy picker modal
  document.getElementById('enemyPickerCloseBtn').addEventListener('click', closeEnemyPicker);
  document.getElementById('enemyPickerSearch').addEventListener('input', (e) => renderEnemyPickerList(e.target.value));
  document.getElementById('enemyPickerOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeEnemyPicker();
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirtyTiles || dirtyTerrains || dirtyItems || dirtyProjGroups || dirtyMaps || dirtyEnemies || dirtyLootGroups || dirtyLootTables || dirtyAnimations) { e.preventDefault(); e.returnValue = ''; }
  });

  // Resize handle drag
  const handle = document.getElementById('resizeHandle');
  let resizing = false;
  handle.addEventListener('mousedown', (e) => {
    resizing = true;
    handle.classList.add('dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const panels = document.querySelectorAll('.tile-panel');
    const newWidth = Math.max(300, window.innerWidth - e.clientX);
    panels.forEach(p => p.style.width = newWidth + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (resizing) {
      resizing = false;
      handle.classList.remove('dragging');
    }
  });
}

// ========== PROJECTILE SIMULATOR ==========
const SIM = {
  overlay: null, canvas: null, ctx: null,
  bullets: [], animId: null, lastTime: 0,
  mouseX: 0, mouseY: 0, mouseDown: false,
  lastShotTime: 0, projGroup: null, attackPattern: null,
  burstState: null, // for multi-burst tracking
  enemy: null, // set when opened from enemy simulate button

  parseAngle(str) {
    if (str == null || str === '') return 0;
    if (typeof str === 'number') return str;
    const m = String(str).match(/\{\{(.+?)\}\}/);
    if (!m) return parseFloat(str) || 0;
    let expr = m[1].trim();
    expr = expr.replace(/(\d*\.?\d*)PI/g, (_, c) => ((c === '' ? 1 : parseFloat(c)) * Math.PI).toString());
    try { return Function('"use strict"; return (' + expr + ')')(); } catch { return 0; }
  },

  open(pgGroup, title, enemy) {
    this.projGroup = pgGroup;
    this.enemy = enemy || null;
    this.overlay = document.getElementById('projSimOverlay');
    this.canvas = document.getElementById('simCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.bullets = [];
    this.lastShotTime = 0;
    this.burstState = null;
    document.getElementById('simTitle').textContent = title || 'Projectile Simulator';
    document.getElementById('simSubtitle').textContent = pgGroup ? `Group ${pgGroup.projectileGroupId}` : '';
    if (enemy) this._populatePhases(enemy);
    this.overlay.style.display = 'flex';
    this.resize();
    this.bindEvents();
    this.lastTime = performance.now();
    this.loop();
  },

  close() {
    this.overlay.style.display = 'none';
    if (this.animId) cancelAnimationFrame(this.animId);
    this.animId = null;
    this.enemy = null;
    this.unbindEvents();
  },

  _populatePhases(enemy) {
    const sel = document.getElementById('simPhaseSelect');
    sel.innerHTML = '';
    const phases = enemy.phases || [];
    phases.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      const pct = Math.round((p.hpThreshold || 1) * 100);
      opt.textContent = `${p.name || 'Phase ' + i} (HP≤${pct}%)`;
      sel.appendChild(opt);
    });
    sel.value = '0';
    this._populateAttacks(phases[0]);
  },

  _populateAttacks(phase) {
    const sel = document.getElementById('simAttackSelect');
    sel.innerHTML = '';
    const attacks = (phase && phase.attacks) || [];
    attacks.forEach((atk, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `#${i + 1} (Group ${atk.projectileGroupId})`;
      sel.appendChild(opt);
    });
    sel.value = '0';
    if (attacks.length > 0) this._loadAttack(attacks[0]);
  },

  _loadAttack(atk) {
    const pg = projGroups.find(g => g.projectileGroupId === atk.projectileGroupId);
    if (pg) {
      this.projGroup = pg;
      document.getElementById('simSubtitle').textContent = `Group ${pg.projectileGroupId}`;
    }
    document.getElementById('simAimMode').value = atk.aimMode || 'PLAYER';
    document.getElementById('simCooldown').value = atk.cooldownMs || 1000;
    document.getElementById('simShotCount').value = atk.shotCount || 1;
    document.getElementById('simSpread').value = atk.spreadAngle || 0;
    document.getElementById('simBurstCount').value = atk.burstCount || 1;
    document.getElementById('simBurstDelay').value = atk.burstDelayMs || 100;
    document.getElementById('simBurstAngle').value = atk.angleOffsetPerBurst || 0;
    document.getElementById('simMirror').checked = !!atk.mirror;
    this.bullets = []; // clear bullets on attack switch
  },

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = r.width;
    this.canvas.height = r.height;
  },

  _bound: {},
  bindEvents() {
    this._bound.mm = (e) => { const r = this.canvas.getBoundingClientRect(); this.mouseX = e.clientX - r.left; this.mouseY = e.clientY - r.top; };
    this._bound.md = (e) => { if (e.button === 0) this.mouseDown = true; };
    this._bound.mu = (e) => { if (e.button === 0) this.mouseDown = false; };
    this._bound.rs = () => this.resize();
    this.canvas.addEventListener('mousemove', this._bound.mm);
    this.canvas.addEventListener('mousedown', this._bound.md);
    this.canvas.addEventListener('mouseup', this._bound.mu);
    window.addEventListener('resize', this._bound.rs);
  },
  unbindEvents() {
    this.canvas.removeEventListener('mousemove', this._bound.mm);
    this.canvas.removeEventListener('mousedown', this._bound.md);
    this.canvas.removeEventListener('mouseup', this._bound.mu);
    window.removeEventListener('resize', this._bound.rs);
  },

  getCenter() { return { x: this.canvas.width / 2, y: this.canvas.height / 2 }; },

  getAngle(sx, sy, tx, ty) {
    // Negate dy to convert screen-space (Y-down) to game-space (Y-up) before
    // computing the game-engine angle convention (atan2 - PI/2).
    return Math.atan2(-(ty - sy), tx - sx) - Math.PI / 2;
  },

  fireProjGroup(pg, srcX, srcY, baseAngle) {
    if (!pg || !pg.projectiles) return;
    for (const proj of pg.projectiles) {
      const posMode = proj.positionMode || 0;
      let angle;
      if (posMode === 0) { // TARGET_PLAYER - relative to aim direction
        angle = baseAngle + this.parseAngle(proj.angle);
      } else {
        angle = this.parseAngle(proj.angle);
      }
      const flags = proj.flags || [];
      const isParametric = flags.includes(12) || flags.includes(13);
      const isOrbital = flags.includes(20);
      const invert = flags.includes(13);

      const b = {
        x: srcX, y: srcY,
        angle, magnitude: proj.magnitude || 3,
        range: proj.range || 400,
        maxRange: proj.range || 400,
        size: proj.size || 16,
        damage: proj.damage || 0,
        amplitude: proj.amplitude || 0,
        frequency: proj.frequency || 0,
        timeStep: 0, invert,
        isParametric, isOrbital,
        orbitCX: srcX, orbitCY: srcY,
        orbitRadius: Math.abs(proj.amplitude || 50),
        orbitPhase: angle,
        createdTime: performance.now()
      };
      this.bullets.push(b);
    }
  },

  fireAttackPattern(pg, srcX, srcY, targetX, targetY) {
    const mode = document.getElementById('simAimMode').value;
    const shotCount = parseInt(document.getElementById('simShotCount').value) || 1;
    const spread = parseFloat(document.getElementById('simSpread').value) || 0;
    const burstCount = parseInt(document.getElementById('simBurstCount').value) || 1;
    const burstDelay = parseInt(document.getElementById('simBurstDelay').value) || 100;
    const burstAngleOff = parseFloat(document.getElementById('simBurstAngle').value) || 0;
    const mirror = document.getElementById('simMirror').checked;

    const doFire = (burstIdx) => {
      const fireAngle = (angle) => {
        this.fireProjGroup(pg, srcX, srcY, angle);
        if (mirror) this.fireProjGroup(pg, srcX, srcY, -angle);
      };

      if (mode === 'RING') {
        for (let s = 0; s < shotCount; s++) {
          const angle = (s * 2 * Math.PI / shotCount) + burstAngleOff * burstIdx;
          this.fireProjGroup(pg, srcX, srcY, angle); // ring doesn't mirror
        }
      } else if (mode === 'FIXED') {
        const fixedAngle = 0 + burstAngleOff * burstIdx;
        if (shotCount <= 1) {
          fireAngle(fixedAngle);
        } else {
          const half = spread / 2;
          for (let s = 0; s < shotCount; s++) {
            const t = shotCount > 1 ? s / (shotCount - 1) : 0.5;
            const a = fixedAngle - half + t * spread;
            fireAngle(a);
          }
        }
      } else { // PLAYER
        let baseAngle = this.getAngle(srcX, srcY, targetX, targetY);
        baseAngle += burstAngleOff * burstIdx;
        if (shotCount <= 1) {
          fireAngle(baseAngle);
        } else {
          const half = spread / 2;
          for (let s = 0; s < shotCount; s++) {
            const t = shotCount > 1 ? s / (shotCount - 1) : 0.5;
            const a = baseAngle - half + t * spread;
            fireAngle(a);
          }
        }
      }
    };

    // Handle burst
    if (burstCount <= 1) {
      doFire(0);
    } else {
      for (let b = 0; b < burstCount; b++) {
        setTimeout(() => doFire(b), b * burstDelay);
      }
    }
  },

  updateBullet(b, dt) {
    const scale = dt * 64;
    if (b.isOrbital) {
      b.orbitPhase += (b.frequency * scale) * Math.PI / 180;
      b.x = b.orbitCX + b.orbitRadius * Math.cos(b.orbitPhase);
      b.y = b.orbitCY + b.orbitRadius * Math.sin(b.orbitPhase);
      b.range -= b.orbitRadius * Math.abs((b.frequency * scale) * Math.PI / 180);
    } else if (b.isParametric) {
      const prevOff = b.amplitude * Math.sin(b.timeStep * Math.PI / 180);
      b.timeStep = (b.timeStep + b.frequency * scale) % 360;
      const currOff = b.amplitude * Math.sin(b.timeStep * Math.PI / 180);
      const perpDelta = (currOff - prevOff) * (b.invert ? -1 : 1);
      const fwdX = Math.sin(b.angle) * b.magnitude * scale;
      const fwdY = -Math.cos(b.angle) * b.magnitude * scale;
      const perpX = Math.cos(b.angle);
      const perpY = Math.sin(b.angle);
      b.x += fwdX + perpX * perpDelta;
      b.y += fwdY + perpY * perpDelta;
      b.range -= b.magnitude * scale;
    } else {
      const vx = Math.sin(b.angle) * b.magnitude * scale;
      const vy = -Math.cos(b.angle) * b.magnitude * scale;
      b.x += vx;
      b.y += vy;
      b.range -= Math.sqrt(vx * vx + vy * vy);
    }
  },

  loop() {
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const showTrails = document.getElementById('simShowTrails').checked;

    // Clear
    if (showTrails) {
      ctx.fillStyle = 'rgba(10,10,18,0.15)';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#0a0a12';
      ctx.fillRect(0, 0, W, H);
    }

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    const gs = 32;
    for (let x = (W / 2) % gs; x < W; x += gs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = (H / 2) % gs; y < H; y += gs) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    const center = this.getCenter();
    const simMode = document.getElementById('simMode').value;

    // Draw player/enemy source
    ctx.beginPath();
    ctx.arc(center.x, center.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = simMode === 'player' ? 'rgba(64,192,64,0.6)' : 'rgba(224,64,64,0.6)';
    ctx.fill();
    ctx.strokeStyle = simMode === 'player' ? '#4c4' : '#e44';
    ctx.lineWidth = 2;
    ctx.stroke();

    // In enemy mode, draw a target dummy
    if (simMode === 'enemy') {
      ctx.beginPath();
      ctx.arc(this.mouseX, this.mouseY, 10, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(64,128,224,0.4)';
      ctx.fill();
      ctx.strokeStyle = '#48e';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#48e';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('target', this.mouseX, this.mouseY - 14);
    }

    // Shooting
    const dex = parseInt(document.getElementById('simDex').value) || 0;
    document.getElementById('simDexVal').textContent = dex;
    const dexRate = (6.5 * (dex + 17.3)) / 75;
    const playerCooldownMs = 1000 / dexRate;
    // Enemy mode uses the attack's cooldownMs (not DEX rate)
    const enemyCooldownMs = parseInt(document.getElementById('simCooldown').value) || 1000;

    if (this.projGroup) {
      if (simMode === 'player') {
        if (this.mouseDown && now - this.lastShotTime > playerCooldownMs) {
          const angle = this.getAngle(center.x, center.y, this.mouseX, this.mouseY);
          this.fireProjGroup(this.projGroup, center.x, center.y, angle);
          this.lastShotTime = now;
        }
      } else {
        // Enemy mode: auto-fire using attack cooldown
        if (now - this.lastShotTime > enemyCooldownMs) {
          this.fireAttackPattern(this.projGroup, center.x, center.y, this.mouseX, this.mouseY);
          this.lastShotTime = now;
        }
      }
    }

    // Update and draw bullets
    const angleOffset = this.projGroup ? this.parseAngle(this.projGroup.angleOffset) : 0;
    const alive = [];
    for (const b of this.bullets) {
      this.updateBullet(b, dt);
      if (b.range <= 0 || now - b.createdTime > 10000) continue;
      if (b.x < -100 || b.x > W + 100 || b.y < -100 || b.y > H + 100) continue;
      alive.push(b);

      // Draw bullet
      const sz = b.size * 0.5;
      const tfAngle = Math.PI / 2;
      const rot = -b.angle + tfAngle + (angleOffset > 0 ? angleOffset : 0);

      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(rot);

      // Range fade
      const life = b.range / b.maxRange;
      const alpha = Math.max(0.2, life);

      // Colored rectangle representing the sprite
      ctx.globalAlpha = alpha;
      ctx.fillStyle = b.isParametric ? '#80c0ff' : b.isOrbital ? '#ff80ff' : '#ffee80';
      ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.strokeRect(-sz / 2, -sz / 2, sz, sz);

      // Direction indicator line
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -sz * 0.7);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.restore();
    }
    this.bullets = alive;

    // HUD text
    ctx.fillStyle = '#888';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    if (simMode === 'player') {
      ctx.fillText(`Bullets: ${alive.length}  |  Fire rate: ${dexRate.toFixed(1)}/s  |  Cooldown: ${playerCooldownMs.toFixed(0)}ms`, 8, 16);
      ctx.fillText('Hold left click to fire toward cursor', 8, 30);
    } else {
      const mirror = document.getElementById('simMirror').checked;
      ctx.fillText(`Bullets: ${alive.length}  |  CD: ${enemyCooldownMs}ms${mirror ? '  |  Mirror: ON' : ''}`, 8, 16);
      ctx.fillText('Enemy auto-fires at target (move cursor to reposition)', 8, 30);
    }

    // Show/hide controls based on mode
    const isEnemy = simMode === 'enemy';
    const hasEnemy = !!this.enemy;
    document.getElementById('simPhaseLabel').style.display = isEnemy && hasEnemy ? '' : 'none';
    document.getElementById('simAttackLabel').style.display = isEnemy && hasEnemy ? '' : 'none';
    document.getElementById('simAimModeLabel').style.display = isEnemy ? '' : 'none';
    document.getElementById('simCooldownLabel').style.display = isEnemy ? '' : 'none';
    document.getElementById('simShotCountLabel').style.display = isEnemy ? '' : 'none';
    document.getElementById('simSpreadLabel').style.display = isEnemy ? '' : 'none';
    document.getElementById('simBurstLabel').style.display = isEnemy ? '' : 'none';
    document.getElementById('simMirrorLabel').style.display = isEnemy ? '' : 'none';

    this.animId = requestAnimationFrame(() => this.loop());
  }
};

function openProjSimulator(pgGroup, title) {
  SIM.open(pgGroup, title);
}

// Bind simulator buttons
document.getElementById('simCloseBtn').addEventListener('click', () => SIM.close());
document.getElementById('projSimOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) SIM.close();
});
document.getElementById('simPgBtn').addEventListener('click', () => {
  if (!selectedPgTab) return;
  applyPgTabDetail(); // Save current edits first
  openProjSimulator(selectedPgTab, `Projectile Group ${selectedPgTab.projectileGroupId}`);
});

document.getElementById('simEnemyBtn').addEventListener('click', () => {
  if (!selectedEnemy) return;
  applyEnemyDetail();
  const phases = selectedEnemy.phases || [];
  // Verify at least one attack has a valid projectile group
  let anyPg = false;
  for (const phase of phases) {
    for (const atk of (phase.attacks || [])) {
      if (projGroups.find(g => g.projectileGroupId === atk.projectileGroupId)) { anyPg = true; break; }
    }
    if (anyPg) break;
  }
  if (!anyPg) { alert('No attack with a valid projectile group found in this enemy\'s phases.'); return; }
  document.getElementById('simMode').value = 'enemy';
  const edex = selectedEnemy.stats ? selectedEnemy.stats.dex : 10;
  document.getElementById('simDex').value = edex;
  // open() will call _populatePhases → _populateAttacks → _loadAttack for first phase/attack
  SIM.open(null, `${selectedEnemy.name} — Simulate`, selectedEnemy);
});

// Phase selector change → repopulate attacks
document.getElementById('simPhaseSelect').addEventListener('change', () => {
  if (!SIM.enemy) return;
  const phases = SIM.enemy.phases || [];
  const idx = parseInt(document.getElementById('simPhaseSelect').value) || 0;
  SIM._populateAttacks(phases[idx]);
});

// Attack selector change → load that attack
document.getElementById('simAttackSelect').addEventListener('change', () => {
  if (!SIM.enemy) return;
  const phaseIdx = parseInt(document.getElementById('simPhaseSelect').value) || 0;
  const atkIdx = parseInt(document.getElementById('simAttackSelect').value) || 0;
  const phase = (SIM.enemy.phases || [])[phaseIdx];
  const atk = (phase && phase.attacks || [])[atkIdx];
  if (atk) SIM._loadAttack(atk);
});

init();
