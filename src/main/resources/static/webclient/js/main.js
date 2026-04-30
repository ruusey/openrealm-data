// OpenRealm Web Client - Main Entry Point

// Strip credentials from URL immediately on load (prevents login data leaking via GET params)
if (window.location.search) {
    window.history.replaceState({}, '', window.location.pathname);
}

import { ApiClient } from './api.js';
import { GameNetwork } from './network.js';
import { GameState, CLASS_NAMES, ProjectileFlag, StatusEffect, saveSettings } from './game.js';
import { GameRenderer } from './renderer.js';
import { InputHandler } from './input.js';
import { PacketId, PacketWriters } from './codec.js';
import { initTradeUI, updateNearbyPlayers } from './trade.js';
import { initTouchControls, isTouchDevice, getJoystickDir, getAimDir, setDoubleTapHandler } from './touch.js';
import { Minimap } from './minimap.js';
import { initForgeUI, openForgeModal, closeForgeModal, isForgeOpen, tryForgeDrop, notifyInventoryChanged as forgeInventoryChanged } from './forge.js';

// --- App State ---
const api = new ApiClient();
const network = new GameNetwork();
const game = new GameState();
const input = new InputHandler();
let renderer = null;

let currentScreen = 'login';
let account = null;
let selectedCharacter = null;
let gameServerHost = 'useast';
let loginEmail = '';
let loginPassword = '';
let loginToken = null;
// Movement: track X and Y axes independently for diagonal support
// Server Cardinality: NORTH=0, SOUTH=1, EAST=2, WEST=3, NONE=4
let lastXDir = null; // null=none, 2=EAST, 3=WEST
let lastYDir = null; // null=none, 0=NORTH, 1=SOUTH
let shootCooldown = 0;
let projectileCounter = 0;
let minimap = null;

// --- Sprite sheets to load ---
// Must match Java GameSpriteManager.SPRITE_NAMES exactly
const SPRITE_SHEETS = [
    'rotmg-projectiles.png',
    'rotmg-bosses.png', 'rotmg-bosses-1.png',
    'rotmg-items.png', 'rotmg-items-1.png',
    'rotmg-tiles.png', 'rotmg-tiles-1.png', 'rotmg-tiles-2.png', 'rotmg-tiles-all.png',
    'rotmg-abilities.png', 'rotmg-misc.png',
    'rotmg-classes-0.png', 'rotmg-classes-1.png', 'rotmg-classes-2.png', 'rotmg-classes-3.png',
    'lofiObj2.png', 'lofiObj3.png', 'lofiObjBig.png',
    'lofiEnvironment2.png', 'lofiEnvironment3.png',
    'lofi_dungeon_features.png',
    'chars8x8rBeach.png', 'chars8x8rHero2.png', 'cursedLibraryChars16x16.png',
    'd1Chars16x16r.png', 'd3Chars8x8r.png', 'cursedLibraryChars8x8.png', 'cursedLibraryObjects8x8.png',
    'd2LofiObj.png', 'd3LofiObj.png', 'lofiProjs.png', 'chars16x16dEncounters.png',
    'archbishopObjects16x16.png', 'autumnNexusObjects16x16.png',
    'chars16x16dEncounters2.png', 'crystalCaveChars16x16.png',
    'crystalCaveObjects8x8.png', 'fungalCavernObjects8x8.png',
    'epicHiveChars8x8.png', 'lairOfDraconisChars8x8.png', 'lairOfDraconisObjects8x8.png',
    'lostHallsObjects8x8.png', 'magicWoodsObjects8x8.png', 'mountainTempleObjects8x8.png',
    'summerNexusObjects8x8.png',
    'oryxHordeChars16x16.png', 'oryxHordeChars8x8.png',
    'secludedThicketChars16x16.png',
    'lofiWorld.png', 'lofiBosses16x16.png', 'lofiBosses16x20.png',
    'lofiCharacter10x10.png', 'lofiProjectiles.png',
    'battleOryxObjects8x8.png',
    'openrealm-items.png', 'openrealm-classes.png', 'openrealm-bosses.png'
];

// --- Screen Management ---
function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`${name}-screen`).classList.add('active');
    currentScreen = name;
    // The difficulty icon and account-fame badge are fixed-position overlays
    // that live OUTSIDE the screen containers, so they don't auto-hide on
    // screen change. Only reveal them while playing — updateHUD() will set
    // display:'' on the fame badge once it has a value. Difficulty icon stays
    // managed by its existing show/hide path.
    if (name !== 'game') {
        const fameEl = document.getElementById('account-fame-display');
        if (fameEl) fameEl.style.display = 'none';
    }
}

// Auto-login using saved session token
(async () => {
    try {
        if (api.restoreSession()) {
            // Validate the token is still good by resolving the account
            const authAccount = await api.getMyAccount();
            loginToken = api.sessionToken;
            // Fetch the full player account (with characters, etc.)
            account = await api.getAccount(authAccount.accountGuid);
            try {
                const animData = await api.getGameData('animations.json');
                _animDataByClass = {};
                if (Array.isArray(animData)) animData.forEach(a => { if (a.objectType === 'player') _animDataByClass[a.objectId] = a; });
            } catch (e) { /* non-critical */ }
            showCharacterSelect();
            return;
        }
    } catch (e) {
        // Token expired or invalid, clear it and fall through to login screen
        api.clearSession();
    }
    // Fallback: auto-login returning guest accounts (legacy)
    try {
        const savedGuest = localStorage.getItem('or_guest_email');
        if (savedGuest) {
            setTimeout(() => document.getElementById('guest-btn')?.click(), 100);
        }
    } catch (e) {}
})();

// --- Login ---
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');

    errorEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Logging in...';

    try {
        const loginData = await api.login(email, password);
        loginEmail = email;
        loginPassword = password;
        loginToken = loginData.token;
        api.saveSession();
        account = await api.getAccount(loginData.accountGuid);
        // Load animation data for character select icons (front-facing idle)
        try {
            const animData = await api.getGameData('animations.json');
            _animDataByClass = {};
            if (Array.isArray(animData)) animData.forEach(a => { if (a.objectType === 'player') _animDataByClass[a.objectId] = a; });
        } catch (e) { /* non-critical */ }
        showCharacterSelect();
    } catch (err) {
        errorEl.textContent = err.message;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Login';
    }
});

// --- Register ---
document.getElementById('show-register').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
});
document.getElementById('show-login').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('register-form').style.display = 'none';
    document.getElementById('login-form').style.display = 'block';
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('reg-name').value;
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;
    const errorEl = document.getElementById('register-error');
    const btn = document.getElementById('register-btn');

    errorEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Registering...';

    try {
        await api.register(email, password, name);
        // Auto-login after registration
        const loginData = await api.login(email, password);
        loginToken = loginData.token;
        api.saveSession();
        account = await api.getAccount(loginData.accountGuid);
        document.getElementById('register-form').style.display = 'none';
        document.getElementById('login-form').style.display = 'block';
        showCharacterSelect();
    } catch (err) {
        errorEl.textContent = err.message;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Register';
    }
});

// --- Guest Login ---
const GUEST_NAMES = [
    "Utanu", "Gharr", "Yimi", "Idrae", "Odaru", "Scheev", "Zhiar", "Itani",
    "Serl", "Oeti", "Tiar", "Issz", "Oshyu", "Deyst", "Oalei", "Vorv",
    "Iatho", "Uoro", "Urake", "Eashy", "Queq", "Rayr", "Tal", "Drac",
    "Yangu", "Eango", "Rilr", "Ehoni", "Risrr", "Sek", "Eati", "Laen",
    "Eendi", "Ril", "Darq", "Seus", "Radph", "Orothi", "Vorck", "Saylt",
    "Iawa", "Iri", "Lauk", "Lorz"
];
let localChatRole = null; // Tracks local player's chatRole for client-side checks

document.getElementById('guest-btn').addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Clear form fields so browser autofill doesn't interfere
    document.getElementById('email').value = '';
    document.getElementById('password').value = '';
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('guest-btn');

    errorEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Connecting...';

    try {

        let email = null;
        let password = null;

        // Check localStorage for existing guest credentials
        try {
            email = localStorage.getItem('or_guest_email');
            password = localStorage.getItem('or_guest_password');
        } catch (e) { /* storage unavailable */ }

        if (email && password) {
            // Try to login with existing guest credentials
            try {
                const loginData = await api.login(email, password);
                loginEmail = email;
                loginPassword = password;
                loginToken = loginData.token;
                api.saveSession();
                account = await api.getAccount(loginData.accountGuid);
                try {
                    const animData = await api.getGameData('animations.json');
                    _animDataByClass = {};
                    if (Array.isArray(animData)) animData.forEach(a => { if (a.objectType === 'player') _animDataByClass[a.objectId] = a; });
                } catch (e) { /* non-critical */ }
                localChatRole = 'demo';
                showCharacterSelect();
                return;
            } catch (loginErr) {
                // Credentials invalid/expired, create new guest
                try { localStorage.removeItem('or_guest_email'); localStorage.removeItem('or_guest_password'); } catch (e) {}
            }
        }

        // Generate new guest credentials
        const randHex = () => Math.random().toString(16).slice(2, 10);
        const guestId = randHex();
        email = `guest_${guestId}@openrealm.net`;
        password = randHex() + randHex();
        const accountName = GUEST_NAMES[Math.floor(Math.random() * GUEST_NAMES.length)];

        // Register guest account
        await api.register(email, password, accountName, true);

        // Login
        const loginData = await api.login(email, password);
        loginEmail = email;
        loginPassword = password;
        loginToken = loginData.token;
        api.saveSession();
        try {
            localStorage.setItem('or_guest_email', email);
            localStorage.setItem('or_guest_password', password);
        } catch (e) { /* storage unavailable */ }
        account = await api.getAccount(loginData.accountGuid);
        try {
            const animData = await api.getGameData('animations.json');
            _animDataByClass = {};
            if (Array.isArray(animData)) animData.forEach(a => { if (a.objectType === 'player') _animDataByClass[a.objectId] = a; });
        } catch (e) { /* non-critical */ }
        localChatRole = 'demo';

        // Show guest credentials popup so the user can save them
        const popup = document.createElement('div');
        popup.innerHTML = `
            <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                        background:#2a2030;border:2px solid #c8a86e;border-radius:8px;
                        padding:24px;z-index:999;color:#e0d8c8;text-align:center;max-width:400px">
                <h3 style="color:#c8a86e;margin-bottom:12px">Guest Account Created</h3>
                <p style="font-size:13px;margin-bottom:8px">Save these credentials to recover your account later:</p>
                <div style="background:#1a1218;padding:8px;border-radius:4px;margin-bottom:8px;font-family:monospace;font-size:12px;user-select:all">
                    Email: ${email}<br>Password: ${password}
                </div>
                <button onclick="this.parentElement.parentElement.remove()"
                        style="padding:8px 24px;background:#c8a86e;color:#1a1218;border:none;border-radius:4px;cursor:pointer;font-weight:bold">
                    Got it!
                </button>
            </div>
        `;
        document.body.appendChild(popup);

        showCharacterSelect();
    } catch (err) {
        errorEl.textContent = err.message;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Play as Guest';
    }
});

// --- Character sprite sheets (preloaded for character select) ---
const _charSpriteSheets = {};
(function preloadClassSprites() {
    for (let i = 0; i < 4; i++) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = api.getSpriteUrl(`rotmg-classes-${i}.png`);
        img.onload = () => { _charSpriteSheets[`rotmg-classes-${i}`] = img; };
    }
})();

// --- Character Select & Management ---
const ALL_CLASSES = [
    'Rogue', 'Archer', 'Wizard', 'Priest', 'Warrior', 'Knight',
    'Paladin', 'Assassin', 'Necromancer', 'Mystic', 'Trickster', 'Sorcerer', 'Huntress'
];
let selectedClassId = null;
let _animDataByClass = {}; // classId -> animation model, loaded once for char select icons

// Draw the idle_front frame for a class using animations.json data, with fallback to legacy math
function drawClassIcon(canvas, classId) {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const anim = _animDataByClass[classId];
    if (anim && anim.animations && anim.animations.idle_front) {
        const frame = anim.animations.idle_front.frames[0];
        const img = _charSpriteSheets[anim.spriteKey.replace('.png', '')];
        if (img) {
            ctx.drawImage(img, frame.col * 8, frame.row * 8, 8, 8, 0, 0, canvas.width, canvas.height);
            return;
        }
    }
    // Fallback: legacy side-idle
    const sheetIdx = Math.floor(classId / 3);
    const localRow = (classId % 3) * 4;
    const img = _charSpriteSheets[`rotmg-classes-${sheetIdx}`];
    if (img) ctx.drawImage(img, 0, localRow * 8, 8, 8, 0, 0, canvas.width, canvas.height);
}

// Preloaded item definitions for graveyard display (loaded once)
let _graveyardItemDefs = null;
async function ensureItemDefs() {
    if (_graveyardItemDefs) return _graveyardItemDefs;
    try {
        const data = await api.getGameData('game-items.json');
        _graveyardItemDefs = {};
        if (Array.isArray(data)) data.forEach(i => _graveyardItemDefs[i.itemId] = i);
        else _graveyardItemDefs = data;
    } catch (e) { _graveyardItemDefs = {}; }
    return _graveyardItemDefs;
}

// Stateless level/fame computation from raw xp. Mirrors GameState.getPlayerLevel
// / getBaseFame so the character-select cards can display the same lvl + xp/fame
// the in-game HUD and leaderboard do, without needing a player instance.
let _expMapCache = null;
function getExpMap() {
    if (_expMapCache) return _expMapCache;
    if (!game.expLevels || !game.expLevels.levelExperienceMap) return null;
    const map = {};
    let maxLvl = 1, maxExp = 0;
    for (const [lvl, range] of Object.entries(game.expLevels.levelExperienceMap)) {
        const [min, max] = range.split('-').map(Number);
        const l = parseInt(lvl);
        map[l] = { min, max };
        if (l > maxLvl) maxLvl = l;
        if (max > maxExp) maxExp = max;
    }
    _expMapCache = { map, maxLvl, maxExp };
    return _expMapCache;
}
function computeLevelFame(xp) {
    const exp = Number(xp) || 0;
    const m = getExpMap();
    if (!m) return { level: 1, fame: 0, isFame: false };
    if (exp > m.maxExp) {
        return { level: m.maxLvl + 1, fame: Math.floor((exp - m.maxExp) / 2500), isFame: true };
    }
    let level = 1;
    for (const [lvl, range] of Object.entries(m.map)) {
        if (range.min <= exp && range.max >= exp) level = parseInt(lvl);
    }
    return { level, fame: 0, isFame: false };
}

