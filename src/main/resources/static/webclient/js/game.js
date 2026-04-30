// Game state management - entities, map, player data, trading, damage text

// Projectile behavior flags — control how a bullet moves (stored in Bullet.flags)
export const ProjectileFlag = {
    PLAYER_PROJECTILE: 10, PARAMETRIC: 12, INVERTED_PARAMETRIC: 13, ORBITAL: 20,
    ARMOR_PIERCING: 23, PASS_THROUGH_TERRAIN: 24,
    // Pierces every enemy on its path (server tracks per-enemy hit dedup).
    // Client uses this to skip the local "delete on first enemy hit" behavior
    // for predicted player bullets so the visual matches the server.
    PASS_THROUGH_ENEMIES: 25
};

// Entity status effects — applied on-hit or from abilities (stored in entity.effectIds)
export const StatusEffect = {
    INVISIBLE: 0, HEALING: 1, PARALYZED: 2, STUNNED: 3, SPEEDY: 4,
    HEAL: 5, INVINCIBLE: 6, NONE: 8, TELEPORT: 9, DAZED: 11,
    DAMAGING: 14, STASIS: 15, CURSED: 16, POISONED: 17,
    ARMORED: 18, BERSERK: 19, SLOWED: 21, ARMOR_BROKEN: 22
};

export const CLASS_NAMES = ['Rogue', 'Archer', 'Wizard', 'Priest', 'Warrior', 'Knight', 'Paladin', 'Assassin', 'Necromancer', 'Mystic', 'Trickster', 'Sorcerer', 'Huntress', 'Ninja'];

// Circle-collision radius factor for projectile vs entity hit detection.
// radius = sprite_size * BULLET_HIT_RADIUS_FACTOR. Mirrors GlobalConstants.HIT_RADIUS_FACTOR
// in the Java server — keep these two values in sync or hits will desync.
export const BULLET_HIT_RADIUS_FACTOR = 0.4;

// Default user settings — applied on first run and merged over any stored
// settings when the game loads. Most of these are stubbed for now (stored but
// not yet wired to gameplay); see the in-game options menu for details.
export const DEFAULT_SETTINGS = {
    graphics: {
        hideOtherPlayerBullets: false,  // Wired: renderer.js bullet loop
        showDamageNumbers: true,        // Stub
        showPlayerNames: true,          // Stub
        renderQuality: 'high',          // Stub
        maxBulletsOnScreen: 0,          // Stub (0 = unlimited)
        showTransitionScreen: true
    },
    controls: {
        // Empty overrides = use hardcoded defaults. Movement keys are wired
        // for real; other actions are stored but ignored by the game loop.
        bindings: {
            moveUp: 'KeyW',
            moveDown: 'KeyS',
            moveLeft: 'KeyA',
            moveRight: 'KeyD',
            shoot: 'Mouse0',
            ability: 'Mouse2',
            chat: 'Enter',
            autofire: 'KeyI',
            inventory: 'KeyR',
            menu: 'Escape',
            hpPotion: 'KeyZ',
            mpPotion: 'KeyX',
            rotateLeft: 'KeyQ',
            rotateRight: 'KeyE',
            resetCamera: 'KeyC',
            lootPickup: 'KeyF'
        }
    },
    mobile: {
        joystickSensitivity: 1.0,   // Stub
        leftHanded: false,          // Stub
        haptic: false               // Stub
    },
    audio: {
        master: 1.0,                // Stub (no audio engine yet)
        sfx: 1.0,                   // Stub
        music: 0.7                  // Stub
    }
};

// Deep-merge helper — preserves stored values while picking up new default
// keys added in future releases (backwards-compatible settings migration).
function mergeSettings(defaults, stored) {
    if (!stored || typeof stored !== 'object') return JSON.parse(JSON.stringify(defaults));
    const result = {};
    for (const key in defaults) {
        if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
            result[key] = mergeSettings(defaults[key], stored[key]);
        } else {
            result[key] = (key in stored) ? stored[key] : defaults[key];
        }
    }
    return result;
}

