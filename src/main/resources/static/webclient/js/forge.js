// Forge UI controller — pixel-edit enchantments onto an item using crystals + essence.
// Server validates everything; this UI is presentational + cost preview.

// statId order: 0=VIT 1=WIS 2=HP 3=MP 4=ATT 5=DEF 6=SPD 7=DEX
// MUST match server-side ServerForgeHelper.STAT_COLORS (ARGB ints).
const STAT_COLOR_ARGB = [
    0xFFC81F1F, // VIT red
    0xFF3F6CFF, // WIS blue
    0xFFF0A3A3, // HP pink
    0xFFA070D8, // MP purple
    0xFFC850DC, // ATT magenta
    0xFF1A1A1A, // DEF black
    0xFF5FD06F, // SPD green
    0xFFF08C2C  // DEX orange
];
const STAT_LABEL = ['VIT','WIS','HP','MP','ATT','DEF','SPD','DEX'];
const SLOT_LABEL = ['Weapon','Ability','Armor','Ring'];

const MAX_ENCHANTMENTS = 5;
const ESSENCE_PER_FORGE = 50;

let _game = null;
let _network = null;
let _renderer = null;
let _refreshInventory = null;

// Selection state for the open modal
let _state = null;

function initialState() {
    return {
        targetSlot: -1,    // inventory slot index of the item being enchanted
        crystalSlot: -1,   // inventory slot of the chosen crystal
        essenceSlot: -1,   // inventory slot of the matching essence stack
        pixelX: -1,        // staged pixel coord
        pixelY: -1,
        hoverX: -1,
        hoverY: -1,
        spritePixels: null // Uint8ClampedArray of source sprite ARGB-ish (RGBA)
    };
}

export function initForgeUI({ game, network, renderer, refreshInventory }) {
    _game = game;
    _network = network;
    _renderer = renderer;
    _refreshInventory = refreshInventory;
    _state = initialState();

    document.getElementById('forge-close-btn')?.addEventListener('click', closeForgeModal);
    document.getElementById('forge-cancel-btn')?.addEventListener('click', closeForgeModal);
    document.getElementById('forge-backdrop')?.addEventListener('click', closeForgeModal);
    document.getElementById('forge-confirm-btn')?.addEventListener('click', confirmForge);
    document.getElementById('forge-disenchant-btn')?.addEventListener('click', confirmDisenchant);

    const canvas = document.getElementById('forge-pixel-canvas');
    if (canvas) {
        canvas.addEventListener('mousemove', onCanvasMove);
        canvas.addEventListener('mouseleave', () => {
            _state.hoverX = -1; _state.hoverY = -1; renderCanvas();
        });
        canvas.addEventListener('click', onCanvasClick);
    }

    // Set up dropzones — accept drops from the inventory drag system
    setupDropzones();
}

export function openForgeModal() {
    const modal = document.getElementById('forge-modal');
    if (!modal) return;
    _state = initialState();
    modal.removeAttribute('hidden');
    document.body.classList.add('forge-open');
    refreshUi();
}

export function closeForgeModal() {
    const modal = document.getElementById('forge-modal');
    if (modal) modal.setAttribute('hidden', '');
    document.body.classList.remove('forge-open');
    _state = initialState();
}

export function isForgeOpen() {
    const modal = document.getElementById('forge-modal');
    return modal && !modal.hasAttribute('hidden');
}

/**
 * Drop an inventory slot into the given forge zone ('target'|'crystal'|'essence').
 * Called from main.js's drag handler when the drag target lands on a forge zone.
 * Returns true if the drop was consumed.
 */
export function tryForgeDrop(srcSlotIdx, zone) {
    if (!isForgeOpen()) return false;
    if (srcSlotIdx < 0 || srcSlotIdx > 19) return false;
    const item = _game?.inventory?.[srcSlotIdx];
    if (!item || item.itemId < 0) return false;
    if (!zone) return false;

    if (zone === 'target') {
        if (item.stackable || item.targetSlot < 0 || item.targetSlot > 3) {
            flashStatus('Only equipment can be enchanted.');
            return true;
        }
        _state.targetSlot = srcSlotIdx;
        _state.pixelX = -1; _state.pixelY = -1;
        _state.spritePixels = null;
        loadSpritePixels(item).then(refreshUi);
        return true;
    }
    if (zone === 'crystal') {
        if (item.category !== 'crystal') {
            flashStatus('That isn\'t a crystal.');
            return true;
        }
        _state.crystalSlot = srcSlotIdx;
        refreshUi();
        return true;
    }
    if (zone === 'essence') {
        if (item.category !== 'essence') {
            flashStatus('That isn\'t essence.');
            return true;
        }
        _state.essenceSlot = srcSlotIdx;
        refreshUi();
        return true;
    }
    return false;
}