function showCharacterSelect() {
    showScreen('charselect');
    selectedCharacter = null;
    selectedClassId = null;
    document.getElementById('play-btn').disabled = true;
    document.getElementById('delete-char-btn').disabled = true;
    document.getElementById('create-char-btn').disabled = true;
    document.getElementById('char-error').textContent = '';

    // Populate account info header
    if (account) {
        const name = account.accountName || 'Unknown';
        const email = account.email || '';
        const af = (Number.isFinite(Number(account.accountFame))) ? Number(account.accountFame) : 0;
        const fameLine = af > 0
            ? `<div style="font-size:11px;color:#c8a86e;margin-top:4px">✦ ${af.toLocaleString()} Account Fame</div>`
            : '';
        document.getElementById('account-display-info').innerHTML = `${name} - ${email}${fameLine}`;
    }

    // Split characters into alive and dead
    const allChars = account.characters || [];
    const aliveChars = allChars.filter(c => !c.deleted);
    const deadChars = allChars.filter(c => c.deleted);

    // Reset to characters tab
    document.getElementById('tab-characters').classList.add('active');
    document.getElementById('tab-graveyard').classList.remove('active');
    document.getElementById('characters-panel').style.display = '';
    document.getElementById('graveyard-panel').style.display = 'none';

    // Character list (alive only)
    const listEl = document.getElementById('char-list');
    listEl.innerHTML = '';
    if (aliveChars.length === 0) {
        listEl.innerHTML = '<p style="color:#887868">No characters yet. Create one below!</p>';
    } else {
        // Item defs are needed for the hover tooltip's equipment names/sprites.
        // Fire and forget — the tooltip handler reads from game.itemData /
        // _graveyardItemDefs at render time, so a delayed populate is fine.
        ensureItemDefs();
        for (const char of aliveChars) {
            const card = document.createElement('div');
            card.className = 'char-card';
            const className = ALL_CLASSES[char.characterClass] || `Class ${char.characterClass}`;
            const stats = char.stats || {};
            // Show level + fame; pre-max characters always sit at "Fame 0",
            // raw XP isn't useful info on the char-select screen.
            const lf = computeLevelFame(stats.xp);
            const xpFameLabel = lf.isFame
                ? `Lv 20 · Fame ${lf.fame.toLocaleString()}`
                : `Lv ${lf.level} · Fame 0`;
            const iconDiv = document.createElement('div');
            iconDiv.className = 'char-icon';
            const classId = char.characterClass || 0;
            const cvs = document.createElement('canvas');
            cvs.width = 40; cvs.height = 40;
            drawClassIcon(cvs, classId);
            iconDiv.appendChild(cvs);

            const infoDiv = document.createElement('div');
            infoDiv.className = 'char-info';
            infoDiv.innerHTML = `
                <div class="char-name">${className} <span class="char-level">${xpFameLabel}</span></div>
                <div class="char-details">
                    HP: ${stats.hp ?? '?'} | MP: ${stats.mp ?? '?'} |
                    ATT: ${stats.att ?? '?'} | DEF: ${stats.def ?? '?'} |
                    SPD: ${stats.spd ?? '?'} | DEX: ${stats.dex ?? '?'}
                </div>
                <div class="char-details char-uuid">${char.characterUuid}</div>
            `;
            card.appendChild(iconDiv);
            card.appendChild(infoDiv);
            card.addEventListener('click', () => {
                document.querySelectorAll('#char-list .char-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedCharacter = char;
                document.getElementById('play-btn').disabled = false;
                document.getElementById('delete-char-btn').disabled = false;
            });

            // Hover tooltip — same data and styling as the leaderboard rows.
            // Build a leaderboard-shaped entry so showEquipmentTooltip works
            // without changes. Mobile (no hover) gets the lvl + xp/fame inline
            // on the card already, plus a tap-to-toggle handler below.
            const entryShape = {
                accountName: account.accountName || 'You',
                className: className,
                characterClass: classId,
                level: lf.level,
                fame: lf.fame,
                stats: stats,
                equipment: char.items || []
            };
            card.addEventListener('mouseenter', (e) => showEquipmentTooltip(e, entryShape));
            card.addEventListener('mouseleave', () => hideEquipmentTooltip());
            listEl.appendChild(card);
        }
    }

    // Graveyard list (dead characters)
    renderGraveyard(deadChars);

    // Class picker for creating new characters
    const pickerEl = document.getElementById('class-picker');
    pickerEl.innerHTML = '';
    for (let i = 0; i < ALL_CLASSES.length; i++) {
        const opt = document.createElement('div');
        opt.className = 'class-option';
        const cCvs = document.createElement('canvas');
        cCvs.width = 28; cCvs.height = 28;
        cCvs.style.cssText = 'vertical-align:middle;margin-right:6px;';
        drawClassIcon(cCvs, i);
        opt.appendChild(cCvs);
        opt.appendChild(document.createTextNode(ALL_CLASSES[i]));
        opt.addEventListener('click', () => {
            document.querySelectorAll('.class-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            selectedClassId = i;
            document.getElementById('create-char-btn').disabled = false;
        });
        pickerEl.appendChild(opt);
    }

    // Vault chest count
    const chestCount = account.playerVault ? account.playerVault.length : 0;
    document.getElementById('chest-count').textContent = `Vault Chests: ${chestCount}/10`;

    // Load leaderboard
    loadLeaderboard();
}

async function renderGraveyard(deadChars) {
    const listEl = document.getElementById('graveyard-list');
    listEl.innerHTML = '';
    if (deadChars.length === 0) {
        listEl.innerHTML = '<p style="color:#887868">No fallen characters.</p>';
        return;
    }

    const itemDefs = await ensureItemDefs();
    const slotNames = ['Weapon', 'Ability', 'Armor', 'Ring'];

    for (const char of deadChars) {
        const card = document.createElement('div');
        card.className = 'char-card';
        const className = ALL_CLASSES[char.characterClass] || `Class ${char.characterClass}`;
        const stats = char.stats || {};
        const classId = char.characterClass || 0;

        const iconDiv = document.createElement('div');
        iconDiv.className = 'char-icon';
        const cvs = document.createElement('canvas');
        cvs.width = 40; cvs.height = 40;
        cvs.style.opacity = '0.5';
        cvs.style.filter = 'grayscale(80%)';
        drawClassIcon(cvs, classId);
        iconDiv.appendChild(cvs);

        const infoDiv = document.createElement('div');
        infoDiv.className = 'char-info';

        const deathDate = char.deleted ? new Date(char.deleted).toLocaleDateString() : 'Unknown';

        // Build equipment list
        const items = char.items || [];
        let equipHtml = '';
        for (let i = 0; i < 4; i++) {
            const equip = items.find(e => e.slotIdx === i);
            if (equip && equip.itemId >= 0) {
                const def = itemDefs[equip.itemId];
                const name = def ? def.name : `Item #${equip.itemId}`;
                equipHtml += `<span style="color:#a89888;font-size:10px" title="${slotNames[i]}">${name}</span> `;
            }
        }

        infoDiv.innerHTML = `
            <div class="char-name">${className}</div>
            <div class="char-details">
                HP: ${stats.hp ?? '?'} | MP: ${stats.mp ?? '?'} |
                ATT: ${stats.att ?? '?'} | DEF: ${stats.def ?? '?'} |
                SPD: ${stats.spd ?? '?'} | DEX: ${stats.dex ?? '?'}
            </div>
            <div class="grave-date">Died: ${deathDate}</div>
            ${equipHtml ? `<div class="char-details" style="margin-top:2px">${equipHtml}</div>` : ''}
        `;
        card.appendChild(iconDiv);
        card.appendChild(infoDiv);
        listEl.appendChild(card);
    }
}

// Tab switching for Characters / Graveyard
document.getElementById('tab-characters').addEventListener('click', () => {
    document.getElementById('tab-characters').classList.add('active');
    document.getElementById('tab-graveyard').classList.remove('active');
    document.getElementById('characters-panel').style.display = '';
    document.getElementById('graveyard-panel').style.display = 'none';
});
document.getElementById('tab-graveyard').addEventListener('click', () => {
    document.getElementById('tab-graveyard').classList.add('active');
    document.getElementById('tab-characters').classList.remove('active');
    document.getElementById('characters-panel').style.display = 'none';
    document.getElementById('graveyard-panel').style.display = '';
});

async function loadLeaderboard() {
    const listEl = document.getElementById('leaderboard-list');
    listEl.innerHTML = '<p style="color:#887868">Loading...</p>';
    // Ensure item definitions are available for equipment tooltips
    await ensureItemDefs();
    try {
        const entries = await api.request('GET', '/data/stats/top?count=25');
        if (!entries || entries.length === 0) {
            listEl.innerHTML = '<p style="color:#887868">No characters yet.</p>';
            return;
        }
        listEl.innerHTML = '';
        entries.forEach((entry, idx) => {
            const row = document.createElement('div');
            row.className = 'leaderboard-row';

            const rank = document.createElement('span');
            rank.className = 'lb-rank';
            rank.textContent = `#${idx + 1}`;

            const icon = document.createElement('canvas');
            icon.width = 24; icon.height = 24;
            icon.style.cssText = 'vertical-align:middle;margin-right:6px';
            drawClassIcon(icon, entry.characterClass || 0);

            const info = document.createElement('span');
            info.className = 'lb-info';
            const isFameMode = (entry.fame || 0) > 0;
            info.textContent = `${entry.accountName} - ${entry.className} Lv. ${isFameMode ? 20 : entry.level}`;

            const fame = document.createElement('span');
            fame.className = 'lb-fame';
            // Pre-max characters always show "Fame 0"; raw XP is too noisy.
            fame.textContent = isFameMode
                ? `Fame: ${entry.fame.toLocaleString()}`
                : `Fame: 0`;

            row.append(rank, icon, info, fame);

            // Equipment tooltip on hover
            if (entry.equipment && entry.equipment.length > 0) {
                row.addEventListener('mouseenter', (e) => {
                    showEquipmentTooltip(e, entry);
                });
                row.addEventListener('mouseleave', () => {
                    hideEquipmentTooltip();
                });
            }
            listEl.appendChild(row);
        });
    } catch (e) {
        listEl.innerHTML = `<p style="color:#c44">${e.message}</p>`;
    }
}

function showEquipmentTooltip(event, entry) {
    let tip = document.getElementById('lb-tooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'lb-tooltip';
        document.body.appendChild(tip);
    }
    const slotNames = ['Weapon', 'Ability', 'Armor', 'Ring'];
    let html = `<div class="lb-tooltip-title">${entry.accountName}'s ${entry.className}</div>`;
    // Second header line: Lv + Fame. Used by the character-select card hover
    // tooltip; leaderboard rows already show this info inline. Pre-max chars
    // show "Fame 0" — raw XP isn't useful here.
    const isFame = (entry.fame || 0) > 0;
    if (entry.level != null || isFame) {
        const lvlPart = isFame ? 'Lv 20' : (entry.level != null ? `Lv ${entry.level}` : '');
        const fameAmount = isFame ? (entry.fame || 0) : 0;
        const progPart = `Fame ${fameAmount.toLocaleString()}`;
        const sep = lvlPart ? ' · ' : '';
        html += `<div class="lb-tooltip-sub">${lvlPart}${sep}${progPart}</div>`;
    }
    html += '<div class="lb-tooltip-equip">';
    for (let i = 0; i < 4; i++) {
        const equip = entry.equipment.find(e => e.slotIdx === i);
        if (equip && equip.itemId >= 0) {
            const itemDef = game.itemData?.[equip.itemId] || _graveyardItemDefs?.[equip.itemId];
            const name = itemDef?.name || `Item ${equip.itemId}`;
            const spriteUrl = getItemSpriteUrl({ itemId: equip.itemId });
            const imgTag = spriteUrl
                ? `<img src="${spriteUrl}" class="lb-tooltip-sprite">`
                : '<span class="lb-tooltip-sprite-empty"></span>';
            const tierTag = itemDef?.tier >= 0 ? `<span class="lb-tooltip-tier">T${itemDef.tier}</span>` : '';
            html += `<div class="lb-tooltip-item">${imgTag}<span class="lb-tooltip-slot">${slotNames[i]}:</span> ${name}${tierTag}</div>`;
        } else {
            html += `<div class="lb-tooltip-item" style="color:#665848"><span class="lb-tooltip-sprite-empty"></span><span class="lb-tooltip-slot">${slotNames[i]}:</span> Empty</div>`;
        }
    }
    html += '</div>';
    if (entry.stats) {
        const s = entry.stats;
        html += '<div class="lb-tooltip-stats">'
            + `<div class="lb-stat"><span class="lb-stat-label">HP</span><span class="lb-stat-val lb-stat-hp">${s.hp ?? 0}</span></div>`
            + `<div class="lb-stat"><span class="lb-stat-label">MP</span><span class="lb-stat-val lb-stat-mp">${s.mp ?? 0}</span></div>`
            + `<div class="lb-stat"><span class="lb-stat-label">ATT</span><span class="lb-stat-val">${s.att ?? 0}</span></div>`
            + `<div class="lb-stat"><span class="lb-stat-label">DEF</span><span class="lb-stat-val">${s.def ?? 0}</span></div>`
            + `<div class="lb-stat"><span class="lb-stat-label">SPD</span><span class="lb-stat-val">${s.spd ?? 0}</span></div>`
            + `<div class="lb-stat"><span class="lb-stat-label">DEX</span><span class="lb-stat-val">${s.dex ?? 0}</span></div>`
            + `<div class="lb-stat"><span class="lb-stat-label">VIT</span><span class="lb-stat-val">${s.vit ?? 0}</span></div>`
            + `<div class="lb-stat"><span class="lb-stat-label">WIS</span><span class="lb-stat-val">${s.wis ?? 0}</span></div>`
            + '</div>';
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    tip.style.left = (event.pageX + 12) + 'px';
    tip.style.top = (event.pageY - 10) + 'px';
}

function hideEquipmentTooltip() {
    const tip = document.getElementById('lb-tooltip');
    if (tip) tip.style.display = 'none';
}

// ────────────────────────────────────────────────────────────────────────
// Fame Store — modal triggered by interacting with a fame_store tile.
// Server is the source of truth for fame balance and item grants. The UI
// displays the items, sends a buy request, and re-renders on the refreshed
// OPEN_FAME_STORE packet (server resends after each successful purchase).
// ────────────────────────────────────────────────────────────────────────

// Fame cost per item — must match ServerFameStoreHelper.DYE_FAME_COST. Kept
// here only for displaying the price/disable state; the server is what
// actually charges and rejects underfunded purchases.
const FAME_STORE_DYE_COST = 500;
let _fameStoreCurrentBalance = 0;
let _fameStoreInitialized = false;

function _fameStoreItemList() {
    // Fame-shop items: dyes (cosmetic) + enchantment crystals
    // (forge-fodder, items 808–815). Both categories cost the same flat
    // 500 fame per item — server-side gating in ServerFameStoreHelper.
    if (!game.itemData) return [];
    const list = [];
    for (const def of Object.values(game.itemData)) {
        if (!def) continue;
        if (def.category === 'dye' || def.category === 'crystal') list.push(def);
    }
    // Group dyes first, then crystals; itemId-asc within each group.
    list.sort((a, b) => {
        const ca = a.category === 'dye' ? 0 : 1;
        const cb = b.category === 'dye' ? 0 : 1;
        if (ca !== cb) return ca - cb;
        return (a.itemId || 0) - (b.itemId || 0);
    });
    return list;
}

function _setFameStoreStatus(text, kind) {
    const el = document.getElementById('fame-store-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'fame-store-status' + (kind ? ' ' + kind : '');
}

function renderFameStoreList() {
    const list = document.getElementById('fame-store-list');
    if (!list) return;
    list.innerHTML = '';
    const items = _fameStoreItemList();
    if (items.length === 0) {
        list.innerHTML = '<div style="grid-column:1/-1;padding:12px;color:#887868;text-align:center">Nothing for sale.</div>';
        return;
    }
    for (const def of items) {
        const row = document.createElement('div');
        row.className = 'fame-store-row';

        const icon = document.createElement('div');
        icon.className = 'fame-store-icon';
        // getItemSpriteUrl returns a data URL; fall back to a blank tile if
        // the renderer hasn't loaded the sheet yet.
        const url = getItemSpriteUrl({ itemId: def.itemId });
        if (url) icon.style.cssText += `background-image:url('${url}');background-size:contain;background-repeat:no-repeat;background-color:#1a1218`;
        row.appendChild(icon);

        const info = document.createElement('div');
        info.className = 'fame-store-info';
        info.innerHTML = `<div class="fame-store-name">${def.name || ('Item ' + def.itemId)}</div>
                          <div class="fame-store-cost">✦ ${FAME_STORE_DYE_COST} Fame</div>`;
        row.appendChild(info);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Buy';
        btn.disabled = _fameStoreCurrentBalance < FAME_STORE_DYE_COST;
        btn.addEventListener('click', () => {
            if (game.playerId == null) return;
            _setFameStoreStatus('Purchasing…', '');
            // Disable the row briefly so double-clicks don't fire two buys
            // before the server response lands.
            btn.disabled = true;
            try {
                network.send(PacketWriters.buyFameItem(game.playerId, def.itemId));
            } catch (e) {
                _setFameStoreStatus('Network error: ' + (e.message || e), 'error');
                btn.disabled = false;
            }
        });
        row.appendChild(btn);

        list.appendChild(row);
    }
}

function openFameStore(accountFame) {
    const modal = document.getElementById('fame-store-modal');
    if (!modal) return;
    _fameStoreCurrentBalance = Number(accountFame) || 0;
    document.getElementById('fame-store-fame').textContent = _fameStoreCurrentBalance.toLocaleString();
    // Clear stale status from any prior session.
    _setFameStoreStatus('');
    renderFameStoreList();
    modal.removeAttribute('hidden');
    // Bind once: close button + backdrop click.
    if (!_fameStoreInitialized) {
        _fameStoreInitialized = true;
        document.getElementById('fame-store-close-btn').addEventListener('click', closeFameStore);
        document.getElementById('fame-store-backdrop').addEventListener('click', closeFameStore);
    }
    // Cache the live account fame on the global account so the HUD stays
    // in sync without an extra REST roundtrip.
    if (account) account.accountFame = _fameStoreCurrentBalance;
}

function closeFameStore() {
    const modal = document.getElementById('fame-store-modal');
    if (modal) modal.setAttribute('hidden', '');
}

function isFameStoreOpen() {
    const modal = document.getElementById('fame-store-modal');
    return !!(modal && !modal.hasAttribute('hidden'));
}

document.getElementById('play-btn').addEventListener('click', () => {
    if (selectedCharacter) {
        gameServerHost = document.getElementById('server-addr').value || 'useast';
        startGame();
    }
});

document.getElementById('delete-char-btn').addEventListener('click', async () => {
    if (!selectedCharacter) return;
    const className = ALL_CLASSES[selectedCharacter.characterClass] || 'Character';
    if (!confirm(`Delete ${className}? This is permanent!`)) return;

    const errorEl = document.getElementById('char-error');
    try {
        await api.deleteCharacter(selectedCharacter.characterUuid);
        account = await api.getAccount(api.accountGuid);
        selectedCharacter = null;
        showCharacterSelect();
    } catch (err) {
        errorEl.textContent = err.message;
    }
});

document.getElementById('create-char-btn').addEventListener('click', async () => {
    if (selectedClassId === null) return;
    const errorEl = document.getElementById('char-error');
    const charCount = account.characters ? account.characters.length : 0;
    if (charCount >= 20) {
        errorEl.textContent = 'Character limit reached (20 max).';
        return;
    }
    const btn = document.getElementById('create-char-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';
    try {
        await api.createCharacter(api.accountGuid, selectedClassId);
        account = await api.getAccount(api.accountGuid);
        showCharacterSelect();
    } catch (err) {
        errorEl.textContent = err.message;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Create';
    }
});

document.getElementById('add-chest-btn').addEventListener('click', async () => {
    const errorEl = document.getElementById('char-error');
    const chestCount = account.playerVault ? account.playerVault.length : 0;
    if (chestCount >= 10) {
        errorEl.textContent = 'Vault chest limit reached (10 max).';
        return;
    }
    try {
        await api.createChest(api.accountGuid);
        account = await api.getAccount(api.accountGuid);
        const newCount = account.playerVault ? account.playerVault.length : 0;
        document.getElementById('chest-count').textContent = `Vault Chests: ${newCount}/10`;
    } catch (err) {
        errorEl.textContent = err.message;
    }
});

document.getElementById('change-pw-btn').addEventListener('click', async () => {
    const curr = document.getElementById('current-pw').value;
    const newPw = document.getElementById('new-pw').value;
    const confirm = document.getElementById('confirm-pw').value;
    const status = document.getElementById('pw-status');
    status.className = 'error';
    if (!curr || !newPw) { status.textContent = 'Fill in all fields'; return; }
    if (newPw !== confirm) { status.textContent = 'Passwords do not match'; return; }
    if (newPw.length < 4) { status.textContent = 'Password too short'; return; }
    try {
        await api.changePassword(curr, newPw);
        status.textContent = 'Password changed! Signing you back in...';
        status.className = 'error success';
        // Re-login with new password to get fresh session token
        const email = document.getElementById('email').value;
        const loginData = await api.login(email, newPw);
        account = await api.getAccount(loginData.accountGuid);
        status.textContent = 'Password changed successfully!';
        document.getElementById('current-pw').value = '';
        document.getElementById('new-pw').value = '';
        document.getElementById('confirm-pw').value = '';
        // Update the login form password field so next login works
        document.getElementById('password').value = newPw;
    } catch (e) {
        status.textContent = e.message;
    }
});

document.getElementById('logout-btn').addEventListener('click', () => {
    network.disconnect();
    api.clearSession();
    account = null;
    selectedCharacter = null;
    localChatRole = null;
    loginToken = null;
    loginEmail = '';
    loginPassword = '';
    // Clear guest credentials so a fresh guest account is created next time
    try {
        localStorage.removeItem('or_guest_email');
        localStorage.removeItem('or_guest_password');
        localStorage.removeItem('or_token');
    } catch (e) {}
    showScreen('login');
});

// --- Player Death ---
// Matches Java: GAME_OVER flag, send DeathAck, disconnect, show death screen
function handlePlayerDeath() {
    console.log('[GAME] Player died!');

    // Send DeathAckPacket to server
    network.send(PacketWriters.deathAck(game.playerId));

    // Disconnect from game server
    network.disconnect();

    // Stop game loop from processing input/rendering
    game.playerId = null;

    // Show death overlay
    showDeathScreen();
}

function showDeathScreen() {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'death-overlay';
    overlay.innerHTML = `
        <div class="death-content">
            <h1 class="death-title">GAME OVER</h1>
            <p class="death-subtitle">${game.playerName} has fallen.</p>
            <p class="death-info">Your character has been lost to the realm.</p>
            <button id="death-charselect-btn">Select Character</button>
            <button id="death-quit-btn" class="secondary">Quit</button>
        </div>
    `;
    document.getElementById('game-screen').appendChild(overlay);

    const doCharSelect = () => {
        const ol = document.getElementById('death-overlay');
        if (ol) ol.remove();
        game.fullReset();
        lastXDir = null; lastYDir = null;
        selectedSlot = -1;
        lastInvKey = ''; lastLootKey = '';
        updateInventoryUI._logged = false;
        if (renderer) { renderer.destroy(); renderer = null; }

        if (account && api.sessionToken) {
            api.getAccount(api.accountGuid).then(acc => {
                account = acc;
                showCharacterSelect();
            }).catch(() => showScreen('login'));
        } else {
            showScreen('login');
        }
    };

    const doQuit = () => {
        const ol = document.getElementById('death-overlay');
        if (ol) ol.remove();
        game.fullReset();
        if (renderer) { renderer.destroy(); renderer = null; }
        showScreen('login');
    };

    // Use onclick instead of addEventListener to avoid duplicate handler issues
    document.getElementById('death-charselect-btn').onclick = doCharSelect;
    document.getElementById('death-quit-btn').onclick = doQuit;
}

// Realm transition: matches Java PlayState portal handling
// 1. Send UsePortalPacket  2. Clear local state  3. Send LoginAckPacket
function doRealmTransition(portal, isVault) {
    console.log(`[REALM] Starting transition, vault=${isVault}, portal=${portal?.id}`);

    // Send UsePortalPacket matching Java factory methods exactly:
    // toVault(): portalId=-1, toVault=1, toNexus=-1
    // from():    portalId=id, toVault=-1, toNexus=-1
    // Server checks: isToVault() = toVault != -1, isToNexus() = toNexus != -1
    // So we MUST send -1 (not 0) for "false" flags!
    // Check if portal is a vault portal (portalId=2) — treat as vault entry
    const isVaultPortal = portal && portal.portalId === 2;
    if (isVault || isVaultPortal) {
        // Prevent double vault entry
        if (game.mapId === 1) return;
        network.sendUsePortal(-1n, game.realmId || 0n, game.playerId, 1, -1);
    } else if (portal) {
        network.sendUsePortal(portal.id, game.realmId || 0n, game.playerId, -1, -1);
    }

    // Clear local state (matches Java Realm.loadMap)
    game.prepareRealmTransition();
    showTransitionScreen();

    // Reset renderer tile debug flag so new tiles get logged
    if (renderer) {
        renderer._tileDebugLogged = false;
        renderer._debugLogged = false;
    }

    // Reset movement state
    lastXDir = null; lastYDir = null;
    lastInvKey = ''; lastLootKey = '';

    // Tell server we're ready for new tiles (triggers sendImmediateLoadMap)
    network.sendLoginAck(game.playerId);
}

function returnToCharacterSelect() {
    network.disconnect();
    game.fullReset();
    lastXDir = null; lastYDir = null;
    selectedSlot = -1;
    lastInvKey = ''; lastLootKey = '';
    updateInventoryUI._logged = false;

    // Destroy renderer
    if (renderer) {
        renderer.destroy();
        renderer = null;
    }

    // Close the options menu if it's open (we're leaving the game screen)
    closeOptionsMenu();

    // Refresh account data and show character select
    if (account && api.sessionToken) {
        api.getAccount(api.accountGuid).then(acc => {
            account = acc;
            showCharacterSelect();
        }).catch(() => showCharacterSelect());
    } else {
        showCharacterSelect();
    }
}

// ────────────────────────────────────────────────────────────────────────
// In-game options menu
// ────────────────────────────────────────────────────────────────────────
// The menu is an overlay on top of the #game-screen. Opening it sets
// input.menuOpen = true which blocks movement/shoot/ability/chat keys.
// The game keeps ticking behind the menu — this is a multiplayer online
// game, so the world can't be paused. Close via ESC, backdrop click,
// "Return to Game" button. The "Home Menu" button calls
// returnToCharacterSelect() (full disconnect + char-select screen).

function openOptionsMenu() {
    const menuEl = document.getElementById('options-menu');
    if (!menuEl || !menuEl.hasAttribute('hidden')) return;
    menuEl.removeAttribute('hidden');
    input.menuOpen = true;
    // Clear any held movement keys so the player stops moving when the menu
    // pops up mid-stride. Otherwise they'll coast in whatever direction they
    // were moving while the menu is open.
    input.keys = {};
}

function closeOptionsMenu() {
    const menuEl = document.getElementById('options-menu');
    if (!menuEl || menuEl.hasAttribute('hidden')) return;
    // Cancel any in-progress key rebind so its capture-phase listener doesn't
    // leak past the menu close and silently capture the next key the user presses.
    if (_rebindCleanup) _rebindCleanup();
    menuEl.setAttribute('hidden', '');
    input.menuOpen = false;
    // Persist any changes made in the menu
    if (game && game.settings) saveSettings(game.settings);
}

function toggleOptionsMenu() {
    const menuEl = document.getElementById('options-menu');
    if (!menuEl) return;
    if (menuEl.hasAttribute('hidden')) openOptionsMenu();
    else closeOptionsMenu();
}

// Bind the menu's event handlers once at startup. Called from the end of
// initialization so DOM elements are guaranteed to exist.
function initOptionsMenu() {
    const menuEl = document.getElementById('options-menu');
    if (!menuEl) return;

    // Backdrop click = close (but clicks on the panel itself stay open)
    document.getElementById('options-backdrop').addEventListener('click', closeOptionsMenu);

    // Tab switching
    const tabBtns = menuEl.querySelectorAll('.options-tab');
    const tabPanels = menuEl.querySelectorAll('.options-tab-panel');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
            tabPanels.forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
        });
    });

    // Footer buttons
    document.getElementById('options-resume-btn').addEventListener('click', closeOptionsMenu);
    document.getElementById('options-home-btn').addEventListener('click', () => {
        closeOptionsMenu();
        returnToCharacterSelect();
    });

    // Mobile gear button opens the menu
    const mobileOptBtn = document.getElementById('mobile-options-btn');
    if (mobileOptBtn) {
        mobileOptBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openOptionsMenu();
        });
    }

    // ── Form control wiring — read initial values from game.settings ──
    const s = game.settings;

    // Graphics
    bindCheckbox('opt-hide-other-bullets', () => s.graphics.hideOtherPlayerBullets,
        v => s.graphics.hideOtherPlayerBullets = v);
    bindCheckbox('opt-show-damage-numbers', () => s.graphics.showDamageNumbers,
        v => s.graphics.showDamageNumbers = v);
    bindCheckbox('opt-show-player-names', () => s.graphics.showPlayerNames,
        v => s.graphics.showPlayerNames = v);
    bindCheckbox('opt-show-transition', () => s.graphics.showTransitionScreen,
        v => s.graphics.showTransitionScreen = v);
    bindSelect('opt-render-quality', () => s.graphics.renderQuality,
        v => s.graphics.renderQuality = v);
    bindSelect('opt-max-bullets', () => String(s.graphics.maxBulletsOnScreen),
        v => s.graphics.maxBulletsOnScreen = parseInt(v, 10));

    // Mobile controls
    bindRange('opt-joystick-sens', 'opt-joystick-sens-val',
        () => s.mobile.joystickSensitivity, v => s.mobile.joystickSensitivity = v,
        v => v.toFixed(1));
    bindCheckbox('opt-left-handed', () => s.mobile.leftHanded, v => s.mobile.leftHanded = v);
    bindCheckbox('opt-haptic', () => s.mobile.haptic, v => s.mobile.haptic = v);

    // Audio
    bindRange('opt-vol-master', 'opt-vol-master-val', () => s.audio.master,
        v => s.audio.master = v, v => Math.round(v * 100) + '%');
    bindRange('opt-vol-sfx', 'opt-vol-sfx-val', () => s.audio.sfx,
        v => s.audio.sfx = v, v => Math.round(v * 100) + '%');
    bindRange('opt-vol-music', 'opt-vol-music-val', () => s.audio.music,
        v => s.audio.music = v, v => Math.round(v * 100) + '%');

    // Keybind table (desktop controls tab)
    buildKeybindTable();
}