export function loadSettings() {
    try {
        const raw = localStorage.getItem('or_settings');
        if (!raw) return mergeSettings(DEFAULT_SETTINGS, null);
        return mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (e) {
        return mergeSettings(DEFAULT_SETTINGS, null);
    }
}

export function saveSettings(settings) {
    try {
        localStorage.setItem('or_settings', JSON.stringify(settings));
    } catch (e) {
        // localStorage unavailable (private mode / quota) — silently ignore
    }
}

export class GameState {
    constructor() {
        this.playerId = null;
        this.playerName = '';
        this.classId = 0;

        // User settings (loaded from localStorage, edited via options menu).
        // Guaranteed to be populated with the default schema on every construct
        // so code can read e.g. this.settings.graphics.hideOtherPlayerBullets
        // without null checks.
        this.settings = loadSettings();

        // Entities keyed by ID (BigInt)
        this.players = new Map();
        this.enemies = new Map();
        this.bullets = new Map();
        this.lootContainers = new Map();
        this.portals = new Map();

        // Map data
        this.mapTiles = null;
        this.mapWidth = 0;
        this.mapHeight = 0;
        this.mapId = 0;
        this.realmId = null;
        this.tileSize = 32;

        // Player stats
        this.stats = null;
        this.health = 0;
        this.maxHealth = 0;
        this.mana = 0;
        this.maxMana = 0;
        this.experience = 0;
        this.inventory = [];
        this.effectIds = [];
        this.effectTimes = [];

        // Consumable potion storage
        this.hpPotions = 0;
        this.mpPotions = 0;

        // Cosmetic dye id for the local player (0 = no dye). Renderer reads
        // this in renderPlayer so a dye applies instantly on the dyer's
        // screen, before the UpdatePacket round-trip.
        this.dyeId = 0;

        // Realm transition screen state
        this.transitionActive = false;
        this.transitionStartTime = 0;
        this.transitionZoneName = '';
        this.transitionDifficulty = 0;
        this.transitionClassId = 0;

        // Camera
        this.cameraX = 0;
        this.cameraY = 0;
        this.cameraAngle = 0; // radians, 0 = north-up. Persists across realm transitions and death.

        // Realm transition
        this.awaitingRealmTransition = false;

        // Minimap global player positions (1 Hz from server)
        this.minimapPlayers = [];

        // Current zone/realm difficulty (from LoadPacket)
        this.difficulty = 0;

        // Chat
        this.chatMessages = [];

        // Trading
        this.isTrading = false;
        this.tradePartnerName = '';
        this.tradePartnerInv = null; // Partner's full inventory from AcceptTradePacket
        this.myTradeSelected = null; // Boolean[8] for our inventory slots 4-11
        this.tradeSelection = null;  // NetTradeSelection from server
        this.tradeConfirmed = false;

        // Shooting animation state: set to attack anim name while firing, null otherwise
        this.shootingAnim = null;
        this.shootingAnimTimer = 0;
        this.attackFrame = 0;
        this.attackFrameTimer = 0;

        // Floating damage text
        this.damageTexts = []; // {text, x, y, color, life}

        // Visual particle effects from CreateEffectPacket
        this.visualEffects = []; // {type, x, y, radius, duration, targetX, targetY, startTime}

        // Game data definitions (loaded from HTTP)
        this.tileData = {};
        this.enemyData = {};
        this.itemData = {};
        this.characterClasses = {};
        this.portalData = {};
        this.projectileGroups = {};
        this.expLevels = null;
    }

    getLocalPlayer() {
        return this.players.get(this.playerId);
    }

    // Full reset for death/disconnect/character switch
    fullReset() {
        this.playerId = null;
        this.playerName = '';
        this.classId = 0;
        this.players.clear();
        this.enemies.clear();
        this.bullets.clear();
        this.lootContainers.clear();
        this.portals.clear();
        this.mapTiles = null;
        this.mapWidth = 0;
        this.mapHeight = 0;
        this.mapId = 0;
        this.realmId = null;
        this.stats = null;
        this.health = 0;
        this.maxHealth = 0;
        this.mana = 0;
        this.maxMana = 0;
        this.experience = 0;
        this.inventory = [];
        this.effectIds = [];
        this.effectTimes = [];
        this.cameraX = 0;
        this.cameraY = 0;
        this.awaitingRealmTransition = false;
        this.minimapPlayers = [];
        this.chatMessages = [];
        this.isTrading = false;
        this.tradePartnerName = '';
        this.tradePartnerInv = null;
        this.myTradeSelected = null;
        this.tradeSelection = null;
        this.tradeConfirmed = false;
        this.damageTexts = [];
        this.visualEffects = [];
        // Clear internal caches
        this._firstInvLog = false;
        this._parsedExpMap = null;
        this._maxExpLevel = 1;
        this._maxExperience = 0;
    }

    // Clear state for realm transition (matches Java Realm.loadMap)
    prepareRealmTransition() {
        this.bullets.clear();
        this.enemies.clear();
        this.lootContainers.clear();
        this.portals.clear();
        // Keep players (local player persists across realms)
        // Clear map - will be filled by incoming LoadMapPacket
        this.mapTiles = null;
        this.mapWidth = 0;
        this.mapHeight = 0;
        // Capture transition info for loading screen
        this.transitionClassId = this.classId || 0;
        this.transitionActive = true;
        this.transitionStartTime = Date.now();
        this.transitionZoneName = '';
        this.transitionDifficulty = 0;
        this.awaitingRealmTransition = true;
    }

    // Expire effects locally using effectTimes, matching server's removeExpiredEffects().
    // Must be called every frame so client and server agree on when effects end.
    removeExpiredEffects() {
        const now = Date.now();
        for (let i = 0; i < this.effectIds.length; i++) {
            if (this.effectIds[i] !== -1 && this.effectTimes[i] !== -1) {
                if (now > this.effectTimes[i]) {
                    this.effectIds[i] = -1;
                    this.effectTimes[i] = -1;
                }
            }
        }
    }

    // Check if a specific effect is currently active
    hasEffect(effectId) {
        return this.effectIds.some(id => id === effectId);
    }

    // Simulate one 64Hz tick of movement for an entity with the given (vx, vy)
    // unit vector. MUST produce identical results to the server's movePlayer()
    // / applyMovementTick(). Both: speed = tilesPerSec * 32 / 64; client and
    // server clamp |v| ≤ 1 then apply spd to each component (so a 45° diagonal
    // gets the natural √2/2 reduction from the unit vector itself — no separate
    // diagonal scaling like the dirFlags era needed).
    simulateTick(entity, vx, vy) {
        // PARALYZED: server returns early, zero movement, no collision checks.
        if (this.hasEffect(StatusEffect.PARALYZED)) return;

        // Defensively clamp magnitude to 1 (matches server)
        const mag = Math.sqrt(vx * vx + vy * vy);
        if (mag < 0.001) return; // not moving
        if (mag > 1.0) { vx /= mag; vy /= mag; }

        const computed = this.getComputedStats();
        const spdStat = computed ? computed.spd : 10;
        let tilesPerSec = 4.0 + 5.6 * (spdStat / 75.0);
        if (this.hasEffect(StatusEffect.SPEEDY)) tilesPerSec *= 1.5;
        if (this.hasEffect(StatusEffect.SLOWED)) tilesPerSec *= 0.5;
        const spd = tilesPerSec * 32.0 / 64.0;

        let dx = vx * spd;
        let dy = vy * spd;

        // Update entity velocity so the renderer's animation picker (which
        // chooses walk_front/walk_back/walk_side from sign(dx)/sign(dy)) reacts
        // immediately rather than waiting for the next server LoadPacket.
        entity.dx = dx;
        entity.dy = dy;

        if (dx === 0 && dy === 0) return;

        const slow = this._isOnSlowTile(entity) ? 3.0 : 1.0;
        const effDx = dx / slow;
        const effDy = dy / slow;

        const origX = entity.pos.x;
        const origY = entity.pos.y;

        let xBlocked = this._checkCollision(entity, effDx, 0);
        let yBlocked = this._checkCollision(entity, 0, effDy);

        // Diagonal corner cutting prevention (matches server exactly)
        if (!xBlocked && !yBlocked && effDx !== 0 && effDy !== 0) {
            if (this._checkCollision(entity, effDx, effDy)) {
                if (Math.abs(effDx) >= Math.abs(effDy)) yBlocked = true;
                else xBlocked = true;
            }
        }

        if (!xBlocked) entity.pos.x = origX + effDx;
        if (!yBlocked) entity.pos.y = origY + effDy;
    }

    // Computed stats = base stats + equipment bonuses + enchantment bonuses
    // (slots 0-3). Matches Java Player.getComputedStats().
    getComputedStats() {
        if (!this.stats) return null;
        const s = { ...this.stats };
        for (let i = 0; i < 4; i++) {
            const item = this.inventory[i];
            if (item && item.itemId >= 0 && item.stats) {
                s.hp += item.stats.hp || 0;
                s.mp += item.stats.mp || 0;
                s.def += item.stats.def || 0;
                s.att += item.stats.att || 0;
                s.spd += item.stats.spd || 0;
                s.dex += item.stats.dex || 0;
                s.vit += item.stats.vit || 0;
                s.wis += item.stats.wis || 0;
            }
            // Pixel-forge enchantments: +deltaValue per enchantment, keyed by statId
            if (item && item.enchantments && item.enchantments.length > 0) {
                for (const e of item.enchantments) {
                    const d = e.deltaValue || 0;
                    switch (e.statId) {
                        case 0: s.vit += d; break;
                        case 1: s.wis += d; break;
                        case 2: s.hp += d; break;
                        case 3: s.mp += d; break;
                        case 4: s.att += d; break;
                        case 5: s.def += d; break;
                        case 6: s.spd += d; break;
                        case 7: s.dex += d; break;
                    }
                }
            }
        }
        return s;
    }

    // Get item definition with all sprite/stat info
    getItemDef(itemId) {
        return this.itemData[itemId] || null;
    }

    // Build tooltip text for an item
    getItemTooltip(item) {
        if (!item || item.itemId < 0) return null;
        const def = this.getItemDef(item.itemId) || {};
        const lines = [];
        lines.push(item.name || def.name || 'Unknown Item');
        if (item.description || def.description) lines.push(item.description || def.description);
        if (item.tier >= 0) lines.push(`Tier ${item.tier}`);
        if (item.damage && (item.damage.min > 0 || item.damage.max > 0)) {
            lines.push(`Damage: ${item.damage.min}-${item.damage.max}`);
        }
        const s = item.stats;
        if (s) {
            const statNames = ['HP','MP','DEF','ATT','SPD','DEX','VIT','WIS'];
            const vals = [s.hp, s.mp, s.def, s.att, s.spd, s.dex, s.vit, s.wis];
            const bonuses = vals.map((v, i) => v !== 0 ? `${v > 0 ? '+' : ''}${v} ${statNames[i]}` : null).filter(Boolean);
            if (bonuses.length) lines.push(bonuses.join(', '));
        }
        // Forged enchantments — group by stat, sum deltas. Five +1 DEX
        // enchantments show as "+5 DEX" instead of five separate lines.
        if (item.enchantments && item.enchantments.length > 0) {
            const statLabel = ['VIT','WIS','HP','MP','ATT','DEF','SPD','DEX'];
            lines.push(`Forged (${item.enchantments.length}/5):`);
            const totals = new Map();
            for (const e of item.enchantments) {
                totals.set(e.statId, (totals.get(e.statId) || 0) + (e.deltaValue || 1));
            }
            for (const [statId, sum] of totals) {
                lines.push(`  +${sum} ${statLabel[statId] || '?'}`);
            }
        }
        if (item.stackable && (item.stackCount || 1) > 1) {
            lines.push(`Stack: ×${item.stackCount}/${item.maxStack}`);
        }
        if (item.consumable) lines.push('Consumable');
        const cls = item.targetClass;
        if (cls >= 0 && cls < CLASS_NAMES.length) lines.push(`Class: ${CLASS_NAMES[cls]}`);
        return lines.join('\n');
    }

    /** Rich HTML tooltip used by the custom hover popup (see main.js
     *  showItemTooltip). Mirrors getItemTooltip's content but with semantic
     *  classes so the existing OryxSimplex / palette styles can theme it. */
    getItemTooltipHTML(item) {
        if (!item || item.itemId < 0) return null;
        const def = this.getItemDef(item.itemId) || {};
        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
            {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const parts = [];
        const name = item.name || def.name || 'Unknown Item';
        const tierClass = item.tier >= 0 ? `it-name-tier-${Math.min(item.tier, 5)}` : '';
        parts.push(`<div class="it-name ${tierClass}">${esc(name)}</div>`);
        const subtitleBits = [];
        if (item.tier >= 0) subtitleBits.push(`Tier ${item.tier}`);
        const cls = item.targetClass;
        if (cls >= 0 && cls < CLASS_NAMES.length) subtitleBits.push(CLASS_NAMES[cls]);
        if (item.consumable) subtitleBits.push('Consumable');
        if (subtitleBits.length) {
            parts.push(`<div class="it-subtitle">${subtitleBits.map(esc).join(' · ')}</div>`);
        }
        const desc = item.description || def.description;
        if (desc) parts.push(`<div class="it-desc">${esc(desc)}</div>`);
        if (item.damage && (item.damage.min > 0 || item.damage.max > 0)) {
            parts.push(`<div class="it-damage">Damage: <span class="it-damage-val">${item.damage.min}–${item.damage.max}</span></div>`);
        }
        const s = item.stats;
        if (s) {
            const statNames = ['HP','MP','DEF','ATT','SPD','DEX','VIT','WIS'];
            const vals = [s.hp, s.mp, s.def, s.att, s.spd, s.dex, s.vit, s.wis];
            const cells = [];
            for (let i = 0; i < statNames.length; i++) {
                const v = vals[i];
                if (!v) continue;
                const sign = v > 0 ? '+' : '';
                const cls2 = v > 0 ? 'it-stat-pos' : 'it-stat-neg';
                cells.push(`<span class="it-stat"><span class="it-stat-label">${statNames[i]}</span><span class="${cls2}">${sign}${v}</span></span>`);
            }
            if (cells.length) parts.push(`<div class="it-stats">${cells.join('')}</div>`);
        }
        if (item.enchantments && item.enchantments.length > 0) {
            const statLabel = ['VIT','WIS','HP','MP','ATT','DEF','SPD','DEX'];
            // Group by statId so 5 +1 DEX shows as one "+5 DEX" pip.
            const totals = new Map();
            for (const e of item.enchantments) {
                totals.set(e.statId, (totals.get(e.statId) || 0) + (e.deltaValue || 1));
            }
            const rows = Array.from(totals, ([statId, sum]) =>
                `<span class="it-ench-pip">+${sum} ${esc(statLabel[statId] || '?')}</span>`
            ).join('');
            parts.push(
                `<div class="it-ench"><div class="it-ench-header">Forged (${item.enchantments.length}/5)</div>` +
                `<div class="it-ench-list">${rows}</div></div>`);
        }
        if (item.stackable && (item.stackCount || 1) > 1) {
            parts.push(`<div class="it-stack">Stack ×${item.stackCount}<span class="it-stack-max">/${item.maxStack}</span></div>`);
        }
        return parts.join('');
    }

    handleLoadMap(packet) {
        const sameMap = this.mapTiles && this.realmId === packet.realmId && this.mapId === packet.mapId;
        this.realmId = packet.realmId;
        this.mapId = packet.mapId;
        this.mapWidth = packet.mapWidth;
        this.mapHeight = packet.mapHeight;

        if (!sameMap) {
            this.mapTiles = [];
            for (let r = 0; r < this.mapHeight; r++) {
                this.mapTiles[r] = [];
                for (let c = 0; c < this.mapWidth; c++) {
                    this.mapTiles[r][c] = { base: -1, collision: -1 };
                }
            }
        }

        let baseCount = 0, collCount = 0, outOfBounds = 0;
        for (const tile of packet.tiles) {
            // Server swaps x/y: new NetTile(id, layer, y, x) → xIndex=row, yIndex=col
            const r = tile.xIndex;
            const c = tile.yIndex;
            if (r >= 0 && r < this.mapHeight && c >= 0 && c < this.mapWidth) {
                if (tile.layer === 0) { this.mapTiles[r][c].base = tile.tileId; baseCount++; }
                else { this.mapTiles[r][c].collision = tile.tileId; collCount++; }
            } else { outOfBounds++; }
        }
        if (baseCount > 0 || collCount > 0 || outOfBounds > 0) {
            // Map load log removed for performance
        }
    }

    handleLoad(packet) {
        for (const p of packet.players) {
            if (p.id === this.playerId) {
                // Local player: update metadata only. Position is fully client-predicted.
                // Do NOT set targetX/targetY — it causes snapping on slow connections.
                const existing = this.players.get(p.id);
                if (existing) {
                    existing.classId = p.classId;
                    existing.name = p.name;
                    existing.chatRole = p.chatRole;
                    existing.size = p.size || 28;
                    existing.dyeId = p.dyeId || 0;
                    continue;
                }
            }
            // The server now sends the full player set every tick (so a
            // dropped packet self-heals next tick). When we already track
            // this player, refresh their authoritative fields in place so we
            // don't reset their animation/interpolation state every tick.
            const existing = this.players.get(p.id);
            if (existing) {
                existing.classId = p.classId;
                existing.name = p.name;
                existing.chatRole = p.chatRole;
                existing.size = p.size || existing.size || 28;
                existing.dyeId = p.dyeId || 0;
                // Position interpolation: only update target if the server's
                // position diverges from our last snapshot — otherwise we'd
                // re-snap every tick.
                const dxErr = (p.pos.x - existing._snapX) * (p.pos.x - existing._snapX);
                const dyErr = (p.pos.y - existing._snapY) * (p.pos.y - existing._snapY);
                if (dxErr + dyErr > 0.5) {
                    existing._prevX = existing.targetX != null ? existing.targetX : existing._snapX;
                    existing._prevY = existing.targetY != null ? existing.targetY : existing._snapY;
                    existing.targetX = p.pos.x; existing.targetY = p.pos.y;
                    existing._snapX = p.pos.x; existing._snapY = p.pos.y;
                    existing._snapTime = performance.now();
                }
                existing.dx = p.dX; existing.dy = p.dY;
                existing._lastVelUpdate = performance.now();
                continue;
            }
            this.players.set(p.id, {
                ...p, dx: p.dX, dy: p.dY,
                targetX: p.pos.x, targetY: p.pos.y,
                _prevX: p.pos.x, _prevY: p.pos.y,
                _snapX: p.pos.x, _snapY: p.pos.y,
                _snapTime: performance.now(),
                _lastVelUpdate: performance.now(),
                animFrame: 0, animTimer: 0, facing: 'right'
            });
        }
        for (const e of packet.enemies) {
            // Preserve effectIds from PlayerStatePacket (LoadPacket overwrites otherwise)
            const existing = this.enemies.get(e.id);
            // Server health is authoritative — use it if provided, overriding predictions.
            // Only keep predicted health if server sent 0 (meaning it hasn't changed).
            const serverHealth = e.health;
            const useHealth = (serverHealth > 0) ? serverHealth : (existing?.health ?? serverHealth);
            // Server now re-broadcasts the full enemy set every tick. For
            // already-tracked enemies, refresh authoritative fields in place
            // WITHOUT touching existing.pos — the per-frame interpolator
            // (movement loop above) walks pos toward targetX/Y smoothly.
            // Object.assign would overwrite pos with the latest snapshot
            // every tick and the enemy would visibly teleport.
            if (existing) {
                existing.enemyId = e.enemyId;
                existing.weaponId = e.weaponId;
                existing.size = e.size || existing.size;
                existing.shortId = e.shortId;
                existing.difficulty = e.difficulty;
                existing.maxHealth = e.maxHealth;
                existing.dx = e.dX; existing.dy = e.dY;
                existing.health = useHealth;
                // Refresh velocity timestamp + record the authoritative
                // server position. The extrapolation cap in
                // updateInterpolation() uses _lastVelUpdate to detect a
                // stale entity and snaps pos back to _serverPosX/Y so an
                // enemy that drifted off-screen during the silent window
                // is yanked back to its last on-map position instead of
                // freezing in the void.
                existing._lastVelUpdate = performance.now();
                existing._serverPosX = e.pos.x;
                existing._serverPosY = e.pos.y;
                // Update interpolation target only when the server position
                // actually changed. Tiny floats (sub-pixel) are no-ops to
                // avoid resetting _snapTime on every tick which would also
                // visibly stutter motion.
                const dxErr = (e.pos.x - existing.targetX) * (e.pos.x - existing.targetX);
                const dyErr = (e.pos.y - existing.targetY) * (e.pos.y - existing.targetY);
                if (dxErr + dyErr > 0.25) {
                    existing.targetX = e.pos.x;
                    existing.targetY = e.pos.y;
                }
                continue;
            }
            this.enemies.set(e.id, {
                ...e, dx: e.dX, dy: e.dY,
                targetX: e.pos.x, targetY: e.pos.y,
                _prevX: e.pos.x, _prevY: e.pos.y,
                _snapX: e.pos.x, _snapY: e.pos.y,
                _snapTime: performance.now(),
                _lastVelUpdate: performance.now(),
                _serverPosX: e.pos.x, _serverPosY: e.pos.y,
                animFrame: 0, animTimer: 0,
                effectIds: [],
                health: useHealth,
            });
        }
        // Predicted bullets (negative IDs) are never bulk-deleted. They expire
        // naturally via range/lifetime. When the server sends the "real" version of
        // our own bullet, we skip it — the predicted copy is already rendering and
        // doing hit detection with zero latency. This eliminates visual gaps under
        // high latency where the old approach deleted all predictions on every
        // LoadPacket, even for shots the server hadn't confirmed yet.
        for (const b of packet.bullets) {
            // If we already track this exact bullet (by server ID), just refresh
            // authoritative fields without snapping position (deterministic physics).
            const existing = this.bullets.get(b.id);
            if (existing) {
                const dxErr = existing.pos.x - b.pos.x;
                const dyErr = existing.pos.y - b.pos.y;
                const errSq = dxErr * dxErr + dyErr * dyErr;
                if (errSq < 128 * 128) {
                    existing.range = b.range;
                    existing.damage = b.damage;
                    existing.flags = b.flags;
                    continue;
                }
            }

            // Skip server-sent copies of our OWN bullets — the predicted version
            // is already in flight with the correct trajectory. Matching by
            // PLAYER_PROJECTILE flag + position proximity to a predicted bullet.
            const isPlayerBullet = b.flags && b.flags.includes(ProjectileFlag.PLAYER_PROJECTILE);
            if (isPlayerBullet) {
                let hasPrediction = false;
                for (const [pid, pb] of this.bullets) {
                    if (pid >= 0 || !pb._predicted) continue;
                    if (pb.projectileId !== b.projectileId) continue;
                    // Same weapon type, check angle match (within ~5 degrees)
                    const angleDiff = Math.abs(pb.angle - b.angle);
                    if (angleDiff < 0.09 || angleDiff > Math.PI * 2 - 0.09) {
                        hasPrediction = true;
                        break;
                    }
                }
                if (hasPrediction) continue;
            }

            const bullet = {
                ...b, dx: b.dX, dy: b.dY,
                targetX: b.pos.x, targetY: b.pos.y,
                _clientCreatedTime: Date.now()
            };
            // Fast-forward STRAIGHT bullets to approximate current server position.
            const oneWayMs = (this._lastPingMs || 0) / 2;
            const catchupSec = Math.min(oneWayMs / 1000, 0.25);
            const catchupScale = catchupSec * 64;
            const isOrb = b.flags && b.flags.includes(ProjectileFlag.ORBITAL);
            const isParametric = (b.amplitude || 0) !== 0 && (b.frequency || 0) !== 0;
            if (catchupScale > 0.5 && b.magnitude > 0 && !isOrb && !isParametric) {
                bullet.pos = { ...bullet.pos };
                bullet.pos.x += Math.sin(b.angle) * b.magnitude * catchupScale;
                bullet.pos.y += Math.cos(b.angle) * b.magnitude * catchupScale;
                bullet._traveled = b.magnitude * catchupScale;
                bullet._clientCreatedTime = Date.now() - oneWayMs;
            }
            this.bullets.set(b.id, bullet);
        }
        for (const c of packet.containers) {
            // Always replace - server sends updated container with new items
            this.lootContainers.set(c.lootContainerId, c);
        }
        for (const p of packet.portals) {
            this.portals.set(p.id, p);
        }
        if (packet.difficulty !== undefined) {
            this.difficulty = packet.difficulty;
        }
    }

    handleUnload(packet) {
        for (const id of packet.players) this.players.delete(id);
        for (const id of packet.bullets) this.bullets.delete(id);
        for (const id of packet.enemies) this.enemies.delete(id);
        for (const id of packet.containers) this.lootContainers.delete(id);
        for (const id of packet.portals) this.portals.delete(id);
    }

    // Server reconciliation with sequence-numbered inputs.
    // The server ack contains the last client input seq it processed + its authoritative position.
    // We discard all inputs up to that seq (exact match, no tick/frame conversion),
    // then replay remaining inputs from the server position using simulateTick().
    // Because both client and server run identical physics at exactly 64Hz,
    // the replay produces the same result as the client's prediction — zero error
    // unless there's a genuine collision mismatch.
    handlePosAck(data) {
        const local = this.getLocalPlayer();
        if (!local) return;

        if (!this._pendingInputs) this._pendingInputs = [];

        // 1. Discard all inputs the server has confirmed (seq <= ack.seq)
        while (this._pendingInputs.length > 0 && this._pendingInputs[0].seq <= data.seq) {
            this._pendingInputs.shift();
        }

        // 2. Save current client position
        const savedX = local.pos.x;
        const savedY = local.pos.y;

        // 3. Start from server's authoritative position
        local.pos.x = data.posX;
        local.pos.y = data.posY;

        // 4. Replay all unacknowledged inputs using the same simulateTick()
        for (const inp of this._pendingInputs) {
            this.simulateTick(local, inp.vx, inp.vy);
        }

        // 5. Compare replayed position with where client currently is
        const replayX = local.pos.x;
        const replayY = local.pos.y;
        const errX = replayX - savedX;
        const errY = replayY - savedY;
        const err = Math.sqrt(errX * errX + errY * errY);

        // Debug: log significant corrections (remove after debugging)
        if (err > 2.0) {
            console.log(`[RECONCILE] err=${err.toFixed(2)}px pending=${this._pendingInputs.length} ackSeq=${data.seq} server=(${data.posX.toFixed(1)},${data.posY.toFixed(1)}) saved=(${savedX.toFixed(1)},${savedY.toFixed(1)}) replay=(${replayX.toFixed(1)},${replayY.toFixed(1)})`);
        }

        if (err > 64) {
            // Teleport / realm transition — hard snap, clear smoothing
            local.pos.x = replayX;
            local.pos.y = replayY;
            local._smoothX = 0;
            local._smoothY = 0;
        } else if (err > 2.0) {
            // Mismatch detected (wall collision, slow tile edge case).
            // Snap logical position to replay result immediately (accurate collisions).
            // Absorb the visual difference into a smoothing offset that decays fast.
            local._smoothX = (local._smoothX || 0) + (savedX - replayX);
            local._smoothY = (local._smoothY || 0) + (savedY - replayY);
            // Cap smoothing offset to prevent accumulation
            const mag = Math.sqrt(local._smoothX * local._smoothX + local._smoothY * local._smoothY);
            if (mag > 6) {
                local._smoothX *= 6 / mag;
                local._smoothY *= 6 / mag;
            }
            local.pos.x = replayX;
            local.pos.y = replayY;
        } else {
            // Under 0.5px: client and server agree. This should be the normal case
            // at any ping because both run identical physics at the same tick rate.
            local.pos.x = savedX;
            local.pos.y = savedY;
        }
    }

    handleObjectMove(packet) {
        for (const mov of packet.movements) {
            const t = mov.entityType, id = mov.entityId;
            if (t === 0) {
                const p = this.players.get(id);
                if (p) {
                    if (id === this.playerId) {
                        // Local player only receives ObjectMovePacket on teleport
                        // (server skips local player for normal movement).
                        // Normal reconciliation handled by PlayerPosAckPacket.
                        if (this.awaitingRealmTransition) {
                            p.pos.x = mov.posX; p.pos.y = mov.posY;
                            p.targetX = mov.posX; p.targetY = mov.posY;
                            this.cameraX = mov.posX; this.cameraY = mov.posY;
                            this.awaitingRealmTransition = false;
                            this._inputBuffer = [];
                        } else {
                            // Teleport (planewalker etc) — snap + clear input buffer
                            p.pos.x = mov.posX; p.pos.y = mov.posY;
                            p.targetX = mov.posX; p.targetY = mov.posY;
                            this._inputBuffer = [];
                        }
                    } else {
                        p.targetX = mov.posX; p.targetY = mov.posY;
                    }
                    if (id !== this.playerId) {
                        p.dx = mov.velX; p.dy = mov.velY;
                        p._lastVelUpdate = performance.now();
                        // Apply attack animation state from server
                        if (mov.attacking) {
                            p.attacking = true;
                            p.attackUntil = performance.now() + 350;
                        }
                    }
                }
            } else if (t === 1) {
                const e = this.enemies.get(id);
                if (e) {
                    e.targetX = mov.posX; e.targetY = mov.posY;
                    e.dx = mov.velX; e.dy = mov.velY;
                    // Refresh extrapolation timestamp + last known server
                    // position — see LoadPacket handler.
                    e._lastVelUpdate = performance.now();
                    e._serverPosX = mov.posX;
                    e._serverPosY = mov.posY;
                }
            } else if (t === 2) {
                const b = this.bullets.get(id);
                if (b) { b.targetX = mov.posX; b.targetY = mov.posY; b.dx = mov.velX; b.dy = mov.velY; }
            }
        }
    }

    handleUpdate(packet) {
        const isLocal = packet.playerId === this.playerId;
        if (isLocal) {
            this.stats = packet.stats;
            this.health = packet.health;
            this.maxHealth = packet.stats.hp;
            this.mana = packet.mana;
            this.maxMana = packet.stats.mp;
            this.experience = packet.experience;
            if (!this._firstInvLog) {
                this._firstInvLog = true;
                const ids = packet.inventory ? packet.inventory.map(i => i ? i.itemId : 'null') : [];
                console.log(`[INV] First UpdatePacket inventory: len=${packet.inventory?.length}, ids=[${ids.join(',')}]`);
            }
            this.inventory = packet.inventory;
            if (packet.hpPotions !== undefined) this.hpPotions = packet.hpPotions;
            if (packet.mpPotions !== undefined) this.mpPotions = packet.mpPotions;
            if (packet.dyeId !== undefined) this.dyeId = packet.dyeId;
            this.playerName = packet.playerName;
        }
        const player = this.players.get(packet.playerId);
        if (player) {
            player.name = packet.playerName;
            player.health = packet.health;
            player.maxHealth = packet.stats.hp;
            player.mana = packet.mana;
            player.maxMana = packet.stats.mp;
            player.stats = packet.stats;
            // Cosmetic dye: UpdatePacket carries dyeId so it propagates the
            // moment a dye is consumed (LoadPacket diff only re-sends new
            // players, so dye changes wouldn't otherwise reach the renderer
            // until the player un/re-loaded).
            if (packet.dyeId !== undefined) player.dyeId = packet.dyeId;
        }
        const enemy = this.enemies.get(packet.playerId);
        if (enemy) {
            enemy.health = packet.health;
        }
    }

    handlePlayerState(packet) {
        const isLocal = packet.playerId === this.playerId;
        if (isLocal) {
            this.health = packet.health;
            this.mana = packet.mana;
            this.effectIds = packet.effectIds;
            this.effectTimes = packet.effectTimes;
            // DEBUG: log when effects change
            const activeEffects = packet.effectIds.filter(id => id >= 0);
            if (activeEffects.length > 0) {
                console.log(`[EFFECT] Self effects received:`, activeEffects, `at`, performance.now().toFixed(0));
            }
        }
        const player = this.players.get(packet.playerId);
        if (player) {
            player.health = packet.health;
            player.mana = packet.mana;
            player.effectIds = packet.effectIds;
        }
        const enemy = this.enemies.get(packet.playerId);
        if (enemy) {
            enemy.health = packet.health;
            enemy.effectIds = packet.effectIds;
        }
    }

    handleText(packet) {
        this.chatMessages.push({ from: packet.from, to: packet.to, message: packet.message, time: Date.now() });
        if (this.chatMessages.length > 50) this.chatMessages.shift();
    }

    handleTextEffect(packet) {
        // Find target entity position for floating text
        let x = 0, y = 0;
        const entityType = packet.entityType;
        const targetId = packet.targetEntityId;
        if (entityType === 0) {
            const p = this.players.get(targetId);
            if (p) { x = p.pos.x; y = p.pos.y; }
        } else if (entityType === 1) {
            const e = this.enemies.get(targetId);
            if (e) { x = e.pos.x; y = e.pos.y; }
        } else if (entityType === 2) {
            const b = this.bullets.get(targetId);
            if (b) { x = b.pos.x; y = b.pos.y; }
        }
        // Color by text effect type: 0=damage(red), 1=heal(green), 2=armor_pierce(cyan-purple), 3=env(blue), 4=info(orange)
        const colors = [0xff4040, 0x40ff40, 0x60a0ff, 0x4080ff, 0xff8040];
        const color = colors[packet.textEffectId] || 0xffffff;

        const TEXT_LIFE = 50; // ~0.8s at 60fps — clears fast to prevent clutter
        const STACK_OFFSET = 8.0; // world units per stacked text — tight but readable

        // Merge: if same damage text exists near this position and is very fresh,
        // combine into a single text showing total (e.g., 8 wizard shots → one big number)
        for (let i = this.damageTexts.length - 1; i >= 0; i--) {
            const dt = this.damageTexts[i];
            const dx = dt.x - x;
            const dy = dt.y - y;
            const near = Math.abs(dx) < 24 && Math.abs(dy) < 24;
            // Replace predicted texts with server text
            if (near && dt._predicted && dt.life > TEXT_LIFE * 0.3) {
                this.damageTexts.splice(i, 1);
                break;
            }
            // Merge same-value damage texts that arrived within ~100ms (6 frames)
            if (near && dt.text === packet.text && dt.color === color && dt.life > TEXT_LIFE - 6) {
                // Bump the count and refresh lifetime
                dt._count = (dt._count || 1) + 1;
                dt.text = packet.text + ' x' + dt._count;
                dt.life = TEXT_LIFE;
                return; // don't add a new entry
            }
        }

        // Offset stacking: count active texts near this position to avoid overlap
        let stackCount = 0;
        for (const dt of this.damageTexts) {
            const dx = dt.x - x;
            if (Math.abs(dx) < 20 && dt.life > TEXT_LIFE * 0.4) stackCount++;
        }
        // Cap stack height to prevent huge towers
        const maxStack = 4;
        const offset = Math.min(stackCount, maxStack) * STACK_OFFSET;
        this.damageTexts.push({ text: packet.text, x, y: y - offset, color, life: TEXT_LIFE, _count: 1 });
    }

    addVisualEffect(effect) {
        this.visualEffects.push(effect);
    }

    // Client-side collision check — must match server's TileManager.collisionTile exactly.
    // Server checks: collision layer tiles in ±5 range, void tiles on base layer,
    // and map boundary limits.
    _checkCollision(entity, dx, dy) {
        if (!this.mapTiles || !this.tileData) return false;
        const ts = this.tileSize || 32;
        const size = entity.size || 28; // matches server PLAYER_SIZE = 28
        const futureX = entity.pos.x + dx;
        const futureY = entity.pos.y + dy;

        // Map boundary (matches server collidesXLimit / collidesYLimit)
        const mapW = this.mapWidth * ts, mapH = this.mapHeight * ts;
        if (futureX <= 0 || futureX + size >= mapW) return true;
        if (futureY <= 0 || futureY + size >= mapH) return true;

        // Collision tile check — 85% hitbox, ±5 tile radius.
        // MUST match server TileManager.collisionTile exactly (also 0.85f).
        const hitSize = Math.floor(size * 0.85);
        const cx = Math.floor(entity.pos.x / ts);
        const cy = Math.floor(entity.pos.y / ts);
        for (let ty = cy - 5; ty <= cy + 5; ty++) {
            for (let tx = cx - 5; tx <= cx + 5; tx++) {
                if (ty < 0 || ty >= this.mapHeight || tx < 0 || tx >= this.mapWidth) continue;
                const tile = this.mapTiles[ty]?.[tx];
                if (!tile || tile.collision <= 0) continue;
                const tileDef = this.tileData[tile.collision];
                if (!tileDef?.data?.hasCollision) continue;
                const tl = tx * ts, tt = ty * ts;
                // AABB: strict >= means touching edges don't collide (matches server Rectangle.intersect)
                if (futureX < tl + ts && futureX + hitSize > tl &&
                    futureY < tt + ts && futureY + hitSize > tt) return true;
            }
        }

        // Void tile check — base layer at center+offset
        // Matches server TileManager.isVoidTile: null tile = safe, tileId==0 = void
        const voidCheckX = Math.floor((entity.pos.x + size / 2 + dx) / ts);
        const voidCheckY = Math.floor((entity.pos.y + size / 2 + dy) / ts);
        if (voidCheckX >= 0 && voidCheckX < this.mapWidth && voidCheckY >= 0 && voidCheckY < this.mapHeight) {
            const baseTile = this.mapTiles[voidCheckY]?.[voidCheckX];
            if (baseTile && baseTile.base === 0) return true; // only void (0) blocks, null = safe
        }
        return false;
    }

    // Check if player is on a slow tile (matches server collidesSlowTile).
    // Simple center-cell lookup — must match the server exactly. Previously used
    // an AABB check with a 14x14 hitbox while the server used 28x28, which caused
    // disagreement near tile boundaries and player position snap/desync.
    _isOnSlowTile(entity) {
        if (!this.mapTiles || !this.tileData) return false;
        const ts = this.tileSize || 32;
        const size = entity.size || 28;
        const cx = Math.floor((entity.pos.x + size / 2) / ts);
        const cy = Math.floor((entity.pos.y + size / 2) / ts);
        if (cx < 0 || cx >= this.mapWidth || cy < 0 || cy >= this.mapHeight) return false;
        const tile = this.mapTiles[cy]?.[cx];
        if (!tile || tile.base <= 0) return false;
        const tileDef = this.tileData[tile.base];
        return !!(tileDef?.data?.slows);
    }

    updateVisualEffects() {
        const now = Date.now();
        for (let i = this.visualEffects.length - 1; i >= 0; i--) {
            if (now - this.visualEffects[i].startTime > this.visualEffects[i].duration) {
                this.visualEffects.splice(i, 1);
            }
        }
    }

    // Trading
    handleRequestTrade(packet) {
        this.chatMessages.push({
            from: 'SYSTEM', to: '', time: Date.now(),
            message: `${packet.requestingPlayerName} has proposed a trade. Type /accept to initiate.`
        });
    }

    handleAcceptTrade(packet) {
        if (packet.accepted) {
            this.isTrading = true;
            const p0 = packet.player0;
            const p1 = packet.player1;
            if (p0 && p1) {
                const iAmPlayer0 = (p0.id === this.playerId);
                this.tradePartnerName = iAmPlayer0 ? p1.name : p0.name;
                // Store partner's full inventory for display
                this.tradePartnerInv = iAmPlayer0 ? packet.player1Inv : packet.player0Inv;
            }
            // Initialize our selection as all false (nothing selected)
            this.myTradeSelected = new Array(8).fill(false); // slots 4-11
            this.tradeConfirmed = false;
        } else {
            this.isTrading = false;
            this.tradePartnerName = '';
            this.tradePartnerInv = null;
            this.tradeSelection = null;
            this.tradeConfirmed = false;
            this.myTradeSelected = null;
        }
    }

    handleUpdateTrade(packet) {
        this.tradeSelection = packet.selections;
    }

    handleGlobalPlayerPosition(packet) {
        this.minimapPlayers = packet.players || [];
    }

    handleUpdateTradeSelection(packet) {
        if (!this.tradeSelection) return;
        const sel = packet.selection;
        // Update the matching player's selection
        if (this.tradeSelection.player0Selection &&
            sel.playerId === this.tradeSelection.player0Selection.playerId) {
            this.tradeSelection.player0Selection = sel;
        } else if (this.tradeSelection.player1Selection) {
            this.tradeSelection.player1Selection = sel;
        }
    }

    getMyTradeSelection() {
        if (!this.tradeSelection) return null;
        if (this.tradeSelection.player0Selection?.playerId === this.playerId)
            return this.tradeSelection.player0Selection;
        return this.tradeSelection.player1Selection;
    }

    getPartnerTradeSelection() {
        if (!this.tradeSelection) return null;
        if (this.tradeSelection.player0Selection?.playerId === this.playerId)
            return this.tradeSelection.player1Selection;
        return this.tradeSelection.player0Selection;
    }

    updateInterpolation(dt) {
        const SNAP_DISTANCE = 96;
        const ENEMY_INTERP_DURATION = 62; // ms — snapshot interpolation window

        for (const [id, p] of this.players) {
            if (id === this.playerId) {
                // LOCAL PLAYER: movement is now handled by the fixed 64Hz simulation
                // in processInput() via simulateTick(). Nothing to do here except
                // decay the visual smoothing offset.
                const dtMs = dt * 1000;
                if (p._smoothX || p._smoothY) {
                    // 50ms half-life: corrections are 87.5% gone within 150ms.
                    // Fast enough for bullet hell, smooth enough to not jerk.
                    const decay = Math.pow(0.5, dtMs / 50.0);
                    p._smoothX = (p._smoothX || 0) * decay;
                    p._smoothY = (p._smoothY || 0) * decay;
                    if (Math.abs(p._smoothX) < 0.1) p._smoothX = 0;
                    if (Math.abs(p._smoothY) < 0.1) p._smoothY = 0;
                }
            } else {
                // OTHER PLAYERS: extrapolate forward using last-known velocity,
                // then lerp toward the latest server target as a correction.
                //
                // The server's dead-reckoning skips ObjectMovePackets for any
                // entity whose actual position+velocity matches what the
                // client would predict. Without client-side velocity
                // extrapolation, the client lerps to the last received
                // target and then FREEZES until the staleness cap (~750ms)
                // forces a server resend — visible as 50ms move / 700ms
                // pause stutter on every walking bot.
                //
                // dx/dy is in px/tick at 64Hz, so per-second = dx * 64.
                // Same extrapolation cap as the enemy block below — stop
                // sliding peers along their last velocity once the server
                // has gone silent for >1200ms.
                if (p.dx !== 0 || p.dy !== 0) {
                    if (p._lastVelUpdate != null && (performance.now() - p._lastVelUpdate) > 1200) {
                        p.dx = 0; p.dy = 0;
                    } else {
                        const tickStep = dt * 64;
                        p.pos.x += p.dx * tickStep;
                        p.pos.y += p.dy * tickStep;
                        p.targetX += p.dx * tickStep;
                        p.targetY += p.dy * tickStep;
                    }
                }
                const odx = p.targetX - p.pos.x, ody = p.targetY - p.pos.y;
                const odist = Math.sqrt(odx * odx + ody * ody);
                if (odist > SNAP_DISTANCE) {
                    p.pos.x = p.targetX; p.pos.y = p.targetY;
                } else if (odist > 0.3) {
                    const speed = odist / 0.05;
                    const step = speed * dt;
                    if (step >= odist) {
                        p.pos.x = p.targetX; p.pos.y = p.targetY;
                    } else {
                        const ratio = step / odist;
                        p.pos.x += odx * ratio;
                        p.pos.y += ody * ratio;
                    }
                }
            }

            if (Math.abs(p.dx) > 0.1) p.facing = p.dx > 0 ? 'right' : 'left';
            p.animTimer = (p.animTimer || 0) + dt;
            // Frame interval scales with current movement speed so a fast
            // peer's walk cycle visibly outpaces a slow one's. Was a fixed
            // 125 ms per frame; now 60 ms (sprinting) → 200 ms (slow walk
            // / standing). Idle entities (dx≈dy≈0) stay on the first frame
            // via the upstream attack/idle anim selection, so this only
            // affects walking players.
            const pace = Math.max(0.1, Math.sqrt(p.dx * p.dx + p.dy * p.dy));
            const frameThreshold = Math.max(0.06, Math.min(0.2, 0.18 / pace));
            if (p.animTimer > frameThreshold) {
                p.animTimer = 0;
                p.animFrame = ((p.animFrame || 0) + 1) % 2;
            }
        }

        // Enemies: extrapolate by velocity, then lerp to correct.
        // Same rationale as the other-players block above: server-side
        // dead-reckoning sends ObjectMovePackets only when an entity's
        // actual position diverges from the velocity-based prediction.
        // The client must continue advancing the entity along its last-
        // known velocity, otherwise enemies stutter between sparse
        // server updates.
        //
        // EXTRAPOLATION CAP: server's MAX_STALE_TICKS is 48 (~750ms), so
        // any entity in the player's viewport gets a velocity refresh
        // within that window. If we haven't seen one in 1200ms, the entity
        // has dropped out of viewport and the server has stopped pushing
        // updates — keep extrapolating and the enemy drifts off the map
        // into the abyss. Zero the velocity once we cross that threshold
        // so the enemy parks at its last known position instead of
        // sliding into the void.
        const EXTRAP_CAP_MS = 1200;
        const nowMs = performance.now();
        for (const [id, e] of this.enemies) {
            if (e.dx !== 0 || e.dy !== 0) {
                if (e._lastVelUpdate != null && (nowMs - e._lastVelUpdate) > EXTRAP_CAP_MS) {
                    // Cap fired — snap back to the last server-known position
                    // so an enemy that drifted off-map during the silent
                    // window doesn't get permanently stranded in the void.
                    e.dx = 0; e.dy = 0;
                    if (e._serverPosX != null) {
                        e.pos.x = e._serverPosX;
                        e.pos.y = e._serverPosY;
                        e.targetX = e._serverPosX;
                        e.targetY = e._serverPosY;
                    }
                } else {
                    const tickStep = dt * 64;
                    e.pos.x += e.dx * tickStep;
                    e.pos.y += e.dy * tickStep;
                    e.targetX += e.dx * tickStep;
                    e.targetY += e.dy * tickStep;
                }
            }
            const dx = e.targetX - e.pos.x, dy = e.targetY - e.pos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > SNAP_DISTANCE) {
                e.pos.x = e.targetX; e.pos.y = e.targetY;
            } else if (dist > 0.3) {
                // Constant-speed correction: cover residual drift in ~50ms.
                const speed = dist / 0.05;
                const step = speed * dt;
                if (step >= dist) {
                    e.pos.x = e.targetX; e.pos.y = e.targetY;
                } else {
                    const ratio = step / dist;
                    e.pos.x += dx * ratio;
                    e.pos.y += dy * ratio;
                }
            }
        }

        // Bullets: fully client-predicted (server doesn't send ObjectMovePacket for bullets).
        // Server applies velocity once per tick at 64 ticks/sec.
        // Scale by dt * 64 to be frame-rate independent.
        const now = Date.now();
        const bulletScale = dt * 64; // 1.0 at 64fps, 1.067 at 60fps, 0.444 at 144fps
        // Viewport threshold: only run local terrain/range/lifetime deletion on
        // bullets within this distance from the player. Off-screen bullets are left
        // to the server (UnloadPacket) to avoid desync — if the client independently
        // deletes a bullet the server still has, the delta LoadPacket won't re-send
        // it, making the bullet permanently invisible.
        const localP = this.getLocalPlayer();
        const vpThresholdSq = 350 * 350; // ~11 tiles — covers all visible screen area
        for (const [id, b] of this.bullets) {
            const amp = b.amplitude || 0;
            const freq = b.frequency || 0;

            const isOrbital = b.flags && b.flags.includes(ProjectileFlag.ORBITAL);

            if (isOrbital) {
                // Orbital projectile — use server-serialized center/radius/phase
                if (b._orbitPhase === undefined) {
                    b._orbitPhase = b.orbitPhase || b.angle;
                    b._orbitRadius = b.orbitRadius || amp || 64;
                    b._orbitCenterX = b.orbitCenterX || (b.pos.x - b._orbitRadius * Math.cos(b._orbitPhase));
                    b._orbitCenterY = b.orbitCenterY || (b.pos.y - b._orbitRadius * Math.sin(b._orbitPhase));
                }
                b._orbitPhase += (freq * bulletScale) * Math.PI / 180;
                b.pos.x = b._orbitCenterX + b._orbitRadius * Math.cos(b._orbitPhase);
                b.pos.y = b._orbitCenterY + b._orbitRadius * Math.sin(b._orbitPhase);
                b._traveled = (b._traveled || 0) + b._orbitRadius * Math.abs((freq * bulletScale) * Math.PI / 180);
            } else if (amp !== 0 && freq !== 0) {
                // Parametric (wavy) projectile
                if (b._timeStep === undefined) b._timeStep = Number(b.timeStep) || 0;
                const prevOffset = amp * Math.sin(b._timeStep * Math.PI / 180);
                b._timeStep = (b._timeStep + freq * bulletScale) % 360;
                const currOffset = amp * Math.sin(b._timeStep * Math.PI / 180);
                const perpDelta = currOffset - prevOffset;

                const forwardX = Math.sin(b.angle) * b.magnitude * bulletScale;
                const forwardY = Math.cos(b.angle) * b.magnitude * bulletScale;
                const perpX = Math.cos(b.angle);
                const perpY = -Math.sin(b.angle);

                const inv = b.invert ? -1 : 1;
                b.pos.x += forwardX + perpX * perpDelta * inv;
                b.pos.y += forwardY + perpY * perpDelta * inv;
                b._traveled = (b._traveled || 0) + b.magnitude * bulletScale;
            } else {
                // Straight-line projectile
                const vx = Math.sin(b.angle) * b.magnitude * bulletScale;
                const vy = Math.cos(b.angle) * b.magnitude * bulletScale;
                b.pos.x += vx;
                b.pos.y += vy;
                b._traveled = (b._traveled || 0) + Math.sqrt(vx * vx + vy * vy);
            }

            // Only run local terrain/range/lifetime deletion for bullets near the
            // player. Off-screen bullets are managed by the server (UnloadPacket).
            // This prevents the client from independently deleting a bullet that the
            // server still tracks — if that happens, the delta LoadPacket never
            // re-sends it, leaving an invisible bullet that can still damage the player.
            const bCenterX = b.pos.x + (b.size || 4) / 2;
            const bCenterY = b.pos.y + (b.size || 4) / 2;
            let nearPlayer = true;
            if (localP && localP.pos) {
                const pdx = bCenterX - localP.pos.x;
                const pdy = bCenterY - localP.pos.y;
                nearPlayer = (pdx * pdx + pdy * pdy) <= vpThresholdSq;
            }
            if (nearPlayer) {
                // Collision tile check — destroy bullet if center enters a collision tile
                // (matches server proccessTerrainHit: tileBounds.inside(bulletCenter))
                const passThrough = b.flags && b.flags.includes(ProjectileFlag.PASS_THROUGH_TERRAIN);
                if (!passThrough) {
                    const bts = this.tileSize || 32;
                    const btx = Math.floor(bCenterX / bts);
                    const bty = Math.floor(bCenterY / bts);
                    if (this.mapTiles && btx >= 0 && btx < this.mapWidth && bty >= 0 && bty < this.mapHeight) {
                        const bTile = this.mapTiles[bty]?.[btx];
                        if (bTile && bTile.collision > 0) {
                            const bTileDef = this.tileData[bTile.collision];
                            if (bTileDef?.data?.hasCollision) {
                                this.bullets.delete(id);
                                continue;
                            }
                        }
                    }
                }

                const lifetime = now - (b._clientCreatedTime || Number(b.createdTime));
                if (b._traveled > b.range || lifetime > 10000) {
                    this.bullets.delete(id);
                    continue;
                }
            }

            // Client-side predicted bullet-enemy hit detection (player bullets only).
            // Player bullets have flag 10 (PLAYER_PROJECTILE). Skip everything else.
            // Predicts: damage text, HP bar reduction, and enemy death.
            // Server remains authoritative — corrections arrive via LoadPacket/TextEffect.
            //
            // Circle-vs-circle hit test. radius = size * BULLET_HIT_RADIUS_FACTOR.
            // Centers come from (pos + size/2). MUST match the server's circleHit()
            // in RealmManagerServer.java exactly.
            const isPlayerBullet = b._predicted || (b.flags && b.flags.includes(ProjectileFlag.PLAYER_PROJECTILE));
            if (!isPlayerBullet) continue;
            // Pierce flag: bullet hits every enemy on its path. Mirrors the
            // server's PASS_THROUGH_ENEMIES handling — _hitEnemyIds tracks
            // which enemies this bullet has already damaged so a single bullet
            // never double-hits a target while passing through.
            const piercesEnemies = b.flags && b.flags.includes(ProjectileFlag.PASS_THROUGH_ENEMIES);
            const bSize = b.size || 4;
            const br = bSize * BULLET_HIT_RADIUS_FACTOR;
            const bcx = b.pos.x + bSize * 0.5;
            const bcy = b.pos.y + bSize * 0.5;
            for (const [eid, enemy] of this.enemies) {
                if (!enemy.pos) continue;
                if (piercesEnemies && b._hitEnemyIds && b._hitEnemyIds.has(eid)) continue;
                const eSize = enemy.size || 32;
                const er = eSize * BULLET_HIT_RADIUS_FACTOR;
                const ecx = enemy.pos.x + eSize * 0.5;
                const ecy = enemy.pos.y + eSize * 0.5;
                const edx = bcx - ecx;
                const edy = bcy - ecy;
                const rsum = br + er;
                // Quick AABB cull on bounding square (cheaper than the squared compare)
                if (edx > rsum || edx < -rsum || edy > rsum || edy < -rsum) continue;
                if ((edx * edx + edy * edy) < (rsum * rsum)) {
                    // Predict damage and apply to local enemy state
                    if (b.damage > 0 && enemy.maxHealth > 0) {
                        const dmg = Math.max(Math.floor(b.damage * 0.85), 1);
                        enemy.health = Math.max(0, enemy.health - dmg);

                        // Show predicted damage text
                        const hitX = enemy.pos.x + eSize / 2;
                        const hitY = enemy.pos.y;
                        const isArmorPiercing = b.flags && b.flags.includes(ProjectileFlag.ARMOR_PIERCING);
                        const isArmorBroken = enemy.effectIds && enemy.effectIds.includes(StatusEffect.ARMOR_BROKEN);
                        const dmgColor = (isArmorPiercing || isArmorBroken) ? 0x60a0ff : 0xff4444;
                        this.damageTexts.push({
                            text: '-' + dmg, x: hitX, y: hitY - 8,
                            color: dmgColor, life: 40, _count: 1, _predicted: true
                        });

                    }
                    if (piercesEnemies) {
                        if (!b._hitEnemyIds) b._hitEnemyIds = new Set();
                        b._hitEnemyIds.add(eid);
                        // keep flying — don't break, the bullet may overlap
                        // multiple enemies in this same tick
                    } else {
                        this.bullets.delete(id);
                        break;
                    }
                }
            }
        }

        // Update damage texts — float upward in screen space and fade out
        for (let i = this.damageTexts.length - 1; i >= 0; i--) {
            if (this.damageTexts[i].screenOffY === undefined) this.damageTexts[i].screenOffY = 0;
            this.damageTexts[i].screenOffY -= 1.0; // float up in screen space
            this.damageTexts[i].life--;
            if (this.damageTexts[i].life <= 0) this.damageTexts.splice(i, 1);
        }

        // Expire finished visual effects
        this.updateVisualEffects();

        const local = this.getLocalPlayer();
        if (local) {
            const visualX = (local._renderX !== undefined ? local._renderX : local.pos.x) + (local._smoothX || 0);
            const visualY = (local._renderY !== undefined ? local._renderY : local.pos.y) + (local._smoothY || 0);
            // Frame-rate independent exponential smoothing:
            // factor = 1 - e^(-dt / halflife). With halflife ~0.03s the camera
            // covers ~97% of the gap within 150ms regardless of frame rate.
            const camSmooth = 1 - Math.exp(-dt / 0.03);
            this.cameraX += (visualX - this.cameraX) * camSmooth;
            this.cameraY += (visualY - this.cameraY) * camSmooth;
        }
    }

    // Loot container interaction range: player.getSize() * 0.75 (50% larger than original size/2)
    getNearbyLootContainer() {
        const local = this.getLocalPlayer();
        if (!local) return null;
        const maxDist = (local.size || 32) * 0.75;
        let closest = null, closestDist = Infinity;
        for (const [id, loot] of this.lootContainers) {
            const dx = loot.pos.x - local.pos.x, dy = loot.pos.y - local.pos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < closestDist && dist < maxDist) { closestDist = dist; closest = loot; }
        }
        return closest;
    }

    // Look up a player's chatRole by their display name
    getPlayerRoleByName(name) {
        if (!name) return null;
        for (const [id, p] of this.players) {
            if (p.name === name) return p.chatRole || null;
        }
        return null;
    }

    // Get nearby players (excluding self) for the players list
    getNearbyPlayers(max = 16) {
        const result = [];
        for (const [id, p] of this.players) {
            if (id === this.playerId) continue;
            result.push(p);
            if (result.length >= max) break;
        }
        return result;
    }

    // Parse exp level ranges into {level: {min, max}} on first call
    _getParsedExpMap() {
        if (this._parsedExpMap) return this._parsedExpMap;
        if (!this.expLevels || !this.expLevels.levelExperienceMap) return null;
        this._parsedExpMap = {};
        this._maxExpLevel = 1;
        this._maxExperience = 0;
        for (const [lvl, range] of Object.entries(this.expLevels.levelExperienceMap)) {
            const [min, max] = range.split('-').map(Number);
            const l = parseInt(lvl);
            this._parsedExpMap[l] = { min, max };
            if (l > this._maxExpLevel) this._maxExpLevel = l;
            if (max > this._maxExperience) this._maxExperience = max;
        }
        return this._parsedExpMap;
    }

    // Matches Java ExperienceModel.getLevel()
    getPlayerLevel() {
        const map = this._getParsedExpMap();
        if (!map) return 1;
        const exp = Number(this.experience);
        if (exp > this._maxExperience) return this._maxExpLevel + 1; // Level 20 (fame mode)
        let level = 1;
        for (const [lvl, range] of Object.entries(map)) {
            if (range.min <= exp && range.max >= exp) {
                level = parseInt(lvl);
            }
        }
        return level;
    }

    // Matches Java ExperienceModel.getBaseFame()
    getBaseFame() {
        const exp = Number(this.experience);
        if (exp > this._maxExperience) {
            return Math.floor((exp - this._maxExperience) / 2500);
        }
        return 0;
    }

    // Get XP bar display info matching Java FillBars
    getExpDisplayInfo() {
        const map = this._getParsedExpMap();
        if (!map) return { text: 'Lv 1', pct: 0, isFame: false };
        const exp = Number(this.experience);
        const level = this.getPlayerLevel();
        const fame = this.getBaseFame();

        if (fame > 0) {
            // Max level reached (Lv 20) — show fame with gold bar
            return { text: `Lv 20  Fame: ${fame}`, pct: 100, isFame: true };
        }

        // Show XP progress within current level as difference from level floor
        const range = map[level];
        if (!range) return { text: `Lv ${level}`, pct: 0, isFame: false };
        const xpIntoLevel = exp - range.min;
        const xpForLevel = range.max - range.min;
        const pct = Math.min(100, (xpIntoLevel / xpForLevel) * 100);
        return { text: `Lv ${level}  ${xpIntoLevel} / ${xpForLevel}`, pct, isFame: false };
    }

    // Get max stats for the current class
    getMaxStats() {
        const classDef = this.characterClasses[this.classId];
        return classDef ? classDef.maxStats : null;
    }
}