let _hoverZone = null;
function setupDropzones() {
    const zones = ['target', 'crystal', 'essence'];
    for (const z of zones) {
        const el = document.getElementById('forge-' + z + '-slot');
        if (!el) continue;
        el.addEventListener('mouseenter', () => {
            _hoverZone = z;
            el.classList.add('drag-hover');
        });
        el.addEventListener('mouseleave', () => {
            if (_hoverZone === z) _hoverZone = null;
            el.classList.remove('drag-hover');
        });
        // Click-to-clear: clicking a filled zone removes the selection
        el.addEventListener('click', () => {
            if (z === 'target') {
                _state.targetSlot = -1;
                _state.pixelX = -1; _state.pixelY = -1;
                _state.spritePixels = null;
            } else if (z === 'crystal') {
                _state.crystalSlot = -1;
            } else if (z === 'essence') {
                _state.essenceSlot = -1;
            }
            refreshUi();
        });
    }
}

function flashStatus(msg) {
    const el = document.getElementById('forge-status');
    if (el) el.textContent = msg;
}

function refreshUi() {
    if (!_game) return;
    const target = _state.targetSlot >= 0 ? _game.inventory[_state.targetSlot] : null;
    const crystal = _state.crystalSlot >= 0 ? _game.inventory[_state.crystalSlot] : null;
    const essence = _state.essenceSlot >= 0 ? _game.inventory[_state.essenceSlot] : null;

    paintZone('target', target);
    paintZone('crystal', crystal);
    paintZone('essence', essence);

    const status = document.getElementById('forge-status');
    const cost = document.getElementById('forge-cost');
    const confirm = document.getElementById('forge-confirm-btn');
    const disenchant = document.getElementById('forge-disenchant-btn');

    let canForge = true;
    const issues = [];
    if (!target) { canForge = false; issues.push('Pick an item.'); }
    if (target && (target.enchantments?.length || 0) >= MAX_ENCHANTMENTS) {
        canForge = false; issues.push('Max enchantments reached.');
    }
    if (!crystal) { canForge = false; issues.push('Pick a Crystal.'); }
    if (!essence) { canForge = false; issues.push('Pick Essence.'); }
    if (target && essence && essence.forgeSlotId !== target.targetSlot) {
        canForge = false;
        const need = SLOT_LABEL[target.targetSlot] || '?';
        issues.push(`Essence type must be ${need}.`);
    }
    if (essence && (essence.stackCount || 0) < ESSENCE_PER_FORGE) {
        canForge = false; issues.push(`Need ${ESSENCE_PER_FORGE} essence (have ${essence.stackCount || 0}).`);
    }
    if (_state.pixelX < 0) {
        canForge = false; issues.push('Click a sprite pixel.');
    }

    if (status) {
        if (target) {
            const enchN = target.enchantments?.length || 0;
            status.innerHTML = `<b>${target.name}</b> &nbsp; Enchantments: ${enchN}/${MAX_ENCHANTMENTS}`;
        } else {
            status.textContent = issues[0] || 'Drag an item to begin.';
        }
    }
    if (cost) {
        if (target && crystal && essence) {
            const ok = canForge ? 'ok' : 'bad';
            const stat = STAT_LABEL[crystal.forgeStatId] || '?';
            cost.innerHTML = `Cost: 1 <span class="${ok}">${stat} Crystal</span> + ${ESSENCE_PER_FORGE} <span class="${ok}">${SLOT_LABEL[essence.forgeSlotId] || '?'} Essence</span> &rarr; +1 ${stat}`;
        } else {
            cost.textContent = '';
        }
    }
    if (confirm) confirm.disabled = !canForge;
    if (disenchant) disenchant.disabled = !target || (target.enchantments?.length || 0) === 0;

    renderCanvas();
}