function bindCheckbox(id, get, set) {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = !!get();
    el.addEventListener('change', () => set(el.checked));
}

function bindSelect(id, get, set) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = String(get());
    el.addEventListener('change', () => set(el.value));
}

function bindRange(id, labelId, get, set, format) {
    const el = document.getElementById(id);
    const labelEl = document.getElementById(labelId);
    if (!el) return;
    el.value = String(get());
    if (labelEl) labelEl.textContent = format(get());
    el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        set(v);
        if (labelEl) labelEl.textContent = format(v);
    });
}

// Keybind table rows — only movement keys are actually rebindable for now.
// The rest are rendered as "locked" with a "coming soon" tag.
const KEYBIND_ROWS = [
    { action: 'moveUp',    label: 'Move Up',         locked: false },
    { action: 'moveDown',  label: 'Move Down',       locked: false },
    { action: 'moveLeft',  label: 'Move Left',       locked: false },
    { action: 'moveRight', label: 'Move Right',      locked: false },
    { action: 'shoot',     label: 'Shoot',           locked: true  },
    { action: 'ability',   label: 'Ability',         locked: true  },
    { action: 'chat',      label: 'Open Chat',       locked: true  },
    { action: 'autofire',  label: 'Toggle Autofire', locked: true  },
    { action: 'inventory', label: 'Open Inventory',  locked: true  },
    { action: 'menu',      label: 'Open Menu',       locked: true  },
    { action: 'hpPotion',  label: 'Use HP Potion',   locked: false },
    { action: 'mpPotion',  label: 'Use MP Potion',   locked: false },
    { action: 'rotateLeft',  label: 'Rotate Camera Left',  locked: false },
    { action: 'rotateRight', label: 'Rotate Camera Right', locked: false },
    { action: 'resetCamera', label: 'Reset Camera',        locked: false },
    { action: 'lootPickup',  label: 'Pick Up Loot',        locked: false }
];

function formatKeyCode(code) {
    if (!code) return '—';
    if (code.startsWith('Key')) return code.substring(3);
    if (code.startsWith('Mouse')) return 'Mouse' + code.substring(5);
    return code;
}

function buildKeybindTable() {
    const tableEl = document.getElementById('opt-keybind-table');
    if (!tableEl) return;
    tableEl.innerHTML = '';
    const bindings = game.settings.controls.bindings;
    for (const row of KEYBIND_ROWS) {
        const rowEl = document.createElement('div');
        rowEl.className = 'keybind-row' + (row.locked ? ' locked' : '');
        rowEl.innerHTML = `
            <span class="keybind-label">${row.label}</span>
            <span class="keybind-value">${formatKeyCode(bindings[row.action])}</span>
            ${row.locked ? '' : '<button type="button" class="keybind-rebind-btn">Rebind</button>'}
        `;
        if (!row.locked) {
            const btn = rowEl.querySelector('.keybind-rebind-btn');
            btn.addEventListener('click', () => startRebind(row.action, rowEl));
        }
        tableEl.appendChild(rowEl);
    }
}

let _rebindCleanup = null;
function startRebind(action, rowEl) {
    // Cancel any in-progress rebind
    if (_rebindCleanup) _rebindCleanup();

    rowEl.classList.add('rebinding');
    const valueEl = rowEl.querySelector('.keybind-value');
    valueEl.textContent = 'press key';

    const listener = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
            // Cancel rebind, restore original
            cleanup();
            valueEl.textContent = formatKeyCode(game.settings.controls.bindings[action]);
            return;
        }
        game.settings.controls.bindings[action] = e.code;
        valueEl.textContent = formatKeyCode(e.code);
        cleanup();
    };
    const cleanup = () => {
        rowEl.classList.remove('rebinding');
        window.removeEventListener('keydown', listener, true);
        _rebindCleanup = null;
    };
    _rebindCleanup = cleanup;
    // Capture phase so we intercept the key before the chat handler etc.
    window.addEventListener('keydown', listener, true);
}

// --- Game Start ---
async function startGame() {
    showScreen('game');

    // Clean reset for reconnection — clear old handlers, state, renderer
    network.reset();
    game.fullReset();
    lastXDir = null; lastYDir = null;
    selectedSlot = -1;
    lastInvKey = ''; lastLootKey = '';
    if (renderer) { renderer.destroy(); renderer = null; }

    const statusEl = document.getElementById('connection-status');
    statusEl.textContent = 'Loading assets...';
    statusEl.className = '';

    // Init renderer
    const container = document.getElementById('game-canvas-container');
    renderer = new GameRenderer(container);
    await renderer.init();

    // Load game data
    try {
        const [tileData, enemyData, itemData, charClasses, portalData, projGroups, expLevels, mapData, lootContainerDefs, animData, classMaskData, dyeAssets] = await Promise.all([
            api.getGameData('tiles.json'),
            api.getGameData('enemies.json'),
            api.getGameData('game-items.json'),
            api.getGameData('character-classes.json'),
            api.getGameData('portals.json'),
            api.getGameData('projectile-groups.json'),
            api.getGameData('exp-levels.json'),
            api.getGameData('maps.json'),
            api.getGameData('loot-containers.json'),
            api.getGameData('animations.json'),
            // Per-class pixel masks (accessory vs clothing) painted in the
            // editor. Renderer uses them to recolor regions by dye id.
            api.getGameData('character-class-masks.json').catch(() => []),
            // Dye registry — maps dyeId to a recolor strategy. Solid colors
            // today; patterned cloths slot in here later without a wire change.
            api.getGameData('dye-assets.json').catch(() => [])
        ]);

        // Index by ID
        if (Array.isArray(tileData)) tileData.forEach(t => game.tileData[t.tileId] = t);
        else game.tileData = tileData;

        if (Array.isArray(enemyData)) enemyData.forEach(e => game.enemyData[e.enemyId] = e);
        else game.enemyData = enemyData;

        if (Array.isArray(itemData)) itemData.forEach(i => game.itemData[i.itemId] = i);
        else game.itemData = itemData;

        if (Array.isArray(charClasses)) charClasses.forEach(c => game.characterClasses[c.classId] = c);
        else game.characterClasses = charClasses;

        // Index loot container definitions by tierId
        game.lootContainerDefs = {};
        if (Array.isArray(lootContainerDefs)) lootContainerDefs.forEach(d => game.lootContainerDefs[d.tierId] = d);

        // Index animation definitions by "type:id" key
        game.animations = {};
        if (Array.isArray(animData)) animData.forEach(a => game.animations[`${a.objectType}:${a.objectId}`] = a);

        if (Array.isArray(portalData)) portalData.forEach(p => game.portalData[p.portalId] = p);
        else game.portalData = portalData;

        if (Array.isArray(projGroups)) projGroups.forEach(p => game.projectileGroups[p.projectileGroupId] = p);
        else game.projectileGroups = projGroups;

        game.expLevels = expLevels;

        // Index class masks by classId, and a secondary index by (classId, row, col)
        // for fast lookup at render time.
        game.classMasks = {};
        game.classMaskFrameIndex = {}; // key: `${classId}:${row}:${col}` -> frame
        if (Array.isArray(classMaskData)) {
            for (const entry of classMaskData) {
                game.classMasks[entry.classId] = entry;
                if (Array.isArray(entry.frames)) {
                    for (const f of entry.frames) {
                        game.classMaskFrameIndex[`${entry.classId}:${f.row}:${f.col}`] = f;
                    }
                }
            }
        }

        // Index dye assets by dyeId.
        game.dyeAssets = {};
        if (Array.isArray(dyeAssets)) {
            for (const d of dyeAssets) game.dyeAssets[d.dyeId] = d;
        }

        // Store map data in renderer for tile size lookups
        renderer.setMapData(mapData);
    } catch (e) {
        console.error('Failed to load game data:', e);
    }

    // Load sprite sheets
    statusEl.textContent = 'Loading sprites...';
    for (const sheet of SPRITE_SHEETS) {
        const key = sheet.replace('.png', '');
        await renderer.loadTexture(key, api.getSpriteUrl(sheet));
    }

    // Build tile textures from definitions
    renderer.buildTileTextures(game.tileData);

    // Connect to game server
    statusEl.textContent = 'Connecting to game server...';
    setupNetworkHandlers();

    network.onConnect = () => {
        statusEl.textContent = 'Logging in...';
        statusEl.className = '';
        // Send login command (prefer token-based auth, fall back to email+password)
        network.sendLogin(
            selectedCharacter.characterUuid,
            loginToken ? '' : loginEmail,
            loginToken ? '' : loginPassword,
            loginToken
        );
    };

    network.onDisconnect = () => {
        statusEl.textContent = 'Disconnected';
        statusEl.className = 'error';
    };

    network.connect(gameServerHost);

    // Init mobile touch controls
    initTouchControls(input);

    // Double-tap = use ability at tap location
    setDoubleTapHandler((screenX, screenY) => {
        if (!game.playerId || !renderer) return;
        const world = renderer.getWorldCoords(screenX, screenY, game);
        network.sendUseAbility(game.playerId, world.x, world.y);
    });

    // Start game loop
    requestAnimationFrame(gameLoop);
}

// --- Network Handlers ---
function setupNetworkHandlers() {
    network.on(PacketId.COMMAND, (data) => {
        // commandId 2 = LOGIN_RESPONSE
        if (data.commandId === 2) {
            try {
                const loginResp = JSON.parse(data.command);
                if (loginResp.success) {
                    // Use playerId from binary CommandPacket (exact BigInt),
                    // NOT from JSON (loses precision for int64 > 2^53)
                    game.playerId = data.playerId;
                    game.classId = loginResp.classId;
                    game.cameraX = loginResp.spawnX;
                    game.cameraY = loginResp.spawnY;
                    // Clear any pending click state so stale right-clicks
                    // from the login screen don't fire an ability on join
                    input.mouseClicked = [false, false, false];
                    console.log(`[LOGIN] playerId=${game.playerId} (type=${typeof game.playerId}), ` +
                        `classId=${game.classId}, spawn=(${game.cameraX}, ${game.cameraY})`);

                    // Store local player's chatRole from server
                    if (loginResp.chatRole) localChatRole = loginResp.chatRole;

                    // Create local player entity
                    game.players.set(game.playerId, {
                        id: game.playerId,
                        name: account.accountName || 'Player',
                        chatRole: localChatRole || null,
                        classId: loginResp.classId,
                        pos: { x: loginResp.spawnX, y: loginResp.spawnY },
                        targetX: loginResp.spawnX,
                        targetY: loginResp.spawnY,
                        dx: 0, dy: 0,
                        size: 32,
                        animFrame: 0, animTimer: 0, facing: 'right'
                    });

                    // Initialize inventory from login account data
                    // (don't wait for first UpdatePacket which may be delayed)
                    if (loginResp.account && loginResp.account.characters) {
                        const myChar = loginResp.account.characters.find(
                            c => c.characterUuid === selectedCharacter.characterUuid
                        );
                        if (myChar && myChar.items) {
                            // Build inventory array from GameItemRefDto set
                            const inv = new Array(20).fill(null);
                            for (const ref of myChar.items) {
                                if (ref.slotIdx >= 0 && ref.slotIdx < 20) {
                                    const itemDef = game.itemData[ref.itemId];
                                    if (itemDef) {
                                        inv[ref.slotIdx] = { ...itemDef, uid: ref.itemUuid || '' };
                                    }
                                }
                            }
                            game.inventory = inv;
                            lastInvKey = '';
                        }
                    }

                    // Send login ack and start heartbeat
                    network.sendLoginAck(game.playerId);
                    network.onHeartbeatSend = () => perfMetrics.recordHeartbeatSend();
                    network.startHeartbeat(game.playerId);

                    const statusEl = document.getElementById('connection-status');
                    statusEl.textContent = 'Connected';
                    statusEl.className = 'connected';

                    addChatMessage('SYSTEM', `Welcome to OpenRealm Server 0.6.0 — Playing as ${CLASS_NAMES[loginResp.classId]}`);
                } else {
                    const statusEl = document.getElementById('connection-status');
                    statusEl.textContent = 'Login failed';
                    statusEl.className = 'error';
                }
            } catch (e) {
                console.error('Failed to parse login response:', e);
            }
        }
        // commandId 4 = SERVER_ERROR
        else if (data.commandId === 4) {
            try {
                const err = JSON.parse(data.command);
                addChatMessage('SYSTEM', `Error: ${err.message}`);
            } catch (e) {}
        }
        // commandId 5 = PLAYER_ACCOUNT
        else if (data.commandId === 5) {
            try {
                const accMsg = JSON.parse(data.command);
                if (accMsg.account) account = accMsg.account;
            } catch (e) {}
        }
    });

    network.on(PacketId.LOAD_MAP, (data) => {
        // Detect realm/map change BEFORE handleLoadMap mutates game state.
        // The server streams LoadMapPacket at ~4 Hz to deliver incremental
        // tile data on the SAME map; we must not reap entities or rebuild
        // the entire tile layer for those — that's what was making portals
        // and enemies blink while the player walked around the nexus.
        const realmChanged = game.realmId !== data.realmId || game.mapId !== data.mapId;
        console.log(`[GAME] LoadMap: realmId=${data.realmId}, mapId=${data.mapId}, ` +
            `size=${data.mapWidth}x${data.mapHeight}, tiles=${data.tiles.length}, ` +
            `realmChanged=${realmChanged}`);
        game.handleLoadMap(data);
        if (renderer) {
            renderer.updateTileSize(data.mapId);
            if (realmChanged) {
                // True realm change: drop entity pool + force tile rebuild.
                renderer.prepareForNewRealm();
            } else if (data.tiles.length > 0) {
                // Same-map LoadMap stream is delivering new tiles. We must
                // rebuild the tile layer or the player will outrun the
                // cached region and walk into "void". Entities are NOT
                // touched here (the entity reap is gated to actual realm
                // changes via prepareForNewRealm) — that's what fixed the
                // 4 Hz portal/enemy blink without breaking tile streaming.
                renderer.invalidateTileCache();
            }
            game.tileSize = renderer.tileSize;
            renderer._tileDebugLogged = false;
        }
        // Build minimap tile cache only on actual map change
        if (!minimap) {
            minimap = new Minimap(document.getElementById('minimap-canvas'));
            minimap.onTeleport = (playerName) => {
                handleChatCommand('/tp ' + playerName);
                addChatMessage('SYSTEM', `Teleporting to ${playerName}...`);
            };
        }
        // Initialize/resize minimap tile cache on map dimension change,
        // then paint the tiles that just arrived
        minimap.buildTileCache(game);
        minimap.paintTiles(game, data.tiles);
    });
    network.on(PacketId.LOAD, (data) => {
        game.handleLoad(data);
        // Force loot UI refresh when containers change
        if (data.containers.length > 0) {
            lastLootKey = '';
            for (const c of data.containers) {
                const itemIds = c.items.map(i => i ? i.itemId : -1);
                // Loot container log removed for performance
            }
        }
    });
    network.on(PacketId.UNLOAD, (data) => {
        game.handleUnload(data);
        if (data.containers.length > 0) { lastLootKey = ''; }
    });
    network.on(PacketId.OBJECT_MOVE, (data) => game.handleObjectMove(data));
    network.on(PacketId.UPDATE, (data) => {
        game.handleUpdate(data);
        // Force inv refresh when our inventory updates
        if (data.playerId === game.playerId) {
            lastInvKey = ''; lastLootKey = '';
            forgeInventoryChanged();
        }
    });

    network.on(PacketId.TEXT, (data) => {
        game.handleText(data);
        // Capture zone name and difficulty during realm transitions
        if (game.transitionActive && data.from === 'SYSTEM') {
            if (!game.transitionZoneName && !data.message.startsWith('Difficulty:') && !data.message.startsWith('Enemies:')) {
                game.transitionZoneName = data.message;
            } else if (data.message.startsWith('Difficulty:')) {
                const diff = parseFloat(data.message.replace('Difficulty: ', ''));
                if (!isNaN(diff)) game.transitionDifficulty = diff;
            }
        }
        // Look up sender's chatRole from player map for name coloring
        const senderRole = game.getPlayerRoleByName(data.from);
        addChatMessage(data.from, data.message, senderRole);
    });

    network.on(PacketId.TEXT_EFFECT, (data) => {
        game.handleTextEffect(data);
    });

    network.on(PacketId.PLAYER_DEATH, (data) => {
        if (data.playerId === game.playerId) {
            handlePlayerDeath();
        }
    });

    network.on(PacketId.PLAYER_STATE, (data) => {
        game.handlePlayerState(data);
    });

    // Server reconciliation: server sends authoritative position + last processed input seq.
    // Client discards acknowledged inputs and replays remaining ones from server position.
    network.on(PacketId.PLAYER_POS_ACK, (data) => {
        game.handlePosAck(data);
    });

    network.on(PacketId.GLOBAL_PLAYER_POSITION, (data) => {
        game.handleGlobalPlayerPosition(data);
    });

    network.on(PacketId.HEARTBEAT, (data) => {
        // Server echoes our heartbeat back with our original timestamp.
        // Measure true RTT from the timestamp we sent.
        const sent = Number(data.timestamp);
        const rtt = Date.now() - sent;
        if (rtt > 0 && rtt < 5000) {
            perfMetrics.recordHeartbeatResponse(rtt);
        }
    });

    network.on(PacketId.CREATE_EFFECT, (data) => {
        // Visual particle effect — add to game's effect queue for rendering
        game.addVisualEffect({
            type: data.effectType,
            x: data.posX, y: data.posY,
            radius: data.radius,
            duration: data.duration,
            targetX: data.targetPosX, targetY: data.targetPosY,
            tier: data.tier || 0,
            startTime: Date.now()
        });
    });

    network.on(PacketId.OPEN_FORGE, (data) => {
        if (data && data.playerId != null) openForgeModal();
    });

    network.on(PacketId.OPEN_FAME_STORE, (data) => {
        if (!data || data.playerId == null) return;
        // Server sends the fresh fame total in the packet so we don't need to
        // re-fetch the account REST endpoint to display it.
        openFameStore(Number(data.accountFame) || 0);
    });

    // Trading handlers managed by trade.js module
    initTradeUI(game, network, addChatMessage, () => {
        lastInvKey = ''; lastLootKey = '';
    });

    // Forge UI handlers (forge.js module). Expose getItemSpriteUrl so the
    // forge can render the dropped sprite in its zones and pixel editor.
    window.getItemSpriteUrl = getItemSpriteUrl;
    window.getItemBaseSpriteUrl = (item) => {
        // Always return the un-enchanted sprite for use in the pixel editor.
        if (!item) return null;
        const def = game.itemData?.[item.itemId];
        if (!def || !def.spriteKey) return null;
        if (renderer) {
            const url = renderer.getSpriteDataUrl(def.spriteKey, def.col || 0, def.row || 0,
                def.spriteSize || 8, def.spriteHeight || 0);
            if (url) return url;
        }
        _ensureSpriteSheet(def.spriteKey);
        return _extractSprite(def.spriteKey, def.col || 0, def.row || 0, def.spriteSize || 8, def.spriteHeight || 0);
    };
    initForgeUI({ game, network, renderer, refreshInventory: () => {
        lastInvKey = ''; lastLootKey = '';
    }});
}

// --- Performance Metrics ---
const perfMetrics = {
    fps: 0, _frameCount: 0, _lastFpsSample: 0,
    ping: 0, jitter: 0,
    _pingSamples: [], _lastHeartbeatSend: 0,
    _lastServerPacketTime: 0,
    memoryMB: 0,
    update(timestamp) {
        // FPS counter (sampled every 500ms)
        this._frameCount++;
        if (timestamp - this._lastFpsSample >= 500) {
            this.fps = Math.round(this._frameCount / ((timestamp - this._lastFpsSample) / 1000));
            this._frameCount = 0;
            this._lastFpsSample = timestamp;
        }
        // Memory (if available)
        if (performance.memory) {
            this.memoryMB = (performance.memory.usedJSHeapSize / 1048576).toFixed(1);
        }
    },
    recordHeartbeatSend() {
        this._lastHeartbeatSend = Date.now();
    },
    // Called when the server echoes back our heartbeat with the original timestamp.
    // rtt = actual round-trip time measured from our timestamp.
    recordHeartbeatResponse(rtt) {
        this._pingSamples.push(rtt);
        if (this._pingSamples.length > 10) this._pingSamples.shift();
        // Ping = average RTT / 2 (one-way estimate)
        const avg = this._pingSamples.reduce((a, b) => a + b, 0) / this._pingSamples.length;
        this.ping = Math.round(avg / 2);
        // Jitter = stddev of one-way samples
        const pingAvg = avg / 2;
        const variance = this._pingSamples.reduce((sum, s) => sum + ((s / 2) - pingAvg) ** 2, 0) / this._pingSamples.length;
        this.jitter = Math.round(Math.sqrt(variance));
    }
};

// --- Game Loop ---
let lastTime = 0;
function gameLoop(timestamp) {
    if (lastTime === 0) lastTime = timestamp; // prevent massive first-frame dt
    const dt = Math.min((timestamp - lastTime) / 1000, 0.05); // Cap delta at 50ms
    lastTime = timestamp;
    perfMetrics.update(timestamp);
    // Feed measured RTT into game state for bullet fast-forward calculations.
    // perfMetrics.ping is one-way (RTT/2), so multiply back to get full RTT.
    game._lastPingMs = perfMetrics.ping * 2;

    if (currentScreen === 'game' && game.playerId !== null) {
        // Process input
        processInput(dt);

        // Update interpolation
        game.updateInterpolation(dt);

        // Render
        if (renderer) {
            renderer.render(game);
        }

        // Update minimap
        if (minimap) minimap.render(game);

        // Update HUD + perf overlay
        updateHUD();
        updatePerfOverlay();
    }

    requestAnimationFrame(gameLoop);
}

// --- Fixed 64Hz Simulation Tick ---
// Decoupled from render frame rate. Client simulates at exactly 64Hz to match server.
const SIM_TICK_RATE = 64;
const SIM_TICK_MS = 1000.0 / SIM_TICK_RATE;
const SIM_TICK_SEC = 1.0 / SIM_TICK_RATE;
let simAccumulator = 0; // ms of unprocessed time

// Build dirFlags bitmask from current keyboard/touch state
function sampleDirFlags() {
    if (input.chatMode || input.menuOpen) return 0;
    let flags = 0;
    if (isTouchDevice()) {
        const joy = getJoystickDir();
        if (joy.yDir === 0) flags |= 0x01; // up
        if (joy.yDir === 1) flags |= 0x02; // down
        if (joy.xDir === 3) flags |= 0x04; // left
        if (joy.xDir === 2) flags |= 0x08; // right
    } else {
        // Movement keys are rebindable via the options menu (settings.controls.bindings).
        // Arrow keys are always available as a fallback regardless of rebindings.
        const b = (game.settings && game.settings.controls && game.settings.controls.bindings) || {};
        if (input.isKeyDown(b.moveUp    || 'KeyW') || input.isKeyDown('ArrowUp'))    flags |= 0x01;
        if (input.isKeyDown(b.moveDown  || 'KeyS') || input.isKeyDown('ArrowDown'))  flags |= 0x02;
        if (input.isKeyDown(b.moveLeft  || 'KeyA') || input.isKeyDown('ArrowLeft'))  flags |= 0x04;
        if (input.isKeyDown(b.moveRight || 'KeyD') || input.isKeyDown('ArrowRight')) flags |= 0x08;
    }
    // Cancel opposing directions
    if ((flags & 0x01) && (flags & 0x02)) flags &= ~(0x01 | 0x02);
    if ((flags & 0x04) && (flags & 0x08)) flags &= ~(0x04 | 0x08);
    return flags;
}

// Camera rotation speed (radians/sec) — continuous while Q/E held
const CAM_ROTATE_SPEED = Math.PI; // 180 deg/sec