function paintZone(zone, item) {
    const el = document.getElementById('forge-' + zone + '-slot');
    if (!el) return;
    el.innerHTML = '';
    if (!item) {
        el.classList.remove('filled');
        const hint = document.createElement('span');
        hint.className = 'forge-zone-hint';
        hint.textContent = zone === 'target' ? 'Drag an item here'
            : zone === 'crystal' ? 'Drag a Crystal here'
            : 'Drag matching Essence here';
        el.appendChild(hint);
        return;
    }
    el.classList.add('filled');
    const url = window.getItemSpriteUrl ? window.getItemSpriteUrl(item) : null;
    if (url) {
        const img = document.createElement('img');
        img.src = url;
        el.appendChild(img);
    }
    if (item.stackable && (item.stackCount || 1) > 1) {
        const detail = document.createElement('span');
        detail.className = 'forge-zone-detail';
        detail.textContent = `×${item.stackCount}`;
        el.appendChild(detail);
    }
}

// ---------- Pixel canvas ----------

const SPRITE_SIZE = 8;
const CANVAS_PIXEL = 32; // each source pixel rendered as 32×32 on screen

async function loadSpritePixels(item) {
    if (!item) return;
    const def = _game.itemData?.[item.itemId];
    if (!def) return;
    const sw = def.spriteSize || 8;
    const sh = def.spriteHeight || sw;

    // Build a temp canvas at native resolution from the source sprite sheet
    const tmp = document.createElement('canvas');
    tmp.width = sw; tmp.height = sh;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = false;

    // Use the same path as inventory rendering — get a data URL of the base sprite
    const url = window.getItemBaseSpriteUrl
        ? window.getItemBaseSpriteUrl(item, /*ignoreEnchant*/ true)
        : (window.getItemSpriteUrl ? window.getItemSpriteUrl(item) : null);
    if (!url) return;

    await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            tctx.clearRect(0, 0, sw, sh);
            tctx.drawImage(img, 0, 0, sw, sh);
            const data = tctx.getImageData(0, 0, sw, sh);
            _state.spritePixels = data.data; // Uint8ClampedArray RGBA
            _state.spriteW = sw; _state.spriteH = sh;
            resolve();
        };
        img.onerror = () => resolve();
        img.src = url;
    });
}

function renderCanvas() {
    const canvas = document.getElementById('forge-pixel-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const target = _state.targetSlot >= 0 ? _game.inventory[_state.targetSlot] : null;
    if (!target || !_state.spritePixels) {
        // Empty canvas with a "drop a target" hint
        ctx.fillStyle = '#6a5a68';
        ctx.font = '14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Pick a target item', canvas.width / 2, canvas.height / 2);
        return;
    }

    const sw = _state.spriteW || SPRITE_SIZE;
    const sh = _state.spriteH || SPRITE_SIZE;
    const cellW = canvas.width / sw;
    const cellH = canvas.height / sh;

    // Draw source pixels
    for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
            const idx = (y * sw + x) * 4;
            const r = _state.spritePixels[idx];
            const g = _state.spritePixels[idx + 1];
            const b = _state.spritePixels[idx + 2];
            const a = _state.spritePixels[idx + 3];
            if (a === 0) continue;
            ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
            ctx.fillRect(x * cellW, y * cellH, cellW, cellH);
        }
    }

    // Overlay existing enchantment pixels with their stat color
    if (target.enchantments) {
        for (const e of target.enchantments) {
            ctx.fillStyle = argbToCss(e.pixelColor);
            ctx.fillRect(e.pixelX * cellW, e.pixelY * cellH, cellW, cellH);
            ctx.strokeStyle = 'rgba(255, 216, 107, 0.6)';
            ctx.lineWidth = 1;
            ctx.strokeRect(e.pixelX * cellW + 0.5, e.pixelY * cellH + 0.5, cellW - 1, cellH - 1);
        }
    }

    // Hover preview if cursor is over a paintable cell
    const crystal = _state.crystalSlot >= 0 ? _game.inventory[_state.crystalSlot] : null;
    if (_state.hoverX >= 0 && crystal && crystal.forgeStatId != null && crystal.forgeStatId >= 0) {
        if (isPixelPaintable(_state.hoverX, _state.hoverY, target)) {
            ctx.fillStyle = argbToCss(STAT_COLOR_ARGB[crystal.forgeStatId], 0.6);
            ctx.fillRect(_state.hoverX * cellW, _state.hoverY * cellH, cellW, cellH);
        }
    }

    // Staged pixel
    if (_state.pixelX >= 0) {
        ctx.strokeStyle = '#ffd86b';
        ctx.lineWidth = 2;
        ctx.strokeRect(_state.pixelX * cellW + 1, _state.pixelY * cellH + 1, cellW - 2, cellH - 2);
    }

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    for (let i = 1; i < sw; i++) {
        ctx.beginPath();
        ctx.moveTo(i * cellW + 0.5, 0);
        ctx.lineTo(i * cellW + 0.5, canvas.height);
        ctx.stroke();
    }
    for (let i = 1; i < sh; i++) {
        ctx.beginPath();
        ctx.moveTo(0, i * cellH + 0.5);
        ctx.lineTo(canvas.width, i * cellH + 0.5);
        ctx.stroke();
    }
}