// Convert screen-space cardinal dirFlags into a world-space unit vector,
// rotated by -cameraAngle so a key press of "north" walks the player toward
// camera-relative-up regardless of how the camera is rotated.
//
// The previous rotateDirectionFlags() snapped to nearest of 8 directions (the
// 4-bit dirFlags wire format couldn't carry an angle). The new wire format
// (PlayerMovePacket vx/vy) is continuous, so any camera angle now produces
// continuous movement direction.
function screenDirFlagsToWorldVector(flags, cameraAngle) {
    if (flags === 0) return { vx: 0, vy: 0 };
    let dx = 0, dy = 0;
    if (flags & 0x01) dy -= 1; // up
    if (flags & 0x02) dy += 1; // down
    if (flags & 0x04) dx -= 1; // left
    if (flags & 0x08) dx += 1; // right
    const len = Math.hypot(dx, dy);
    if (len === 0) return { vx: 0, vy: 0 };
    dx /= len; dy /= len;
    if (cameraAngle === 0) return { vx: dx, vy: dy };
    // Rotate screen-space → world-space by -cameraAngle
    const c = Math.cos(-cameraAngle);
    const s = Math.sin(-cameraAngle);
    return { vx: dx * c - dy * s, vy: dx * s + dy * c };
}

// --- Input Processing ---
function processInput(dt) {
    const local = game.getLocalPlayer();
    if (!local) return;

    game.removeExpiredEffects();

    // Camera rotation — continuous while held, snaps to nearest 45° on release
    const b = (game.settings && game.settings.controls && game.settings.controls.bindings) || {};
    const rotLeftKey = b.rotateLeft || 'KeyQ';
    const rotRightKey = b.rotateRight || 'KeyE';
    const resetCamKey = b.resetCamera || 'KeyC';
    if (input.isKeyDown(rotLeftKey) && !input.chatMode && !input.menuOpen) {
        game.cameraAngle += CAM_ROTATE_SPEED * dt;
    }
    if (input.isKeyDown(rotRightKey) && !input.chatMode && !input.menuOpen) {
        game.cameraAngle -= CAM_ROTATE_SPEED * dt;
    }
    if (input.isKeyDown(resetCamKey) && !input.chatMode && !input.menuOpen) {
        input.keys[resetCamKey] = false;
        game.cameraAngle = 0;
    }

    // Sample screen-space direction → unit-vector world-space (vx, vy).
    // Continuous angles, no 22.5° snap behavior.
    const screenDirFlags = sampleDirFlags();
    let { vx, vy } = screenDirFlagsToWorldVector(screenDirFlags, game.cameraAngle);
    if (game.hasEffect(StatusEffect.PARALYZED)) { vx = 0; vy = 0; }

    // Run fixed-timestep simulation ticks (64Hz, matching server exactly)
    simAccumulator += dt * 1000;
    // Cap to prevent spiral of death (e.g., tabbed out for 2 seconds)
    if (simAccumulator > 250) simAccumulator = 250;

    if (!game._pendingInputs) game._pendingInputs = [];
    if (!game._inputSeq) game._inputSeq = 0;

    const preTickX = local.pos.x;
    const preTickY = local.pos.y;
    let ticksRan = 0;

    while (simAccumulator >= SIM_TICK_MS) {
        simAccumulator -= SIM_TICK_MS;
        game._inputSeq++;
        ticksRan++;

        // Predict movement locally using IDENTICAL physics to server
        game.simulateTick(local, vx, vy);

        // Buffer this input for reconciliation
        game._pendingInputs.push({ seq: game._inputSeq, vx, vy });

        // Cap buffer (64 ticks = 1s)
        if (game._pendingInputs.length > 64) {
            game._pendingInputs.shift();
        }

        // Send every tick — 1:1 with server processing. 21 bytes * 64Hz ≈ 1.3KB/s.
        network.sendPlayerMove(game.playerId, game._inputSeq, vx, vy);
    }

    // Interpolation between 64Hz ticks for smooth rendering at any fps.
    // We lerp between the pre-tick and post-tick positions rather than
    // extrapolating past the target, which caused overshoot jitter.
    if (ticksRan > 0) {
        local._interpFromX = preTickX;
        local._interpFromY = preTickY;
        local._interpToX = local.pos.x;
        local._interpToY = local.pos.y;
    }
    const interpFrac = simAccumulator / SIM_TICK_MS; // 0.0 – 1.0
    if (local._interpToX !== undefined) {
        // Standard lerp: from + (to - from) * t
        local._renderX = local._interpFromX + (local._interpToX - local._interpFromX) * interpFrac;
        local._renderY = local._interpFromY + (local._interpToY - local._interpFromY) * interpFrac;
    } else {
        local._renderX = local.pos.x;
        local._renderY = local.pos.y;
    }

    // Store screen-space flags for rendering (facing direction, animation)
    // Use screenDirFlags so sprite faces the screen-relative direction
    const up = !!(screenDirFlags & 0x01), down = !!(screenDirFlags & 0x02);
    const left = !!(screenDirFlags & 0x04), right = !!(screenDirFlags & 0x08);
    if (left) lastXDir = 3;
    else if (right) lastXDir = 2;
    else lastXDir = null;
    if (up) lastYDir = 0;
    else if (down) lastYDir = 1;
    else lastYDir = null;

    // Update dx/dy for animation and other systems
    const computed = game.getComputedStats();
    const spdStat = computed ? computed.spd : 10;
    let tilesPerSec = 4.0 + 5.6 * (spdStat / 75.0);
    if (game.hasEffect(StatusEffect.SPEEDY)) tilesPerSec *= 1.5;
    if (game.hasEffect(StatusEffect.PARALYZED)) tilesPerSec = 0;
    let spd = tilesPerSec * 32.0 / 64.0;
    let pdx = 0, pdy = 0;
    if (up) pdy = -1; if (down) pdy = 1;
    if (right) pdx = 1; if (left) pdx = -1;
    if (pdx !== 0 && pdy !== 0) spd = spd * Math.sqrt(2) / 2;
    local.dx = pdx * spd;
    local.dy = pdy * spd;

    // Shooting — uses wall-clock timestamp to match server's absolute time check.
    // Server: canShoot = (now - lastShotTime) > (1000 / dex)
    if (!game._lastShotTime) game._lastShotTime = 0;
    const aim = isTouchDevice() ? getAimDir() : null;
    const wantsShoot = aim ? aim.shooting : input.wantsShoot();
    // Tick down shooting animation timer
    if (game.shootingAnimTimer > 0) {
        game.shootingAnimTimer -= dt;
        if (game.shootingAnimTimer <= 0) {
            game.shootingAnim = null;
            game.attackFrame = 0;
            game.attackFrameTimer = 0;
        }
    }
    // Cycle attack animation frames while shooting
    if (game.shootingAnim) {
        game.attackFrameTimer += dt;
        if (game.attackFrameTimer > 0.08) { // ~80ms per frame
            game.attackFrameTimer = 0;
            game.attackFrame++;
        }
    }

    // Compute cooldown from stats
    const shootComputed = game.getComputedStats();
    const shootDexStat = shootComputed ? shootComputed.dex : 10;
    let shootDex = Math.floor((6.5 * (shootDexStat + 17.3)) / 75);
    const shootEffects = game.effectIds || [];
    if (shootEffects.some(id => id === 4)) shootDex = Math.floor(shootDex * 1.5);
    if (shootEffects.some(id => id === 11)) shootDex = 1;
    const shootCooldownMs = 1000 / Math.max(shootDex, 1) + 10;
    const canShoot = (performance.now() - game._lastShotTime) > shootCooldownMs;

    // STUNNED (3) blocks shooting — matches server's canShoot check
    const isStunned = game.hasEffect(StatusEffect.STUNNED);
    if (wantsShoot && !isMouseOverHud && canShoot && !isStunned && renderer) {
        let world;
        if (aim && aim.shooting) {
            // Aim joystick: project direction from player position
            const local = game.getLocalPlayer();
            if (local) {
                world = { x: local.pos.x + aim.dx * 300, y: local.pos.y + aim.dy * 300 };
            } else {
                world = { x: 0, y: 0 };
            }
        } else {
            world = renderer.getWorldCoords(input.mouseX, input.mouseY, game);
        }
        const local = game.getLocalPlayer();
        if (local) {
            // Determine attack animation from aim direction relative to player
            const relX = world.x - local.pos.x;
            const relY = world.y - local.pos.y;
            if (Math.abs(relX) > Math.abs(relY)) {
                game.shootingAnim = 'attack_side';
                // Flip sprite to face aim direction
                local.facing = relX < 0 ? 'left' : 'right';
            } else if (relY > 0) {
                game.shootingAnim = 'attack_down';
            } else {
                game.shootingAnim = 'attack_up';
            }
            game.shootingAnimTimer = 0.3; // hold attack anim; refreshes each shot
            const weapon = game.inventory.length > 0 ? game.inventory[0] : null;
            const projGroupId = weapon ? weapon.damage.projectileGroupId : 0;
            const shootSeq = ++projectileCounter;
            network.sendShoot(
                shootSeq, game.playerId, projGroupId,
                world.x, world.y, local.pos.x, local.pos.y
            );
            game._lastShotTime = performance.now();

            // Client-side predictive bullets: spawn local visual bullets immediately
            // so the player sees shots without waiting for the server round-trip.
            // Uses negative IDs; removed when server bullets arrive in LoadPacket.
            const pg = game.projectileGroups[projGroupId];
            if (pg && pg.projectiles) {
                // Match server: angle computed from player CENTER (pos + size/2)
                const halfSize = (local.size || 28) / 2;
                const cx = local.pos.x + halfSize;
                const cy = local.pos.y + halfSize;
                const baseAngle = -(Math.atan2(world.y - cy, world.x - cx) - Math.PI / 2);
                for (let pi = 0; pi < pg.projectiles.length; pi++) {
                    const proj = pg.projectiles[pi];
                    const projAngle = baseAngle + (parseFloat(proj.angle) || 0);
                    const localId = -(shootSeq * 100 + pi);
                    game.bullets.set(localId, {
                        id: localId,
                        projectileId: projGroupId,
                        pos: { x: cx - halfSize, y: cy - halfSize },
                        angle: projAngle,
                        magnitude: proj.magnitude || 3,
                        range: proj.range || 400,
                        size: proj.size || 16,
                        damage: 0,
                        amplitude: proj.amplitude || 0,
                        frequency: proj.frequency || 0,
                        flags: proj.flags || [],
                        invert: (proj.flags || []).includes(13),
                        _traveled: 0,
                        _clientCreatedTime: Date.now(),
                        _predicted: true
                    });
                }
            }
        }
    }

    // Ability (right click)
    if (input.wantsAbility() && !isMouseOverHud && renderer) {
        const world = renderer.getWorldCoords(input.mouseX, input.mouseY, game);
        network.sendUseAbility(game.playerId, world.x, world.y);
    }

    // ESC = Open/close the in-game options menu. (Used to instant-return to
    // the character select screen, which was dangerous during combat.) The
    // "Home Menu" button inside the menu still calls returnToCharacterSelect.
    if (input.isKeyDown('Escape')) {
        input.keys['Escape'] = false;
        toggleOptionsMenu();
        return;
    }

    // I = Toggle autofire
    if (input.isKeyDown('KeyI') && !input.chatMode) {
        input.keys['KeyI'] = false;
        const on = input.toggleAutofire();
        addChatMessage('SYSTEM', on ? 'Autofire enabled' : 'Autofire disabled');
    }

    // F1 or R = Go to nexus
    if (input.isKeyDown('F1') || (input.isKeyDown('KeyR') && !input.chatMode)) {
        input.keys['F1'] = false;
        input.keys['KeyR'] = false;
        network.sendUsePortal(-1n, game.realmId || 0n, game.playerId, -1, 1);
        game.prepareRealmTransition();
        showTransitionScreen();
    }

    // F2 = Use nearest portal
    if (input.isKeyDown('F2') || input.isKeyDown('Space')) {
        input.keys['F2'] = false;
        input.keys['Space'] = false;
        const local = game.getLocalPlayer();
        if (local) {
            let closest = null, closestDist = Infinity;
            for (const [id, portal] of game.portals) {
                const dx = portal.pos.x - local.pos.x;
                const dy = portal.pos.y - local.pos.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < closestDist) { closestDist = dist; closest = portal; }
            }
            if (closest && closestDist < 64) {
                doRealmTransition(closest, false);
            }
        }
    }

    // Number keys 1-8 = Smart inventory action (consume or equip-swap)
    for (let n = 1; n <= 8; n++) {
        const key = `Digit${n}`;
        if (input.isKeyDown(key) && !input.chatMode && !input.menuOpen) {
            input.keys[key] = false;
            const bagStart = activeBag === 1 ? 4 : 12;
            const slotIdx = bagStart + (n - 1);
            const item = game.inventory[slotIdx];
            if (item && item.itemId >= 0) {
                if (item.consumable) {
                    // Use consumable
                    network.sendMoveItem(game.playerId, slotIdx, slotIdx, false, true);
                    lastInvKey = '';
                } else if (item.targetSlot >= 0 && item.targetSlot <= 3) {
                    // Equipable item — must match the slot AND be useable by
                    // the player's class. canEquipInSlot mirrors the server
                    // check; the previous "targetClass < 0" shortcut allowed
                    // any class-group item to bypass class validation.
                    if (canEquipInSlot(item, item.targetSlot, game.classId)) {
                        network.sendMoveItem(game.playerId, item.targetSlot, slotIdx, false, false);
                        lastInvKey = '';
                    }
                }
            }
        }
    }

    // HP Potion hotkey (rebindable, default Z)
    {
        const hpKey = (game.settings?.controls?.bindings?.hpPotion) || 'KeyZ';
        if (input.isKeyDown(hpKey) && !input.chatMode && !input.menuOpen) {
            if (!updatePotionUI._hpCooldown || Date.now() - updatePotionUI._hpCooldown > 500) {
                updatePotionUI._hpCooldown = Date.now();
                if (game.hpPotions > 0) {
                    network.sendMoveItem(game.playerId, -1, 28, false, true);
                }
            }
        }
    }
    // MP Potion hotkey (rebindable, default X)
    {
        const mpKey = (game.settings?.controls?.bindings?.mpPotion) || 'KeyX';
        if (input.isKeyDown(mpKey) && !input.chatMode && !input.menuOpen) {
            if (!updatePotionUI._mpCooldown || Date.now() - updatePotionUI._mpCooldown > 500) {
                updatePotionUI._mpCooldown = Date.now();
                if (game.mpPotions > 0) {
                    network.sendMoveItem(game.playerId, -1, 29, false, true);
                }
            }
        }
    }

    // F = Interact with nearby tile (forge, etc.) if any, else pick up loot
    const lootKey = b.lootPickup || 'KeyF';
    if (input.isKeyDown(lootKey) && !input.chatMode && !input.menuOpen) {
        input.keys[lootKey] = false;
        if (_interactCandidate) {
            triggerNearbyInteract();
        } else {
            const loot = game.getNearbyLootContainer(64);
            if (loot && loot.items) {
                for (let i = 0; i < loot.items.length; i++) {
                    if (loot.items[i] && loot.items[i].itemId > 0) {
                        // Pick up from ground slot 20+i
                        network.sendMoveItem(game.playerId, -1, 20 + i, false, false);
                        break;
                    }
                }
            }
        }
    }
}

// --- Collision Check (matches Java TileManager.collisionTile exactly) ---
// Server uses: Rectangle(futurePos, size*0.85, size*0.85) at top-left corner
function checkCollision(entity, dx, dy) {
    if (!game.mapTiles || !renderer) return false;
    const ts = renderer.tileSize || 32;
    const size = entity.size || 32;
    const futureX = entity.pos.x + dx;
    const futureY = entity.pos.y + dy;

    // Map bounds (matches Java collidesXLimit/collidesYLimit)
    const mapW = game.mapWidth * ts, mapH = game.mapHeight * ts;
    if (futureX <= 0 || futureX + size >= mapW) return true;
    if (futureY <= 0 || futureY + size >= mapH) return true;

    // Hitbox: same as server (size * 0.85) at top-left of future position
    const hitSize = Math.floor(size * 0.85);
    const bx = futureX;
    const by = futureY;

    // Check collision tiles in 5x5 area around player center
    const cx = Math.floor((futureX + size / 2) / ts);
    const cy = Math.floor((futureY + size / 2) / ts);
    for (let ty = cy - 2; ty <= cy + 2; ty++) {
        for (let tx = cx - 2; tx <= cx + 2; tx++) {
            if (ty < 0 || ty >= game.mapHeight || tx < 0 || tx >= game.mapWidth) continue;
            const tile = game.mapTiles[ty]?.[tx];
            if (!tile || tile.collision <= 0) continue;
            const tileDef = game.tileData[tile.collision];
            if (!tileDef?.data?.hasCollision) continue;
            // AABB intersection (same as server Rectangle.intersect)
            const tl = tx * ts, tt = ty * ts;
            if (bx < tl + ts && bx + hitSize > tl && by < tt + ts && by + hitSize > tt) return true;
        }
    }

    // Void tile check
    if (cx >= 0 && cx < game.mapWidth && cy >= 0 && cy < game.mapHeight) {
        const baseTile = game.mapTiles[cy]?.[cx];
        if (baseTile && baseTile.base === 0) return true;
    }
    return false;
}