function isPixelPaintable(x, y, target) {
    if (!_state.spritePixels) return false;
    const sw = _state.spriteW || SPRITE_SIZE;
    const sh = _state.spriteH || SPRITE_SIZE;
    if (x < 0 || y < 0 || x >= sw || y >= sh) return false;
    const idx = (y * sw + x) * 4;
    if (_state.spritePixels[idx + 3] === 0) return false; // transparent source pixel
    if (target.enchantments) {
        for (const e of target.enchantments) {
            if (e.pixelX === x && e.pixelY === y) return false;
        }
    }
    return true;
}

function onCanvasMove(ev) {
    const canvas = ev.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const sw = _state.spriteW || SPRITE_SIZE;
    const sh = _state.spriteH || SPRITE_SIZE;
    const cellW = rect.width / sw;
    const cellH = rect.height / sh;
    const x = Math.floor((ev.clientX - rect.left) / cellW);
    const y = Math.floor((ev.clientY - rect.top) / cellH);
    if (x !== _state.hoverX || y !== _state.hoverY) {
        _state.hoverX = x;
        _state.hoverY = y;
        renderCanvas();
    }
}

function onCanvasClick(ev) {
    const target = _state.targetSlot >= 0 ? _game.inventory[_state.targetSlot] : null;
    if (!target) return;
    const canvas = ev.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const sw = _state.spriteW || SPRITE_SIZE;
    const sh = _state.spriteH || SPRITE_SIZE;
    const cellW = rect.width / sw;
    const cellH = rect.height / sh;
    const x = Math.floor((ev.clientX - rect.left) / cellW);
    const y = Math.floor((ev.clientY - rect.top) / cellH);
    if (!isPixelPaintable(x, y, target)) {
        flashStatus('Pick a non-transparent pixel that isn\'t already enchanted.');
        return;
    }
    _state.pixelX = x;
    _state.pixelY = y;
    refreshUi();
}

function confirmForge() {
    const target = _state.targetSlot >= 0 ? _game.inventory[_state.targetSlot] : null;
    const crystal = _state.crystalSlot >= 0 ? _game.inventory[_state.crystalSlot] : null;
    const essence = _state.essenceSlot >= 0 ? _game.inventory[_state.essenceSlot] : null;
    if (!target || !crystal || !essence) return;
    if (_state.pixelX < 0) return;
    _network.sendForgeEnchant(
        _game.playerId,
        _state.targetSlot,
        crystal.itemId,
        _state.crystalSlot,
        _state.essenceSlot,
        _state.pixelX,
        _state.pixelY
    );
    // Reset selections; the modal stays open. Server reply (UpdatePacket) refreshes inventory.
    _state.crystalSlot = -1;
    _state.pixelX = -1; _state.pixelY = -1;
    flashStatus('Forging…');
    refreshUi();
}

function confirmDisenchant() {
    const target = _state.targetSlot >= 0 ? _game.inventory[_state.targetSlot] : null;
    if (!target || !target.enchantments?.length) return;
    if (!confirm(`Remove all ${target.enchantments.length} enchantments from ${target.name}? Materials are not refunded.`)) return;
    _network.sendForgeDisenchant(_game.playerId, _state.targetSlot);
    flashStatus('Removing enchantments…');
}

function argbToCss(argb, alphaOverride) {
    const a = ((argb >>> 24) & 0xff) / 255;
    const r = (argb >>> 16) & 0xff;
    const g = (argb >>> 8) & 0xff;
    const b = argb & 0xff;
    const aa = alphaOverride != null ? alphaOverride : a;
    return `rgba(${r}, ${g}, ${b}, ${aa})`;
}

/**
 * Called whenever inventory changes — rebuilds the canvas if the target item's
 * enchantments grew (so the new pixel paints immediately on confirm-reply).
 */
export function notifyInventoryChanged() {
    if (!isForgeOpen()) return;
    refreshUi();
}