// --- Performance Overlay ---
let _perfEl = null;
function updatePerfOverlay() {
    if (!_perfEl || !_perfEl.parentNode) {
        _perfEl = document.createElement('div');
        _perfEl.id = 'perf-overlay';
        _perfEl.style.cssText = 'position:absolute;top:10px;left:10px;margin-top:28px;color:#aaa;font:11px monospace;z-index:11;pointer-events:none;text-shadow:1px 1px 2px #000;line-height:1.4;background:#1a1218cc;padding:4px 10px;border-radius:3px;';
        const gameScreen = document.getElementById('game-screen');
        if (gameScreen) gameScreen.appendChild(_perfEl);
        else document.body.appendChild(_perfEl);
    }
    const m = perfMetrics;
    const fpsColor = m.fps >= 55 ? '#6f6' : m.fps >= 30 ? '#ff6' : '#f66';
    const pingColor = m.ping < 50 ? '#6f6' : m.ping < 120 ? '#ff6' : '#f66';
    const memStr = m.memoryMB > 0 ? `MEM: ${m.memoryMB}MB<br>` : '';
    _perfEl.innerHTML =
        `FPS: <span style="color:${fpsColor}">${m.fps}</span><br>` +
        `${memStr}` +
        `PING: <span style="color:${pingColor}">${m.ping}ms</span><br>` +
        `JITTER: ${m.jitter}ms`;
}

// --- HUD Update ---
function updateHUD() {
    // Use computed stats (base + equipment bonuses) for display
    const computed = game.getComputedStats();

    // Player identity header: Name Lv. X ClassName
    const level = game.getPlayerLevel();
    const className = CLASS_NAMES[game.classId] || 'Unknown';
    const pName = game.playerName || 'Player';
    const identityEl = document.getElementById('player-identity');
    if (identityEl) {
        identityEl.textContent = `${pName}  Lv. ${level}  ${className}`;
    }

    // Account fame badge — lifetime fame banked from dead characters. Source
    // of truth is the REST account payload (account.accountFame), which gets
    // refreshed on death/return-to-charselect. Hidden when null/zero so new
    // accounts don't see an empty badge.
    const fameEl = document.getElementById('account-fame-display');
    if (fameEl) {
        const af = (account && Number.isFinite(Number(account.accountFame))) ? Number(account.accountFame) : 0;
        if (af > 0) {
            const valEl = document.getElementById('account-fame-value');
            if (valEl) valEl.textContent = af.toLocaleString();
            fameEl.style.display = '';
        } else {
            fameEl.style.display = 'none';
        }
    }

    // HP bar - max HP from computed stats
    const maxHp = computed ? computed.hp : game.maxHealth;
    const hpPct = maxHp > 0 ? Math.min(100, game.health / maxHp * 100) : 100;
    // Check max stats for gold highlighting
    const maxStats = game.getMaxStats();
    const isMaxed = (stat, val) => maxStats && val >= maxStats[stat];

    const hpSpan = document.getElementById('hp-text');
    hpSpan.textContent = `${game.health}/${maxHp}`;
    hpSpan.style.color = isMaxed('hp', game.stats?.hp) ? '#c8a86e' : '#fff';
    document.getElementById('hp-bar').style.width = `${hpPct}%`;

    // MP bar
    const maxMp = computed ? computed.mp : game.maxMana;
    const mpPct = maxMp > 0 ? Math.min(100, game.mana / maxMp * 100) : 100;
    const mpSpan = document.getElementById('mp-text');
    mpSpan.textContent = `${game.mana}/${maxMp}`;
    mpSpan.style.color = isMaxed('mp', game.stats?.mp) ? '#c8a86e' : '#fff';
    document.getElementById('mp-bar').style.width = `${mpPct}%`;

    // XP/Level/Fame bar
    const expInfo = game.getExpDisplayInfo();
    document.getElementById('xp-text').textContent = expInfo.text;
    document.getElementById('xp-bar').style.width = `${expInfo.pct}%`;
    // Gold bar for fame, green for XP
    document.getElementById('xp-bar').style.background = expInfo.isFame ? '#c8a86e' : '#40a040';

    // Stats panel — gold text when stat is maxed for class
    if (computed) {
        const base = game.stats;
        const statHtml = (label, statKey, baseVal, compVal) => {
            const bonus = compVal - baseVal;
            const bonusStr = bonus > 0 ? ` <span class="stat-bonus">+${bonus}</span>` : '';
            const maxed = isMaxed(statKey, baseVal);
            const color = maxed ? 'color:#c8a86e' : '';
            return `<div class="stat-row"><span class="stat-label">${label}</span><span class="stat-value" style="${color}">${compVal}${bonusStr}</span></div>`;
        };
        document.getElementById('stats-panel').innerHTML =
            statHtml('ATT', 'att', base.att, computed.att) +
            statHtml('DEF', 'def', base.def, computed.def) +
            statHtml('SPD', 'spd', base.spd, computed.spd) +
            statHtml('DEX', 'dex', base.dex, computed.dex) +
            statHtml('VIT', 'vit', base.vit, computed.vit) +
            statHtml('WIS', 'wis', base.wis, computed.wis);
    }

    // Inventory
    updateInventoryUI();
    updatePotionUI();
    updateTransitionScreen();

    // Trade buttons
    const tradeBtns = document.getElementById('trade-buttons');
    if (game.isTrading) {
        tradeBtns.style.display = 'flex';
    } else {
        tradeBtns.style.display = 'none';
    }

    // Nearby players with tooltips and context menu (trade.js module)
    updateNearbyPlayers(game, network, renderer, addChatMessage);

    // Portal proximity prompt — show "Enter [Dungeon Name]" when near a portal
    const portalPrompt = document.getElementById('portal-prompt');
    const local = game.getLocalPlayer();
    if (local && game.portals.size > 0) {
        let nearPortal = null, nearDist = Infinity;
        for (const [id, portal] of game.portals) {
            const pdx = portal.pos.x - local.pos.x, pdy = portal.pos.y - local.pos.y;
            const d = Math.sqrt(pdx * pdx + pdy * pdy);
            if (d < nearDist) { nearDist = d; nearPortal = portal; }
        }
        if (nearPortal && nearDist < 64) {
            const portalDef = game.portalData[nearPortal.portalId];
            const name = portalDef ? portalDef.portalName || 'Portal' : 'Portal';
            document.getElementById('portal-name').textContent = name.replace(/_/g, ' ');
            portalPrompt.style.display = 'flex';
        } else {
            portalPrompt.style.display = 'none';
        }
    } else {
        portalPrompt.style.display = 'none';
    }

    // Interactive tile prompt — scan a 5x5 region around the player for any tile
    // whose definition has a non-empty interactionType. Currently only "forge".
    updateInteractPrompt(local);
}

// Tracks the candidate tile shown in the interact prompt so the click/key
// handler knows what to send.
let _interactCandidate = null; // {tileX, tileY, type}

function updateInteractPrompt(local) {
    const prompt = document.getElementById('interact-prompt');
    if (!prompt) return;
    if (!local || !game.mapTiles || !game.tileData) {
        prompt.style.display = 'none';
        _interactCandidate = null;
        return;
    }
    const ts = game.tileSize || 32;
    const px = Math.floor(local.pos.x / ts);
    const py = Math.floor(local.pos.y / ts);
    let found = null;
    let bestDist = Infinity;
    // 5x5 search window (3-tile radius, capped at distance 3)
    for (let dy = -2; dy <= 2 && !found; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            const tx = px + dx, ty = py + dy;
            if (ty < 0 || tx < 0) continue;
            const row = game.mapTiles[ty];
            if (!row) continue;
            const cell = row[tx];
            if (!cell) continue;
            // Check both layers for an interactive definition
            const ids = [cell.collision, cell.base];
            for (const id of ids) {
                if (id == null || id < 0) continue;
                const def = game.tileData[id];
                if (!def || !def.interactionType) continue;
                const cx = (tx + 0.5) * ts;
                const cy = (ty + 0.5) * ts;
                const d2 = (cx - local.pos.x) * (cx - local.pos.x) + (cy - local.pos.y) * (cy - local.pos.y);
                if (d2 < bestDist) {
                    bestDist = d2;
                    found = { tileX: tx, tileY: ty, type: def.interactionType, name: def.name || def.interactionType };
                }
            }
        }
    }
    if (found && bestDist <= (3 * ts) * (3 * ts)) {
        _interactCandidate = found;
        const label = document.getElementById('interact-label');
        const btn = document.getElementById('interact-btn');
        const verb = found.type === 'forge' ? 'Use Forge'
            : found.type === 'fame_store' ? 'Open Fame Store'
            : `Use ${found.name}`;
        if (label) label.textContent = verb + ' (F)';
        if (btn) btn.textContent = 'Use';
        prompt.style.display = 'flex';
    } else {
        _interactCandidate = null;
        prompt.style.display = 'none';
    }
}

export function triggerNearbyInteract() {
    if (!_interactCandidate || game.playerId == null) return;
    network.sendInteractTile(game.playerId, _interactCandidate.tileX, _interactCandidate.tileY);
}

// --- Inventory System ---
let selectedSlot = -1; // Currently selected slot for swap (-1 = none)
let activeBag = 1; // 1 = slots 4-11, 2 = slots 12-19
let lastInvKey = '';
let isMouseOverHud = false; // Prevents shooting/ability when hovering over UI
let dragSlot = -1; // Slot being dragged (-1 = none)
let dragEl = null; // Floating drag element
let _dragOverBag = 0; // Target bag number hovered during drag (0 = none)
let lastLootKey = '';
let lastTouchTime = 0; // Tracks recent touch events to filter synthetic mouse events
// Sprite data URL cache to avoid re-extracting every frame
const spriteCache = {};
// Preloaded sprite sheet images for canvas-based extraction (works without renderer)
const _spriteSheetImages = {};

/** Load a sprite sheet image if not already cached. Returns the Image or null. */
function _ensureSpriteSheet(spriteKey) {
    const key = spriteKey.replace('.png', '');
    if (_spriteSheetImages[key]) return _spriteSheetImages[key];
    // Start async load — returns null this call, cached next time
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = api.getSpriteUrl(spriteKey);
    img.onload = () => { _spriteSheetImages[key] = img; };
    _spriteSheetImages[key] = null; // Mark as loading (prevents re-requesting)
    return null;
}

/**
 * Extract a sprite from a sheet image using a plain canvas (no PIXI required).
 * Returns a data URL or null if the sheet isn't loaded yet.
 */
function _extractSprite(spriteKey, col, row, spriteSize, spriteHeight) {
    const key = spriteKey.replace('.png', '');
    const img = _spriteSheetImages[key];
    if (!img) return null;
    const sw = spriteSize || 8;
    const sh = spriteHeight || sw;
    const canvas = document.createElement('canvas');
    canvas.width = sw; canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, col * sw, row * sh, sw, sh, 0, 0, sw, sh);
    return canvas.toDataURL();
}

function getItemSpriteUrl(item) {
    if (!item || item.itemId < 0) return null;

    // Try game.itemData first, fall back to preloaded defs for char select screen
    const itemDef = game.itemData[item.itemId] || _graveyardItemDefs?.[item.itemId] || item;
    if (!itemDef.spriteKey) return null;

    // Cache by (itemId, uid, enchantments-hash). Items without enchantments share
    // the cache entry across instances (cacheKey = itemId).
    const ench = item.enchantments || [];
    let cacheKey;
    if (ench.length === 0) {
        cacheKey = `${item.itemId}`;
    } else {
        const sig = ench.map(e => `${e.pixelX},${e.pixelY},${e.pixelColor}`).join('|');
        cacheKey = `${item.itemId}#${item.uid || ''}#${sig}`;
    }
    if (spriteCache[cacheKey]) return spriteCache[cacheKey];

    // Get the base sprite data URL
    let baseUrl = null;
    if (renderer) {
        baseUrl = renderer.getSpriteDataUrl(itemDef.spriteKey, itemDef.col || 0,
            itemDef.row || 0, itemDef.spriteSize || 8, itemDef.spriteHeight || 0);
    }
    if (!baseUrl) {
        _ensureSpriteSheet(itemDef.spriteKey);
        baseUrl = _extractSprite(itemDef.spriteKey, itemDef.col || 0,
            itemDef.row || 0, itemDef.spriteSize || 8, itemDef.spriteHeight || 0);
    }
    if (!baseUrl) return null;

    // No enchantments — return base URL directly
    if (ench.length === 0) {
        spriteCache[cacheKey] = baseUrl;
        return baseUrl;
    }

    // Composite enchantment pixels onto the base sprite via canvas. The image
    // load is async, so synchronously return the base URL while a re-render
    // happens once the composite finishes — we cache the composite for next call.
    const sw = itemDef.spriteSize || 8;
    const sh = itemDef.spriteHeight || sw;
    const tmp = document.createElement('canvas');
    tmp.width = sw; tmp.height = sh;
    const ctx = tmp.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const img = new Image();
    img.onload = () => {
        ctx.drawImage(img, 0, 0, sw, sh);
        for (const e of ench) {
            const a = ((e.pixelColor >>> 24) & 0xff) / 255;
            const r = (e.pixelColor >>> 16) & 0xff;
            const g = (e.pixelColor >>> 8) & 0xff;
            const b = e.pixelColor & 0xff;
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a || 1})`;
            ctx.fillRect(e.pixelX, e.pixelY, 1, 1);
        }
        spriteCache[cacheKey] = tmp.toDataURL();
        // Force inventory rebuild on the next frame so the painted sprite shows
        lastInvKey = '';
    };
    img.src = baseUrl;
    // First call: hand back the base URL while the composite renders in the background
    return baseUrl;
}

function updateInventoryUI() {
    const equipEl = document.getElementById('equip-slots');
    const invEl = document.getElementById('inv-slots');

    // Only rebuild if inventory changed
    const invKey = game.inventory.map(i => i ? `${i.itemId}x${i.stackCount || 1}#${(i.enchantments || []).length}` : -1).join(',') + ':' + selectedSlot + ':bag' + activeBag;
    if (!updateInventoryUI._logged && game.inventory.length > 0) {
        updateInventoryUI._logged = true;
        // Inventory log removed for performance
    }
    // Include trade selection state in cache key during trading
    const tradeKey = game.isTrading && game.myTradeSelected
        ? ':t:' + game.myTradeSelected.join(',') : '';
    const fullKey = invKey + tradeKey;
    if (lastInvKey === fullKey) { updateGroundLootUI(); return; }
    lastInvKey = fullKey;

    // Update labels for trade mode
    const invTabs = document.getElementById('inv-tabs');
    if (game.isTrading) {
        invTabs.style.display = 'none';
        document.getElementById('inv-label').style.display = '';
        document.getElementById('inv-label').textContent = 'YOUR OFFER (click to select)';
    } else {
        invTabs.style.display = '';
        document.getElementById('inv-label').style.display = 'none';
    }

    // Detached slot elements never fire mouseleave; hide any stuck tooltip.
    hideItemTooltip();
    equipEl.innerHTML = '';
    invEl.innerHTML = '';

    const labels = ['Wpn', 'Abl', 'Amr', 'Ring'];
    for (let i = 0; i < 4; i++) {
        equipEl.appendChild(createSlot(game.inventory[i], labels[i], i));
    }

    // Render the active bag (bag 1 = slots 4-11, bag 2 = slots 12-19)
    // During trading, always show bag 1 (trade selections map to slots 4-11)
    const currentBag = game.isTrading ? 1 : activeBag;
    const bagStart = currentBag === 1 ? 4 : 12;
    const bagEnd = bagStart + 8;
    for (let i = bagStart; i < bagEnd; i++) {
        invEl.appendChild(createSlot(game.inventory[i], `${i - bagStart + 1}`, i));
    }

    updateGroundLootUI();
}

// ---- Realm Transition Screen ----
const TRANSITION_DURATION_MS = 2000;
const TRANSITION_FADE_MS = 400;
let _transitionAnimFrame = 0;
let _transitionAnimTimer = 0;
let _transitionSpriteFrames = null;

function showTransitionScreen() {
    if (!game.settings?.graphics?.showTransitionScreen) return;
    const el = document.getElementById('realm-transition');
    if (!el) return;
    el.style.display = 'flex';
    el.classList.remove('fade-out');
    document.getElementById('transition-zone').textContent = '';
    document.getElementById('transition-skulls').innerHTML = '';
    document.getElementById('transition-diff-label').textContent = '';
    _transitionAnimFrame = 0;
    _transitionAnimTimer = 0;
    _transitionSpriteFrames = null;
    // Clear sprite canvas
    const canvas = document.getElementById('transition-player-sprite');
    if (canvas) canvas.getContext('2d').clearRect(0, 0, 64, 64);
}

function updateTransitionScreen() {
    if (!game.transitionActive) return;
    const el = document.getElementById('realm-transition');
    if (!el || el.style.display === 'none') return;

    const elapsed = Date.now() - game.transitionStartTime;
    const dataReady = !game.awaitingRealmTransition;

    // Update zone name when available
    const zoneEl = document.getElementById('transition-zone');
    if (zoneEl && game.transitionZoneName && zoneEl.textContent !== game.transitionZoneName) {
        zoneEl.textContent = game.transitionZoneName;
    }

    // Update difficulty skulls when available
    const skullsEl = document.getElementById('transition-skulls');
    const diffLabel = document.getElementById('transition-diff-label');
    if (skullsEl && game.transitionDifficulty > 0 && !skullsEl.dataset.set) {
        const diff = Math.round(game.transitionDifficulty);
        const maxSkulls = 7;
        let html = '';
        for (let i = 1; i <= maxSkulls; i++) {
            html += i <= diff
                ? '<span class="skull-filled">\u2620</span>'
                : '<span class="skull-empty">\u2620</span>';
        }
        skullsEl.innerHTML = html;
        skullsEl.dataset.set = '1';
        if (diffLabel) diffLabel.textContent = `Difficulty ${game.transitionDifficulty.toFixed(1)}`;
    }

    // Animate player walking sprite
    renderTransitionSprite();

    // Dismiss: wait for both minimum duration AND data loaded
    if (elapsed >= TRANSITION_DURATION_MS && dataReady) {
        el.classList.add('fade-out');
        setTimeout(() => {
            el.style.display = 'none';
            el.classList.remove('fade-out');
            game.transitionActive = false;
            // Reset skulls dataset for next transition
            if (skullsEl) delete skullsEl.dataset.set;
        }, TRANSITION_FADE_MS);
        game.transitionActive = false; // prevent re-entry
    }
}

function renderTransitionSprite() {
    const canvas = document.getElementById('transition-player-sprite');
    if (!canvas || !renderer) return;
    const ctx = canvas.getContext('2d');

    // Load animation frames on first call
    if (!_transitionSpriteFrames) {
        const animKey = `player:${game.transitionClassId}`;
        const animDef = game.animations?.[animKey];
        if (!animDef) return;
        const walkAnim = animDef.animations['walk_front'] || animDef.animations['walk_side'];
        if (!walkAnim) return;
        _transitionSpriteFrames = walkAnim.frames.map(f => {
            const url = renderer.getSpriteDataUrl(
                animDef.spriteKey.replace('.png', '') + '.png',
                f.col, f.row, animDef.spriteSize || 8, animDef.spriteHeight || 0);
            return url;
        }).filter(Boolean);
        if (_transitionSpriteFrames.length === 0) { _transitionSpriteFrames = null; return; }
    }

    // Advance animation (swap frames every 300ms)
    _transitionAnimTimer++;
    if (_transitionAnimTimer >= 18) { // ~300ms at 60fps
        _transitionAnimTimer = 0;
        _transitionAnimFrame = (_transitionAnimFrame + 1) % _transitionSpriteFrames.length;
    }

    const url = _transitionSpriteFrames[_transitionAnimFrame];
    if (!url) return;

    // Draw sprite centered on canvas
    const img = new Image();
    img.src = url;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 64, 64);
    ctx.drawImage(img, 0, 0, 64, 64);
}

// Consumable potion display
let _lastPotionKey = '';
function updatePotionUI() {
    const key = `${game.hpPotions}:${game.mpPotions}`;
    if (key === _lastPotionKey) return;
    _lastPotionKey = key;

    const hpCount = document.getElementById('hp-potion-count');
    const mpCount = document.getElementById('mp-potion-count');
    if (hpCount) hpCount.textContent = game.hpPotions;
    if (mpCount) mpCount.textContent = game.mpPotions;

    // Update hotkey labels from rebindable settings
    const hpKeyEl = document.getElementById('hp-potion-key');
    const mpKeyEl = document.getElementById('mp-potion-key');
    const hpBind = (game.settings?.controls?.bindings?.hpPotion) || 'KeyZ';
    const mpBind = (game.settings?.controls?.bindings?.mpPotion) || 'KeyX';
    if (hpKeyEl) hpKeyEl.textContent = hpBind.replace('Key', '').replace('Digit', '');
    if (mpKeyEl) mpKeyEl.textContent = mpBind.replace('Key', '').replace('Digit', '');

    // Load potion icons if not yet loaded
    const hpIcon = document.getElementById('hp-potion-icon');
    const mpIcon = document.getElementById('mp-potion-icon');
    if (hpIcon && !hpIcon.dataset.loaded && renderer) {
        const url = renderer.getSpriteDataUrl('lofiObj2.png', 2, 3, 8, 0);
        if (url) {
            hpIcon.innerHTML = `<img src="${url}">`;
            hpIcon.dataset.loaded = '1';
        }
    }
    if (mpIcon && !mpIcon.dataset.loaded && renderer) {
        const url = renderer.getSpriteDataUrl('lofiObj2.png', 3, 3, 8, 0);
        if (url) {
            mpIcon.innerHTML = `<img src="${url}">`;
            mpIcon.dataset.loaded = '1';
        }
    }
}

// Double-click to consume potions, single-click to drop one
document.getElementById('hp-potion-slot')?.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (game.hpPotions > 0) {
        network.sendMoveItem(game.playerId, -1, 28, false, true);
    }
});
document.getElementById('mp-potion-slot')?.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (game.mpPotions > 0) {
        network.sendMoveItem(game.playerId, -1, 29, false, true);
    }
});
document.getElementById('hp-potion-slot')?.addEventListener('click', (e) => {
    if (game.hpPotions > 0) {
        network.sendMoveItem(game.playerId, -1, 28, true, false);
    }
});
document.getElementById('mp-potion-slot')?.addEventListener('click', (e) => {
    if (game.mpPotions > 0) {
        network.sendMoveItem(game.playerId, -1, 29, true, false);
    }
});

// Inventory bag tab switching
document.querySelectorAll('#inv-tabs .inv-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const bag = parseInt(tab.dataset.bag);
        if (bag === activeBag) return;
        activeBag = bag;
        selectedSlot = -1;
        document.querySelectorAll('#inv-tabs .inv-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        lastInvKey = '';
    });
});

function updateGroundLootUI() {
    const lootPanel = document.getElementById('ground-loot-panel');
    const lootEl = document.getElementById('ground-loot-slots');

    // During trading, show partner's full inventory with selection highlights
    if (game.isTrading) {
        lootPanel.style.display = 'block';
        document.querySelector('#ground-loot-panel h4').textContent =
            `${game.tradePartnerName}'s Items`;

        // Get partner's selection state from server
        const partnerSel = game.getPartnerTradeSelection();
        const partnerSelected = partnerSel?.selection || [];
        // Use partner inventory from AcceptTradePacket
        const partnerInv = game.tradePartnerInv || [];

        const tradeKey = 'trade:' + partnerInv.map((it, i) =>
            (partnerSelected[i] ? '*' : '') + (it ? it.itemId : 0)).join(',');
        if (lastLootKey === tradeKey) return;
        lastLootKey = tradeKey;

        hideItemTooltip(); lootEl.innerHTML = '';
        // Show partner's inventory slots 4-11 (their backpack, not equipment)
        for (let i = 0; i < 8; i++) {
            const item = partnerInv[i + 4]; // Slots 4-11 of partner's inventory
            const div = document.createElement('div');
            div.className = 'inv-slot loot-slot';
            // Highlight items the partner has SELECTED for trade
            if (partnerSelected[i]) div.classList.add('trade-selected');

            if (item && item.itemId >= 0) {
                div.addEventListener('mouseenter', (ev) => showItemTooltip(item, ev));
                div.addEventListener('mousemove', (ev) => positionItemTooltip(ev));
                div.addEventListener('mouseleave', hideItemTooltip);
                const spriteUrl = getItemSpriteUrl(item);
                if (spriteUrl) {
                    const img = document.createElement('img');
                    img.src = spriteUrl;
                    div.appendChild(img);
                }
                if (item.tier >= 0) {
                    const tierEl = document.createElement('span');
                    tierEl.className = `item-tier tier-${Math.min(item.tier, 5)}`;
                    tierEl.textContent = `T${item.tier}`;
                    div.appendChild(tierEl);
                }
            }
            const lbl = document.createElement('span');
            lbl.className = 'slot-label';
            lbl.textContent = `${i + 1}`;
            div.appendChild(lbl);
            lootEl.appendChild(div);
        }
        return;
    }

    document.querySelector('#ground-loot-panel h4').textContent = 'Loot Bag';

    const nearbyLoot = game.getNearbyLootContainer();
    if (!nearbyLoot || !nearbyLoot.items || nearbyLoot.items.length === 0) {
        lootPanel.style.display = 'none';
        lastLootKey = '';
        return;
    }

    // Rebuild when contents change (compare item IDs)
    const lootKey = nearbyLoot.lootContainerId + ':' +
        nearbyLoot.items.map(i => i ? i.itemId : 0).join(',');
    if (lastLootKey === lootKey) return;
    lastLootKey = lootKey;

    lootPanel.style.display = 'block';
    lootEl.innerHTML = '';
    for (let i = 0; i < Math.min(8, nearbyLoot.items.length); i++) {
        const item = nearbyLoot.items[i];
        const slot = createSlot(item, `${i + 1}`, 20 + i, true);
        lootEl.appendChild(slot);
    }
}

// ---- Custom themed item tooltip ----
// Single shared element, populated on hover. Cursor-follow with edge-aware
// flipping so it never clips outside the viewport.
let _itemTooltipEl = null;
function _ensureItemTooltipEl() {
    if (_itemTooltipEl && _itemTooltipEl.parentNode) return _itemTooltipEl;
    _itemTooltipEl = document.createElement('div');
    _itemTooltipEl.id = 'item-tooltip';
    _itemTooltipEl.style.display = 'none';
    document.body.appendChild(_itemTooltipEl);
    return _itemTooltipEl;
}
function showItemTooltip(item, ev) {
    const html = game.getItemTooltipHTML(item);
    if (!html) return;
    const el = _ensureItemTooltipEl();
    el.innerHTML = html;
    el.style.display = 'block';
    positionItemTooltip(ev);
}
function positionItemTooltip(ev) {
    if (!_itemTooltipEl || _itemTooltipEl.style.display === 'none') return;
    const pad = 14;
    const w = _itemTooltipEl.offsetWidth;
    const h = _itemTooltipEl.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Default: above-left of cursor; flip to right/below if it would clip.
    let x = ev.clientX - w - pad;
    let y = ev.clientY - h - pad;
    if (x < 8) x = ev.clientX + pad;
    if (y < 8) y = ev.clientY + pad;
    if (x + w > vw - 8) x = vw - w - 8;
    if (y + h > vh - 8) y = vh - h - 8;
    _itemTooltipEl.style.left = x + 'px';
    _itemTooltipEl.style.top = y + 'px';
}
function hideItemTooltip() {
    if (_itemTooltipEl) _itemTooltipEl.style.display = 'none';
}

function createSlot(item, label, slotIdx, isLoot = false) {
    const div = document.createElement('div');
    div.className = 'inv-slot' + (isLoot ? ' loot-slot' : '');
    div.dataset.slotIdx = slotIdx;
    if (slotIdx === selectedSlot) div.classList.add('selected');

    // Trade selection highlight — use local tracking
    if (game.isTrading && slotIdx >= 4 && slotIdx <= 11 && game.myTradeSelected) {
        if (game.myTradeSelected[slotIdx - 4]) {
            div.classList.add('trade-selected');
        }
    }

    if (item && item.itemId >= 0) {
        // Custom themed tooltip on hover (replaces the unstyled native
        // div.title, which couldn't carry the OryxSimplex font / palette).
        div.addEventListener('mouseenter', (ev) => showItemTooltip(item, ev));
        div.addEventListener('mousemove', (ev) => positionItemTooltip(ev));
        div.addEventListener('mouseleave', hideItemTooltip);

        const spriteUrl = getItemSpriteUrl(item);
        if (spriteUrl) {
            const img = document.createElement('img');
            img.src = spriteUrl;
            div.appendChild(img);
        } else {
            const dot = document.createElement('div');
            dot.style.cssText = 'width:32px;height:32px;background:#c8a86e;border-radius:3px;';
            div.appendChild(dot);
        }

        if (item.tier >= 0) {
            const tierEl = document.createElement('span');
            tierEl.className = `item-tier tier-${Math.min(item.tier, 5)}`;
            tierEl.textContent = `T${item.tier}`;
            div.appendChild(tierEl);
        }

        // Stack count overlay (×N) for stackable items with count > 1
        if (item.stackable && (item.stackCount || 1) > 1) {
            const stackEl = document.createElement('span');
            stackEl.className = 'item-stack';
            stackEl.textContent = `×${item.stackCount}`;
            div.appendChild(stackEl);
        }
    }

    const lbl = document.createElement('span');
    lbl.className = 'slot-label';
    lbl.textContent = label;
    div.appendChild(lbl);

    // Click / double-tap: single click = select/swap, double click/tap = consume
    let lastClickTime = 0;
    div.addEventListener('click', (e) => {
        e.stopPropagation();
        // Skip click if we just finished a drag
        if (dragSlot >= 0) return;
        const now = Date.now();
        if (now - lastClickTime < 350 && item && item.itemId >= 0 && item.consumable
            && slotIdx >= 4 && slotIdx <= 19) {
            // Double click/tap — consume the item
            network.sendMoveItem(game.playerId, slotIdx, slotIdx, false, true);
            lastInvKey = '';
            lastClickTime = 0;
            return;
        }
        lastClickTime = now;
        onSlotClick(slotIdx, item);
    });
    // Right click (desktop) = drop
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); onSlotRightClick(slotIdx, item); });

    // Drag start (desktop only - skip on touch devices to not interfere with taps)
    div.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // left click only
        // Skip if this is a touch-originated mouse event
        if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
        // Fallback: skip if we've seen a recent touch event (within 500ms)
        if (Date.now() - lastTouchTime < 500) return;
        if (item && item.itemId >= 0) {
            e.preventDefault();
            startDrag(slotIdx, item, e);
        }
    });

    // Touch-based drag start (with hold delay to distinguish from tap)
    let touchHoldTimer = null;
    div.addEventListener('touchstart', (e) => {
        lastTouchTime = Date.now();
        if (!item || item.itemId < 0) return;
        const touch = e.touches[0];
        touchHoldTimer = setTimeout(() => {
            startDrag(slotIdx, item, { clientX: touch.clientX, clientY: touch.clientY });
        }, 300); // Start drag after 300ms hold
    }, { passive: true });

    div.addEventListener('touchend', () => {
        if (touchHoldTimer) { clearTimeout(touchHoldTimer); touchHoldTimer = null; }
    });

    div.addEventListener('touchmove', () => {
        if (touchHoldTimer) { clearTimeout(touchHoldTimer); touchHoldTimer = null; }
    }, { passive: true });

    return div;
}

// Empty item placeholder (matches server's empty slot representation)
const EMPTY_ITEM = { itemId: 0, uid: '', name: '', description: '',
    stats: {hp:0,mp:0,def:0,att:0,spd:0,dex:0,vit:0,wis:0},
    damage: {projectileGroupId:0,min:0,max:0},
    effect: {self:false,effectId:0,duration:0n,cooldownDuration:0n,mpCost:0},
    consumable: false, tier: -1, targetSlot: 0, targetClass: -1, fameBonus: 0 };

function onSlotClick(slotIdx, item, isRightClick = false) {
    // During trading, clicking inventory slots 4-11 toggles trade selection
    if (game.isTrading && slotIdx >= 4 && slotIdx <= 11) {
        toggleTradeSelection(slotIdx);
        return;
    }

    // Ground loot: single click = pick up to first empty inv slot
    if (slotIdx >= 20 && slotIdx <= 27 && item && item.itemId >= 0) {
        // console.log(`[INV] Picking up from ground slot ${slotIdx}, itemId=${item.itemId}`);
        // Send with target=4 (first inv slot) so server's isInv1 check passes
        // Server will use firstEmptyInvSlot() regardless
        network.sendMoveItem(game.playerId, 4, slotIdx, false, false);
        lastInvKey = ''; lastLootKey = '';
        return;
    }

    if (selectedSlot === -1) {
        // Nothing selected - select this slot if it has an item
        if (item && item.itemId >= 0) {
            selectedSlot = slotIdx;
            lastInvKey = '';
        }
    } else {
        if (slotIdx === selectedSlot) {
            selectedSlot = -1; // Deselect
        } else if (selectedSlot >= 0 && selectedSlot <= 19 && slotIdx >= 0 && slotIdx <= 19) {
            // Swap/equip/move between slots 0-19
            // console.log(`[INV] Swap slot ${selectedSlot} <-> slot ${slotIdx}`);
            network.sendMoveItem(game.playerId, slotIdx, selectedSlot, false, false);
            selectedSlot = -1;
        } else {
            selectedSlot = -1;
        }
        lastInvKey = ''; lastLootKey = '';
    }
}

function onSlotRightClick(slotIdx, item) {
    if (game.isTrading) {
        onSlotClick(slotIdx, item, true);
        return;
    }
    // Full shard stack of 10? Right-click forges it into a Crystal in place.
    if (item && item.category === 'shard' && (item.stackCount || 0) >= 10
            && slotIdx >= 4 && slotIdx <= 19) {
        network.sendConsumeShardStack(game.playerId, slotIdx);
        lastInvKey = '';
        return;
    }
    // Right-click: drop item to ground
    if (item && item.itemId >= 0 && slotIdx >= 0 && slotIdx <= 19) {
        network.sendMoveItem(game.playerId, -1, slotIdx, true, false);
        lastInvKey = '';
    }
}

function toggleTradeSelection(slotIdx) {
    if (!game.myTradeSelected) game.myTradeSelected = new Array(8).fill(false);
    const selIdx = slotIdx - 4;
    if (selIdx < 0 || selIdx >= 8) return;

    // Toggle selection
    game.myTradeSelected[selIdx] = !game.myTradeSelected[selIdx];
    game.tradeConfirmed = false;

    // Send UpdatePlayerTradeSelectionPacket to server
    network.send(PacketWriters.tradeSelection(game.playerId, game.myTradeSelected));
    lastInvKey = ''; lastLootKey = '';
}

// Drop selected item when clicking game canvas (outside inventory)
document.getElementById('game-canvas-container').addEventListener('click', () => {
    // Blur chat input when clicking on game canvas — returns keyboard to game
    document.getElementById('chat-input').blur();
    if (selectedSlot >= 0 && selectedSlot <= 19 && currentScreen === 'game') {
        // console.log(`[INV] Dropping item from slot ${selectedSlot} (canvas click)`);
        network.sendMoveItem(game.playerId, -1, selectedSlot, true, false);
        selectedSlot = -1;
        lastInvKey = '';
    }
});

// --- HUD hover detection (blocks shooting/ability over UI) ---
document.getElementById('hud').addEventListener('mouseenter', () => { isMouseOverHud = true; });
document.getElementById('hud').addEventListener('mouseleave', () => { isMouseOverHud = false; });
document.getElementById('chat-panel').addEventListener('mouseenter', () => { isMouseOverHud = true; });
document.getElementById('chat-panel').addEventListener('mouseleave', () => { isMouseOverHud = false; });

// --- Drag and Drop for inventory slots ---
function startDrag(slotIdx, item, e) {
    if (!item || item.itemId < 0) return;
    dragSlot = slotIdx;
    selectedSlot = -1;

    dragEl = document.createElement('div');
    dragEl.className = 'inv-slot dragging';
    dragEl.style.cssText = 'position:fixed;pointer-events:none;z-index:200;opacity:0.8;width:40px;height:40px;';
    const spriteUrl = getItemSpriteUrl(item);
    if (spriteUrl) {
        const img = document.createElement('img');
        img.src = spriteUrl;
        img.style.cssText = 'width:100%;height:100%;image-rendering:pixelated;';
        dragEl.appendChild(img);
    }
    document.body.appendChild(dragEl);
    moveDrag(e);
}

function moveDrag(e) {
    if (!dragEl) return;
    dragEl.style.left = (e.clientX - 20) + 'px';
    dragEl.style.top = (e.clientY - 20) + 'px';
    // Track which bag tab the cursor is hovering over during drag
    _dragOverBag = 0;
    document.querySelectorAll('.inv-tab').forEach(t => t.classList.remove('drag-hover'));
    if (dragSlot >= 4 && dragSlot <= 19) {
        const hoverTarget = document.elementFromPoint(e.clientX, e.clientY);
        const tabEl = hoverTarget ? hoverTarget.closest('.inv-tab') : null;
        if (tabEl) {
            const targetBag = parseInt(tabEl.dataset.bag);
            const fromBag = dragSlot < 12 ? 1 : 2;
            if (targetBag && targetBag !== fromBag) {
                _dragOverBag = targetBag;
                tabEl.classList.add('drag-hover');
            }
        }
    }
    // Highlight forge dropzone under cursor (modal is open)
    if (isForgeOpen()) {
        document.querySelectorAll('.forge-dropzone').forEach(z => z.classList.remove('drag-hover'));
        const hover = document.elementFromPoint(e.clientX, e.clientY);
        const zone = hover ? hover.closest('.forge-dropzone') : null;
        if (zone) {
            zone.classList.add('drag-hover');
            window.__forgeHoverZone = zone.dataset.zone;
        } else {
            window.__forgeHoverZone = null;
        }
    }
}

function endDrag(e) {
    if (dragSlot < 0 || !dragEl) { cleanupDrag(); return; }

    // Find which slot we dropped on
    const dropTarget = document.elementFromPoint(e.clientX, e.clientY);

    // Forge dropzone takes precedence when the modal is open
    if (isForgeOpen()) {
        const fz = dropTarget ? dropTarget.closest('.forge-dropzone') : null;
        if (fz && tryForgeDrop(dragSlot, fz.dataset.zone)) {
            cleanupDrag();
            return;
        }
    }

    const slotEl = dropTarget ? dropTarget.closest('.inv-slot') : null;
    const targetIdx = slotEl ? parseInt(slotEl.dataset.slotIdx) : -1;

    if (targetIdx >= 0 && targetIdx !== dragSlot && targetIdx <= 27) {
        if (targetIdx >= 20) {
            // Drop to ground
            network.sendMoveItem(game.playerId, -1, dragSlot, true, false);
        } else {
            // Equipment-slot validation. The server swaps the two slots
            // when both contain items, so a swap into OR out of an equip
            // slot must validate the item that ends up equipped.
            //
            // Case A — dragging INTO an equip slot (targetIdx 0-3): the
            //   dragged item ends up equipped. Validate dragged item.
            // Case B — dragging OUT OF an equip slot (dragSlot 0-3) onto
            //   an inventory slot that already has an item: the inventory
            //   item ends up equipped via swap. Validate that item against
            //   dragSlot. If the destination slot is empty, no swap-in
            //   happens, so no validation is needed.
            if (targetIdx >= 0 && targetIdx <= 3) {
                const dragItem = game.inventory && game.inventory[dragSlot];
                const def = dragItem && game.itemData ? game.itemData[dragItem.itemId] : null;
                if (def && !canEquipInSlot(def, targetIdx, game.classId)) {
                    cleanupDrag();
                    return;
                }
            }
            if (dragSlot >= 0 && dragSlot <= 3 && targetIdx >= 4) {
                const tgtItem = game.inventory && game.inventory[targetIdx];
                if (tgtItem && tgtItem.itemId >= 0) {
                    const tgtDef = game.itemData ? game.itemData[tgtItem.itemId] : null;
                    if (!tgtDef || !canEquipInSlot(tgtDef, dragSlot, game.classId)) {
                        cleanupDrag();
                        return;
                    }
                }
            }
            // Swap between inventory/equipment slots
            network.sendMoveItem(game.playerId, targetIdx, dragSlot, false, false);
        }
        lastInvKey = ''; lastLootKey = '';
    } else if (_dragOverBag > 0 && dragSlot >= 4 && dragSlot <= 19) {
        // Dropped while hovering over another bag tab — move to first empty slot
        const bagStart = _dragOverBag === 1 ? 4 : 12;
        const bagEnd = bagStart + 8;
        let emptySlot = -1;
        for (let i = bagStart; i < bagEnd; i++) {
            if (!game.inventory[i] || game.inventory[i].itemId < 0) {
                emptySlot = i;
                break;
            }
        }
        if (emptySlot >= 0) {
            network.sendMoveItem(game.playerId, emptySlot, dragSlot, false, false);
            lastInvKey = ''; lastLootKey = '';
        }
    }

    cleanupDrag();
}

// Equipment-slot compatibility check — mirrors CharacterClass.isValidUser
// + the targetSlot match in ServerItemHelper.handleMoveItem. Used by
// drag-drop and the keyboard equip hotkeys to reject mismatched moves
// before we send them to the server.
//
// targetClass values follow the server enum:
//   >= 0  : exact class id (must match playerClassId)
//   -1    : ROBE   (Wizard/Priest/Necromancer/Mystic/Sorcerer)
//   -2    : LEATHER(Archer/Rogue/Assassin/Trickster/Huntress)
//   -3    : HEAVY  (Warrior/Knight/Paladin)
//   -4    : ALL    (any class)
//   -5..-8: weapon-type groups (STAFF/WAND/DAGGER/BOW user)
function canEquipInSlot(itemDef, targetSlotIdx, playerClassId) {
    if (!itemDef) return false;
    // Consumable + stackable items can't be equipped at all.
    if (itemDef.consumable) return false;
    if (itemDef.stackable) return false;
    // Item must belong in this slot. targetSlot >= 0 means "this exact slot".
    // targetSlot -1 (auto-assign) is permissive.
    if (itemDef.targetSlot != null && itemDef.targetSlot >= 0
            && itemDef.targetSlot !== targetSlotIdx) return false;
    // Class compatibility.
    const tc = itemDef.targetClass;
    if (tc == null || tc === -4) return true; // ALL
    if (tc >= 0) return tc === playerClassId;
    // Class groups: Wizard 2 / Priest 3 / Necromancer 8 / Mystic 9 / Sorcerer 11 = ROBE
    //               Archer 1 / Rogue 0 / Assassin 7 / Trickster 10 / Huntress 12 = LEATHER
    //               Warrior 4 / Knight 5 / Paladin 6 = HEAVY
    const ROBE    = new Set([2, 3, 8, 9, 11]);
    const LEATHER = new Set([0, 1, 7, 10, 12]);
    const HEAVY   = new Set([4, 5, 6]);
    // Weapon-type users — same groupings as Java's CharacterClass:
    //   isStaffUser  -> Wizard, Necromancer, Mystic
    //   isWandUser   -> Priest, Sorcerer
    //   isDaggerUser -> Rogue, Assassin, Trickster
    //   isBowUser    -> Archer, Huntress
    const STAFF  = new Set([2, 8, 9]);
    const WAND   = new Set([3, 11]);
    const DAGGER = new Set([0, 7, 10]);
    const BOW    = new Set([1, 12]);
    switch (tc) {
        case -1: return ROBE.has(playerClassId);
        case -2: return LEATHER.has(playerClassId);
        case -3: return HEAVY.has(playerClassId);
        case -5: return STAFF.has(playerClassId);
        case -6: return WAND.has(playerClassId);
        case -7: return DAGGER.has(playerClassId);
        case -8: return BOW.has(playerClassId);
        default: return false;
    }
}

function cleanupDrag() {
    dragSlot = -1;
    _dragOverBag = 0;
    if (dragEl) { dragEl.remove(); dragEl = null; }
    document.querySelectorAll('.inv-tab').forEach(t => t.classList.remove('drag-hover'));
}

document.addEventListener('mousemove', moveDrag);
document.addEventListener('mouseup', endDrag);

// Touch event handlers for drag operations (ensures cleanup on mobile)
document.addEventListener('touchmove', (e) => {
    if (dragSlot < 0 || !dragEl) return;
    const touch = e.touches[0];
    if (touch) moveDrag({ clientX: touch.clientX, clientY: touch.clientY });
}, { passive: true });

document.addEventListener('touchend', (e) => {
    if (dragSlot < 0) return;
    const touch = e.changedTouches[0];
    if (touch) {
        endDrag({ clientX: touch.clientX, clientY: touch.clientY });
    } else {
        cleanupDrag();
    }
});

document.addEventListener('touchcancel', cleanupDrag);

// --- Chat ---
const CHAT_ROLE_COLORS = {
    'sysadmin': '#ff4040',
    'admin':    '#c8a86e',
    'mod':      '#a040c0',
    'demo':     '#cccccc',
};
const CHAT_NAME_COLORS = {
    'SYSTEM':   '#c8a86e',
    'Overseer': '#e8c840',
};
const DEFAULT_NAME_COLOR = '#4080e0';

function getNameColor(from, role) {
    if (CHAT_NAME_COLORS[from]) return CHAT_NAME_COLORS[from];
    if (role && CHAT_ROLE_COLORS[role]) return CHAT_ROLE_COLORS[role];
    return DEFAULT_NAME_COLOR;
}

function addChatMessage(from, message, role) {
    const el = document.getElementById('chat-messages');
    const div = document.createElement('div');
    if (from === 'SYSTEM') {
        div.className = 'msg-system';
        div.textContent = message;
    } else {
        div.className = 'msg-player';
        const color = getNameColor(from, role);
        const nameSpan = `<span class="msg-name" style="color:${color}">[${escapeHtml(from)}]</span>`;
        div.innerHTML = `${nameSpan}: ${escapeHtml(message)}`;
    }
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

// Chat input
const chatInput = document.getElementById('chat-input');
chatInput.addEventListener('focus', () => { input.chatMode = true; });
chatInput.addEventListener('blur', () => { input.chatMode = false; });
// Click anywhere outside chat = return focus to game
document.getElementById('hud').addEventListener('mousedown', (e) => {
    if (e.target !== chatInput) chatInput.blur();
});
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const msg = chatInput.value.trim();
        if (msg) {
            if (msg.startsWith('/')) {
                handleChatCommand(msg);
            } else {
                network.sendText(game.playerName || 'Player', 'Player', msg);
            }
            chatInput.value = '';
        }
        chatInput.blur();
        // CRITICAL: stop this Enter from bubbling to the window-level
        // "Enter opens chat" listener below. Without this, the same Enter
        // press that sends the message also re-focuses the input, so the
        // player has to click the game canvas to escape chat.
        e.preventDefault();
        e.stopPropagation();
    }
    if (e.key === 'Escape') {
        chatInput.value = '';
        chatInput.blur();
        e.preventDefault();
        e.stopPropagation();
    }
});

function handleChatCommand(msg) {
    // ServerCommandMessage format: {"command": "cmdname", "args": ["arg1", "arg2"]}
    // Matches Java's ServerCommandMessage.parseFromInput(): command = first word, args = rest
    const parts = msg.substring(1).split(' '); // Remove leading /
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Client-only commands
    if (cmd === 'clear') {
        game.chatMessages = [];
        document.getElementById('chat-messages').innerHTML = '';
        return;
    }

    // Block trade commands for demo/guest accounts
    if ((cmd === 'trade' || cmd === 'accept') && localChatRole === 'demo') {
        addChatMessage('SYSTEM', 'Guest accounts cannot trade');
        return;
    }

    // Send as ServerCommandMessage via CommandPacket (commandId byte = 3 = SERVER_COMMAND)
    const payload = JSON.stringify({ command: cmd, args: args });
    network.send(PacketWriters.command(game.playerId, 3, payload));

    // Local feedback for known commands
    if (cmd === 'trade' && args.length > 0) {
        addChatMessage('SYSTEM', `Trade request sent to ${args[0]}`);
    } else if (cmd === 'confirm' && args[0] === 'true') {
        game.tradeConfirmed = true;
        addChatMessage('SYSTEM', 'Trade confirmed. Waiting for partner...');
    }
}

// Position joystick sticky above chat panel
function repositionJoystick() {
    const joystick = document.getElementById('touch-joystick');
    const panel = document.getElementById('chat-panel');
    if (joystick && panel) {
        const chatRect = panel.getBoundingClientRect();
        joystick.style.bottom = (window.innerHeight - chatRect.top + 4) + 'px';
    }
}

// Chat toggle button
document.getElementById('chat-toggle').addEventListener('click', () => {
    const panel = document.getElementById('chat-panel');
    panel.classList.toggle('collapsed');
    requestAnimationFrame(repositionJoystick);
});

// Position joystick on load and resize
repositionJoystick();
window.addEventListener('resize', repositionJoystick);

// Enter key opens chat (but not while the options menu is open — Enter inside
// the menu would otherwise pop chat open behind the modal)
window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter'
            && document.activeElement !== chatInput
            && currentScreen === 'game'
            && !input.menuOpen) {
        chatInput.focus();
    }
});

// In-game logout button removed — logout is only available on the character-select
// screen (#logout-btn). Keeping it out of the HUD frees vertical space so the
// ground loot panel stays visible on small/mobile viewports.

// --- Trade Buttons ---
document.getElementById('trade-confirm-btn').addEventListener('click', () => {
    handleChatCommand('/confirm true');
});
document.getElementById('trade-cancel-btn').addEventListener('click', () => {
    handleChatCommand('/decline');
});

// --- Mobile Action Buttons ---
document.getElementById('mobile-ability-btn')?.addEventListener('click', () => {
    if (!game.playerId || !renderer) return;
    const local = game.getLocalPlayer();
    if (!local) return;
    // Use ability toward the center of screen (default target)
    const world = renderer.getWorldCoords(window.innerWidth / 2, window.innerHeight / 2, game);
    network.sendUseAbility(game.playerId, world.x, world.y);
});

document.getElementById('mobile-vault-btn')?.addEventListener('click', () => {
    if (!game.playerId) return;
    doRealmTransition(null, true);
});

// --- View Mode Toggle (mobile/desktop) ---
// Use the same detection logic as renderer.js and touch.js to determine current mode.
// Cannot rely on joystick DOM state — it's set later during network setup.
function isCurrentlyMobile() {
    const override = localStorage.getItem('openrealm_viewmode');
    if (override === 'mobile') return true;
    if (override === 'desktop') return false;
    const smallScreen = window.innerWidth < 900 && window.innerHeight < 600;
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    return smallScreen || mobileUA;
}
const viewToggle = document.getElementById('viewmode-toggle');
if (viewToggle) {
    const mobileNow = isCurrentlyMobile();
    viewToggle.textContent = mobileNow ? 'Desktop View' : 'Mobile View';
    viewToggle.addEventListener('click', () => {
        localStorage.setItem('openrealm_viewmode', mobileNow ? 'desktop' : 'mobile');
        window.location.reload();
    });
}

document.getElementById('portal-enter-btn')?.addEventListener('click', () => {
    if (!game.playerId) return;
    const local = game.getLocalPlayer();
    if (!local) return;
    let closest = null, closestDist = Infinity;
    for (const [id, portal] of game.portals) {
        const pdx = portal.pos.x - local.pos.x, pdy = portal.pos.y - local.pos.y;
        const d = Math.sqrt(pdx * pdx + pdy * pdy);
        if (d < closestDist) { closestDist = d; closest = portal; }
    }
    if (closest && closestDist < 64) {
        doRealmTransition(closest, false);
    }
});

document.getElementById('interact-btn')?.addEventListener('click', () => {
    triggerNearbyInteract();
});

// --- Init ---
showScreen('login');
initOptionsMenu();
