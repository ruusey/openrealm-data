// PixiJS-based game renderer

import { CLASS_NAMES, StatusEffect, ProjectileFlag } from './game.js';

const BASE_SPRITE_SIZE = 8;  // Sprite sheet cell size (pixels in sheet)
const PLAYER_SIZE = 28;      // World collision size for players
const PLAYER_RENDER_SIZE = 32; // Visual render size for players
// Detect mobile mode: true phones/tablets, not 2-in-1 laptops with touchscreens.
// A manual override is stored in localStorage ('forceDesktop' / 'forceMobile').
function detectMobile() {
    const override = localStorage.getItem('openrealm_viewmode');
    if (override === 'mobile') return true;
    if (override === 'desktop') return false;
    // Only treat as mobile if the screen is actually small AND touch-capable.
    // 2-in-1 laptops have touch but large viewports (1920px+), so screen size is the key signal.
    const smallScreen = window.innerWidth < 900 && window.innerHeight < 600;
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    return smallScreen || mobileUA;
}
const IS_MOBILE = detectMobile();
const SCALE = IS_MOBILE ? 0.75 : 2;
const VIEWPORT_TILES = IS_MOBILE ? 16 : 24;
const OUTLINE_OFFSETS = [[1,0],[-1,0],[0,1],[0,-1]];
const OUTLINE_TINT = 0x000000;
const OUTLINE_ALPHA = 0.85;

/**
 * Add a black pixel outline around a sprite by rendering 4 tinted copies
 * at 1px cardinal offsets behind it. All copies share the same texture
 * (no GPU upload), and PixiJS batches them in the same draw call.
 */
function addSpriteWithOutline(container, tex, x, y, w, h, opts) {
    for (const [ox, oy] of OUTLINE_OFFSETS) {
        const ol = new PIXI.Sprite(tex);
        ol.x = x + ox; ol.y = y + oy;
        ol.width = w; ol.height = h;
        ol.tint = OUTLINE_TINT;
        ol.alpha = OUTLINE_ALPHA;
        if (opts?.anchor) ol.anchor.copyFrom(opts.anchor);
        if (opts?.flipX) { ol.anchor.set(1, ol.anchor.y); ol.scale.x = -Math.abs(ol.scale.x); }
        if (opts?.rotation != null) ol.rotation = opts.rotation;
        if (opts?.mask) ol.mask = opts.mask; // Share mask for wading clip
        container.addChild(ol);
    }
}

// Parse template angle expressions like "{{PI/4}}", "{{1.5PI/6}}"
function parseAngleTemplate(str) {
    if (str == null || str === '') return 0;
    if (typeof str === 'number') return str;
    const match = String(str).match(/\{\{(.+?)\}\}/);
    if (!match) return parseFloat(str) || 0;
    let expr = match[1].trim();
    // Replace PI with Math.PI value, handle forms like "1.5PI/6"
    expr = expr.replace(/(\d*\.?\d*)PI/g, (_, coeff) => {
        const c = coeff === '' ? 1 : parseFloat(coeff);
        return (c * Math.PI).toString();
    });
    try { return Function('"use strict"; return (' + expr + ')')(); }
    catch(e) { return 0; }
}

export class GameRenderer {
    constructor(container) {
        this.container = container;
        this.app = null;
        this.textures = {};
        this.tileTextures = {};
        this.tileSize = 32; // Updated from map data
        this.mapData = {};  // mapId -> map definition

        // PixiJS layers
        this.worldLayer = null; // Rotatable wrapper for tile + entity layers
        this.tileLayer = null;
        this.entityLayer = null;
        this.uiLayer = null;

        // Graphics for health bars and shapes
        this.healthBarGraphics = null;
        this.tileGraphics = null;

        // Tile layer cache key — invalidated when visible tile range changes
        this._tileCacheKey = null;

        // Billboard sprite references — updated each frame with counter-rotation
        this._billboardSprites = [];

        // ---- PIXI.Text pool ----
        // Every `new PIXI.Text(...)` calls Texture.from(canvas, ...) internally,
        // which auto-registers the BaseTexture in PIXI.utils.BaseTextureCache.
        // Default destroy() does NOT remove from that cache, so creating fresh
        // Text instances per frame leaks <canvas>+context+WebGLTexture forever
        // (heap snapshot showed 8,879 detached canvases retained via
        //   pixiid_NNN ─ BaseTextureCache → BaseTexture → CanvasResource → canvas).
        // The pool keeps Text instances alive frame-to-frame in a persistent
        // _textContainer so .text and position are mutated rather than allocated.
        this._textContainer = null;        // PIXI.Container, never destroyed/cleared
        this._namePool = new Map();        // entityId -> { text, content, color, lastSeenFrame }
        this._damageTextSlots = [];        // PIXI.Text[]; reused per frame by index
        this._statusLabelSlots = [];       // PIXI.Text[]; reused per frame by index
        this._statusBgSlots = [];          // PIXI.Graphics[]; reused per frame by index
        this._damageSlotIdx = 0;
        this._statusSlotIdx = 0;
        this._frameId = 0;                 // increments per render(); used for name-pool TTL
    }

    /** Force tile layer rebuild on next frame (call on realm transition). */
    invalidateTileCache() {
        this._tileCacheKey = null;
        this._billboardSprites = [];
    }

    /** Acquire (or create) the long-lived Text for an entity's name label.
     *  The text+style only re-rasterize when content or color actually change. */
    _acquireNameText(entityId, content, color) {
        let entry = this._namePool.get(entityId);
        if (!entry) {
            const t = new PIXI.Text(content, {
                fontSize: 16, fill: color,
                fontFamily: 'OryxSimplex, monospace', fontWeight: 'bold',
                stroke: 0x000000, strokeThickness: 3
            });
            t.anchor.set(0.5, 1);
            this._textContainer.addChild(t);
            entry = { text: t, content, color, lastSeenFrame: this._frameId };
            this._namePool.set(entityId, entry);
        } else {
            entry.lastSeenFrame = this._frameId;
            if (entry.content !== content) { entry.text.text = content; entry.content = content; }
            if (entry.color !== color)   { entry.text.style.fill = color; entry.color = color; }
            entry.text.visible = true;
        }
        return entry.text;
    }

    /** Acquire next slot from the damage-text pool (all damage texts share
     *  a single style; only content + color/scale/alpha change per frame). */
    _acquireDamageText(content, colorStr) {
        const idx = this._damageSlotIdx++;
        let t = this._damageTextSlots[idx];
        if (!t) {
            t = new PIXI.Text(content, {
                fontSize: 24, fill: colorStr,
                fontFamily: 'OryxSimplex, monospace', fontWeight: 'bold',
                stroke: '#000000', strokeThickness: 4
            });
            t.anchor.set(0.5, 0.5);
            this._textContainer.addChild(t);
            t._cachedContent = content;
            t._cachedColor = colorStr;
            this._damageTextSlots[idx] = t;
        } else {
            if (t._cachedContent !== content) { t.text = content; t._cachedContent = content; }
            if (t._cachedColor !== colorStr) { t.style.fill = colorStr; t._cachedColor = colorStr; }
            t.visible = true;
        }
        return t;
    }

    /** Acquire next status-icon slot (background Graphics + label Text). */
    _acquireStatusIcon(sym) {
        const idx = this._statusSlotIdx++;
        let bg = this._statusBgSlots[idx];
        let label = this._statusLabelSlots[idx];
        if (!bg) {
            bg = new PIXI.Graphics();
            this._textContainer.addChild(bg);
            this._statusBgSlots[idx] = bg;
        } else {
            bg.clear();
            bg.visible = true;
        }
        if (!label) {
            label = new PIXI.Text(sym, {
                fontSize: 9, fill: 0xFFFFFF,
                fontFamily: 'OryxSimplex, monospace', fontWeight: 'bold',
                stroke: 0x000000, strokeThickness: 1
            });
            label.anchor.set(0.5, 0.5);
            this._textContainer.addChild(label);
            label._cachedSym = sym;
            this._statusLabelSlots[idx] = label;
        } else {
            if (label._cachedSym !== sym) { label.text = sym; label._cachedSym = sym; }
            label.visible = true;
        }
        return { bg, label };
    }

    /** Hide pool slots not used this frame, and evict name-pool entries for
     *  entities not seen for a couple of seconds. Properly removes texture
     *  cache entries before destroying — otherwise the canvas leaks via
     *  PIXI.utils.BaseTextureCache (the very leak this pool exists to prevent). */
    _endTextFrame() {
        for (let i = this._damageSlotIdx; i < this._damageTextSlots.length; i++) {
            this._damageTextSlots[i].visible = false;
        }
        for (let i = this._statusSlotIdx; i < this._statusLabelSlots.length; i++) {
            if (this._statusLabelSlots[i]) this._statusLabelSlots[i].visible = false;
            if (this._statusBgSlots[i]) this._statusBgSlots[i].visible = false;
        }
        // Hide name-pool entries that weren't acquired this frame (entity died,
        // walked off-screen, or unloaded). Without this the previous render's
        // text lingers at the dead entity's last position until the slow prune
        // cycle below runs. Done every frame; cost is one Map iteration.
        for (const entry of this._namePool.values()) {
            if (entry.lastSeenFrame !== this._frameId) {
                entry.text.visible = false;
            }
        }
        // Periodically destroy long-stale entries so the pool doesn't grow
        // unboundedly across realm transitions. _destroyPooledText removes
        // the Texture from PIXI's BaseTextureCache before destroying — without
        // that step the underlying <canvas> leaks (this is the same caching
        // pitfall the pool exists to fix in the first place).
        if ((this._frameId & 127) === 0) {
            const cutoff = this._frameId - 180; // ~3 seconds at 60fps
            for (const [id, entry] of this._namePool) {
                if (entry.lastSeenFrame < cutoff) {
                    this._destroyPooledText(entry.text);
                    this._namePool.delete(id);
                }
            }
        }
    }

    /** Properly destroy a pooled Text — removes from BaseTextureCache/TextureCache
     *  before destroying, so the underlying <canvas>+context+WebGLTexture become
     *  GC-able rather than retained by the global cache forever. */
    _destroyPooledText(t) {
        if (!t || t.destroyed) return;
        if (t.parent) t.parent.removeChild(t);
        const tex = t.texture;
        if (tex) {
            try { if (PIXI.Texture.removeFromCache) PIXI.Texture.removeFromCache(tex); } catch(_) {}
            const bt = tex.baseTexture;
            if (bt) {
                try { if (PIXI.BaseTexture.removeFromCache) PIXI.BaseTexture.removeFromCache(bt); } catch(_) {}
            }
        }
        try { t.destroy({ children: false, texture: true, baseTexture: true }); } catch(_) {}
    }

    async init() {
        this.app = new PIXI.Application({
            resizeTo: this.container,
            backgroundColor: 0x211e27,
            antialias: false,
            resolution: 1,
        });
        // PixiJS v7 uses view property
        this.container.appendChild(this.app.view);

        // Set nearest neighbor scaling for pixel art
        PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.NEAREST;

        // Create layers — worldLayer wraps tile+entity for camera rotation
        this.worldLayer = new PIXI.Container();
        this.tileLayer = new PIXI.Container();
        this.entityLayer = new PIXI.Container();
        this.uiLayer = new PIXI.Container();

        this.worldLayer.addChild(this.tileLayer);
        this.worldLayer.addChild(this.entityLayer);
        this.app.stage.addChild(this.worldLayer);
        this.app.stage.addChild(this.uiLayer); // UI stays unrotated

        this.healthBarGraphics = new PIXI.Graphics();
        this.uiLayer.addChild(this.healthBarGraphics);

        // Persistent container for pooled PIXI.Text instances. Lives in uiLayer
        // (screen-space) above healthbars. Never destroyed/cleared per frame.
        this._textContainer = new PIXI.Container();
        this.uiLayer.addChild(this._textContainer);
    }

    async loadTexture(key, url) {
        try {
            const tex = await PIXI.Assets.load(url);
            tex.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
            this.textures[key] = tex;
            return tex;
        } catch (e) {
            console.warn(`Failed to load texture ${key}: ${e.message}`);
            return null;
        }
    }

    // Extract a sprite region from a sprite sheet
    getRegion(textureKey, col, row, w = BASE_SPRITE_SIZE, h = BASE_SPRITE_SIZE) {
        // Normalize key: strip .png suffix to match loaded texture keys
        const key = textureKey.replace('.png', '');
        const tex = this.textures[key];
        if (!tex) return null;
        const rect = new PIXI.Rectangle(col * w, row * h, w, h);
        return new PIXI.Texture(tex.baseTexture, rect);
    }

    // Build tile texture lookup from tile definitions
    buildTileTextures(tileData) {
        this.tileTextures = {};
        let loaded = 0;
        for (const [tileId, tileDef] of Object.entries(tileData)) {
            if (!tileDef || !tileDef.spriteKey) continue;
            // spriteSize defaults to BASE_SPRITE_SIZE if 0 or missing (matches Java GameSpriteManager)
            const sw = tileDef.spriteSize || BASE_SPRITE_SIZE;
            const sh = tileDef.spriteHeight || sw;
            const tex = this.getRegion(
                tileDef.spriteKey,
                tileDef.col || 0,
                tileDef.row || 0,
                sw,
                sh
            );
            if (tex) {
                this.tileTextures[tileId] = tex;
                loaded++;
            }
        }
        if (loaded > 0) console.log(`[RENDER] Built ${loaded} tile textures`);
    }

    // Set tile size from map data
    setMapData(mapDataArray) {
        if (Array.isArray(mapDataArray)) {
            for (const m of mapDataArray) {
                this.mapData[m.mapId] = m;
            }
        }
    }

    updateTileSize(mapId) {
        const mapDef = this.mapData[mapId];
        if (mapDef && mapDef.tileSize) {
            this.tileSize = mapDef.tileSize;
        }
    }

    render(gameState) {
        if (!this.app) return;

        const screenW = this.app.screen.width;
        const screenH = this.app.screen.height;

        // Debug: log once on first render with valid data
        if (!this._debugLogged && gameState.getLocalPlayer()) {
            this._debugLogged = true;
            const lp = gameState.getLocalPlayer();
            // One-time screen info log
            console.log(`[RENDER] Screen: ${screenW}x${screenH}, ` +
                `Player pos: (${lp.pos.x}, ${lp.pos.y}), ` +
                `Camera: (${gameState.cameraX}, ${gameState.cameraY}), ` +
                `MapTiles: ${gameState.mapTiles ? 'loaded' : 'null'}, ` +
                `Map: ${gameState.mapWidth}x${gameState.mapHeight}, ` +
                `TileTextures: ${Object.keys(this.tileTextures).length}, ` +
                `LoadedTextures: ${Object.keys(this.textures).length}, ` +
                `Players: ${gameState.players.size}, Enemies: ${gameState.enemies.size}`);
        }

        const camX = gameState.cameraX;
        const camY = gameState.cameraY;
        const angle = gameState.cameraAngle || 0;

        // World layer: pivot at player center (cameraX/Y is top-left), centered on screen, rotated
        const localPlayer = gameState.getLocalPlayer();
        const playerHalf = ((localPlayer?.size || PLAYER_SIZE) / 2) * SCALE;
        this.worldLayer.pivot.set(Math.round(camX * SCALE + playerHalf), Math.round(camY * SCALE + playerHalf));
        this.worldLayer.position.set(Math.round(screenW / 2), Math.round(screenH / 2));
        this.worldLayer.rotation = angle;

        // Clear UI layer (damage text, etc.) - keep healthbar graphics AND the
        // persistent pooled-text container.
        const keepers = [this.healthBarGraphics, this._textContainer];
        for (let i = this.uiLayer.children.length - 1; i >= 0; i--) {
            const child = this.uiLayer.children[i];
            if (keepers.indexOf(child) !== -1) continue;
            this.uiLayer.removeChildAt(i);
            child.destroy();
        }
        // Ensure both keepers are present (and z-ordered: healthbars under text)
        if (this.healthBarGraphics.parent !== this.uiLayer) this.uiLayer.addChild(this.healthBarGraphics);
        if (this._textContainer.parent !== this.uiLayer) this.uiLayer.addChild(this._textContainer);

        // Reset per-frame pool counters BEFORE renderEntities/renderDamageTexts run
        this._frameId++;
        this._damageSlotIdx = 0;
        this._statusSlotIdx = 0;

        this.renderTiles(gameState, screenW, screenH, angle);
        this.renderEntities(gameState, angle);
        this.renderVisualEffects(gameState, angle);
        this.renderHealthBars(gameState, angle);
        this.renderDamageTexts(gameState, angle);

        // Hide unused pool slots and prune stale name-pool entries
        this._endTextFrame();
    }

    renderTiles(gameState, screenW, screenH, angle) {
        if (!gameState.mapTiles) return;
        const localPlayer = gameState.getLocalPlayer();
        if (!localPlayer) return;

        const ts = this.tileSize;
        const playerTileX = Math.floor(localPlayer.pos.x / ts);
        const playerTileY = Math.floor(localPlayer.pos.y / ts);

        // When rotated, the viewport diamond covers more tiles — expand range
        const rotExpand = angle !== 0 ? Math.ceil(VIEWPORT_TILES * 0.42) : 0;
        const range = VIEWPORT_TILES + rotExpand;

        const minR = Math.max(0, playerTileY - range);
        const maxR = Math.min(gameState.mapHeight - 1, playerTileY + range);
        const minC = Math.max(0, playerTileX - range);
        const maxC = Math.min(gameState.mapWidth - 1, playerTileX + range);

        // Cache key: only rebuild tiles when the visible tile range changes.
        // Billboard rotation is updated separately without rebuilding.
        const cacheKey = `${minR},${maxR},${minC},${maxC},${gameState.mapWidth}`;
        if (this._tileCacheKey !== cacheKey) {
            this._tileCacheKey = cacheKey;
            this._rebuildTileLayer(gameState, minR, maxR, minC, maxC, ts);
        }

        // Update billboard sprites (decoration/object tiles) to face camera
        for (const item of this._billboardSprites) {
            item.rotation = -angle;
        }
    }

    /** Rebuild the tile layer from scratch (only when visible range changes). */
    _rebuildTileLayer(gameState, minR, maxR, minC, maxC, ts) {
        for (let i = this.tileLayer.children.length - 1; i >= 0; i--) {
            this.tileLayer.children[i].destroy();
        }
        this.tileLayer.removeChildren();
        this._billboardSprites = [];

        const drawSize = ts * SCALE;

        // === PASS 1: All base tiles ===
        for (let r = minR; r <= maxR; r++) {
            for (let c = minC; c <= maxC; c++) {
                const tile = gameState.mapTiles[r]?.[c];
                if (!tile || tile.base <= 0) continue;
                const sx = c * ts * SCALE;
                const sy = r * ts * SCALE;
                const tex = this.tileTextures[tile.base];
                if (tex) {
                    const spr = new PIXI.Sprite(tex);
                    spr.x = sx; spr.y = sy;
                    spr.width = drawSize; spr.height = drawSize;
                    this.tileLayer.addChild(spr);
                } else {
                    const g = new PIXI.Graphics();
                    g.beginFill(0xFF00FF);
                    g.drawRect(sx, sy, drawSize, drawSize);
                    g.endFill();
                    this.tileLayer.addChild(g);
                }
            }
        }

        // === PASS 2: All collision/wall/decoration tiles ===
        for (let r = minR; r <= maxR; r++) {
            for (let c = minC; c <= maxC; c++) {
                const tile = gameState.mapTiles[r]?.[c];
                if (!tile || tile.collision <= 0) continue;
                const sx = c * ts * SCALE;
                const sy = r * ts * SCALE;
                const tex = this.tileTextures[tile.collision];
                if (!tex) continue;

                const tileDef = gameState.tileData[tile.collision];
                const hasCollision = tileDef?.data?.hasCollision;
                const isWall = !!tileDef?.data?.isWall;
                const isObject = hasCollision && !isWall;

                if (isWall) {
                    // Walls rotate with the world — no billboarding
                    const isWallAt = (rr, cc) => {
                        const t = gameState.mapTiles[rr]?.[cc];
                        if (!t || t.collision <= 0) return false;
                        return !!gameState.tileData[t.collision]?.data?.isWall;
                    };
                    const wN = isWallAt(r - 1, c);
                    const wS = isWallAt(r + 1, c);
                    const wW = isWallAt(r, c - 1);
                    const wE = isWallAt(r, c + 1);

                    if (!wS) {
                        const sideH = Math.max(Math.round(drawSize * 0.28), 4);
                        const bandH = Math.ceil(sideH / 3);
                        const xEnd = drawSize + (!wE ? Math.round(drawSize * 0.18) : 0);
                        const sg = new PIXI.Graphics();
                        sg.beginFill(0x000000, 0.55).drawRect(sx, sy + drawSize,             xEnd, bandH).endFill();
                        sg.beginFill(0x000000, 0.32).drawRect(sx, sy + drawSize + bandH,     xEnd, bandH).endFill();
                        sg.beginFill(0x000000, 0.13).drawRect(sx, sy + drawSize + 2 * bandH, xEnd, bandH).endFill();
                        this.tileLayer.addChild(sg);
                    }
                    if (!wE) {
                        const sideW = Math.max(Math.round(drawSize * 0.18), 3);
                        const bandW = Math.ceil(sideW / 3);
                        const startY = sy + (wN ? 0 : 2);
                        const h = (sy + drawSize) - startY;
                        const eg = new PIXI.Graphics();
                        eg.beginFill(0x000000, 0.42).drawRect(sx + drawSize,             startY, bandW, h).endFill();
                        eg.beginFill(0x000000, 0.24).drawRect(sx + drawSize + bandW,     startY, bandW, h).endFill();
                        eg.beginFill(0x000000, 0.10).drawRect(sx + drawSize + 2 * bandW, startY, bandW, h).endFill();
                        this.tileLayer.addChild(eg);
                    }
                    if (!wW) {
                        const sideW = Math.max(Math.round(drawSize * 0.13), 3);
                        const bandW = Math.ceil(sideW / 3);
                        const wg = new PIXI.Graphics();
                        wg.beginFill(0x000000, 0.32).drawRect(sx - bandW,         sy, bandW, drawSize).endFill();
                        wg.beginFill(0x000000, 0.18).drawRect(sx - 2 * bandW,     sy, bandW, drawSize).endFill();
                        wg.beginFill(0x000000, 0.08).drawRect(sx - 3 * bandW,     sy, bandW, drawSize).endFill();
                        this.tileLayer.addChild(wg);
                    }
                    if (!wN) {
                        const sideH = Math.max(Math.round(drawSize * 0.12), 3);
                        const bandH = Math.ceil(sideH / 3);
                        const xStart = sx + (wW ? 0 : 2);
                        const xEnd   = sx + drawSize - (wE ? 0 : 2);
                        const w = xEnd - xStart;
                        const ng = new PIXI.Graphics();
                        ng.beginFill(0x000000, 0.28).drawRect(xStart, sy - bandH,         w, bandH).endFill();
                        ng.beginFill(0x000000, 0.15).drawRect(xStart, sy - 2 * bandH,     w, bandH).endFill();
                        ng.beginFill(0x000000, 0.06).drawRect(xStart, sy - 3 * bandH,     w, bandH).endFill();
                        this.tileLayer.addChild(ng);
                    }

                    const outlines = [[ 1,0,wE],[-1,0,wW],[0,1,wS],[0,-1,wN]];
                    for (const [ox, oy, skip] of outlines) {
                        if (skip) continue;
                        const ol = new PIXI.Sprite(tex);
                        ol.x = sx + ox; ol.y = sy + oy;
                        ol.width = drawSize; ol.height = drawSize;
                        ol.tint = 0x111118; ol.alpha = 0.55;
                        this.tileLayer.addChild(ol);
                    }

                    const spr = new PIXI.Sprite(tex);
                    spr.x = sx; spr.y = sy;
                    spr.width = drawSize; spr.height = drawSize;
                    this.tileLayer.addChild(spr);

                    if (!wN) {
                        const hl = new PIXI.Graphics();
                        hl.beginFill(0xFFFFFF, 0.26).drawRect(sx, sy,     drawSize, 2).endFill();
                        hl.beginFill(0xFFFFFF, 0.11).drawRect(sx, sy + 2, drawSize, 2).endFill();
                        this.tileLayer.addChild(hl);
                    }
                    if (!wW) {
                        const hl = new PIXI.Graphics();
                        hl.beginFill(0xFFFFFF, 0.14).drawRect(sx,     sy, 1, drawSize).endFill();
                        hl.beginFill(0xFFFFFF, 0.06).drawRect(sx + 1, sy, 1, drawSize).endFill();
                        this.tileLayer.addChild(hl);
                    }
                } else if (isObject) {
                    // Collision objects (trees, rocks) — billboard to face camera
                    const bbContainer = new PIXI.Container();
                    bbContainer.position.set(sx + drawSize / 2, sy + drawSize / 2);

                    // Shadow (drawn at bottom of sprite)
                    const shadowG = new PIXI.Graphics();
                    shadowG.beginFill(0x000000, 0.35);
                    shadowG.drawEllipse(0, drawSize * 0.4, drawSize * 0.4, drawSize * 0.12);
                    shadowG.endFill();
                    bbContainer.addChild(shadowG);

                    addSpriteWithOutline(bbContainer, tex,
                        -drawSize / 2, -drawSize / 2, drawSize, drawSize);
                    const spr = new PIXI.Sprite(tex);
                    spr.x = -drawSize / 2; spr.y = -drawSize / 2;
                    spr.width = drawSize; spr.height = drawSize;
                    bbContainer.addChild(spr);

                    this.tileLayer.addChild(bbContainer);
                    this._billboardSprites.push(bbContainer);
                } else {
                    // Decoration tiles (bushes, flowers) — billboard to face camera
                    const bbContainer = new PIXI.Container();
                    bbContainer.position.set(sx + drawSize / 2, sy + drawSize / 2);

                    const decShadow = new PIXI.Graphics();
                    decShadow.beginFill(0x000000, 0.25);
                    decShadow.drawEllipse(0, drawSize * 0.58, drawSize * 0.3, drawSize * 0.07);
                    decShadow.endFill();
                    bbContainer.addChild(decShadow);

                    const spr = new PIXI.Sprite(tex);
                    spr.x = -drawSize / 2; spr.y = -drawSize / 2;
                    spr.width = drawSize; spr.height = drawSize;
                    bbContainer.addChild(spr);

                    this.tileLayer.addChild(bbContainer);
                    this._billboardSprites.push(bbContainer);
                }
            }
        }
    }

    renderEntities(gameState, angle) {
        // Destroy all children to free GPU memory
        for (let i = this.entityLayer.children.length - 1; i >= 0; i--) {
            this.entityLayer.children[i].destroy();
        }
        this.entityLayer.removeChildren();

        // Y-sort all entities so things further north render behind things further south.
        // This creates proper depth: entities behind walls appear behind them.
        const sortable = [];
        for (const [id, loot] of gameState.lootContainers)
            sortable.push({ type: 'loot', data: loot, y: loot.pos.y + (loot.size || 32) });
        for (const [id, portal] of gameState.portals)
            sortable.push({ type: 'portal', data: portal, y: portal.pos.y + (portal.size || 32) });
        for (const [id, enemy] of gameState.enemies)
            sortable.push({ type: 'enemy', data: enemy, y: enemy.pos.y + (enemy.size || 32) });
        for (const [id, player] of gameState.players)
            sortable.push({ type: 'player', data: player, id: id, y: player.pos.y + (player.size || 32) });
        sortable.sort((a, b) => a.y - b.y);

        for (const ent of sortable) {
            if (ent.type === 'loot') this.renderLootContainer(ent.data, angle, gameState);
            else if (ent.type === 'portal') this.renderPortal(ent.data, angle, gameState);
            else if (ent.type === 'enemy') this.renderEnemy(ent.data, angle, gameState);
            else if (ent.type === 'player') this.renderPlayer(ent.data, angle, ent.id === gameState.playerId, gameState);
        }

        // Render bullets — viewport-culled + capped for performance.
        // Bullets are in world-pixel space inside the rotated worldLayer.
        const bulletGfx = new PIXI.Graphics();
        if (!this._bulletTexCache) this._bulletTexCache = {};
        const screenW = this.app.screen.width, screenH = this.app.screen.height;
        // Expand cull bounds when rotated since worldLayer is rotated
        const cullMargin = angle !== 0 ? 256 : 64;
        const camX = gameState.cameraX * SCALE, camY = gameState.cameraY * SCALE;
        const halfW = screenW / 2 + cullMargin, halfH = screenH / 2 + cullMargin;
        const MAX_RENDERED_BULLETS = 200;
        let bulletCount = 0;
        const hideOtherPlayerBullets = !!(gameState.settings
                && gameState.settings.graphics
                && gameState.settings.graphics.hideOtherPlayerBullets);
        const localPlayerId = gameState.playerId;

        for (const [id, bullet] of gameState.bullets) {
            if (hideOtherPlayerBullets && bullet.flags
                    && bullet.flags.includes(ProjectileFlag.PLAYER_PROJECTILE)) {
                const isMine = bullet._predicted
                        || (bullet.srcEntityId !== undefined && bullet.srcEntityId === localPlayerId);
                if (!isMine) continue;
            }

            // World-pixel position (no offsetX/Y — worldLayer handles camera)
            const sx = bullet.pos.x * SCALE;
            const sy = bullet.pos.y * SCALE;

            // Viewport culling — approximate distance from camera center
            if (Math.abs(sx - camX) > halfW || Math.abs(sy - camY) > halfH) continue;
            if (++bulletCount > MAX_RENDERED_BULLETS) break;

            const size = (bullet.size || 4) * SCALE;
            const projGroup = gameState.projectileGroups[bullet.projectileId];
            let tex = null;
            if (projGroup && projGroup.spriteKey) {
                const sw = projGroup.spriteSize || BASE_SPRITE_SIZE;
                const sh = projGroup.spriteHeight || sw;
                const cacheKey = projGroup.spriteKey + ':' + (projGroup.row||0) + ':' + (projGroup.col||0) + ':' + sw + 'x' + sh;
                if (!(cacheKey in this._bulletTexCache)) {
                    this._bulletTexCache[cacheKey] = this.getRegion(
                        projGroup.spriteKey, projGroup.col || 0, projGroup.row || 0, sw, sh);
                }
                tex = this._bulletTexCache[cacheKey];
            }

            if (tex) {
                const spr = new PIXI.Sprite(tex);
                spr.anchor.set(0.5, 0.5);
                spr.x = sx + size / 2;
                spr.y = sy + size / 2;
                spr.width = size; spr.height = size;
                const tfAngle = Math.PI / 2;
                const angleOffset = projGroup ? parseAngleTemplate(projGroup.angleOffset) : 0;
                spr.rotation = -bullet.angle + tfAngle + (angleOffset > 0 ? angleOffset : 0);
                this.entityLayer.addChild(spr);
            } else {
                bulletGfx.beginFill(0xffff80);
                bulletGfx.drawCircle(sx + size / 2, sy + size / 2, size / 3);
                bulletGfx.endFill();
            }
        }
        if (bulletGfx.geometry.graphicsData.length > 0) {
            this.entityLayer.addChild(bulletGfx);
        }
    }

    renderPlayer(player, angle, isLocal, gameState) {
        const collisionSize = (player.size || PLAYER_SIZE) * SCALE;
        const size = PLAYER_RENDER_SIZE * SCALE;
        const renderOffset = (size - collisionSize) / 2;
        const px = isLocal && player._renderX !== undefined ? player._renderX : player.pos.x;
        const py = isLocal && player._renderY !== undefined ? player._renderY : player.pos.y;
        const smX = isLocal ? (player._smoothX || 0) * SCALE : 0;
        const smY = isLocal ? (player._smoothY || 0) * SCALE : 0;
        // World-pixel position (worldLayer handles camera offset + rotation)
        const sx = px * SCALE - renderOffset + smX;
        const sy = py * SCALE - renderOffset + smY;

        // Animation-driven sprite selection
        const classId = player.classId || 0;
        const animDef = gameState.animations?.[`player:${classId}`];
        let sheetKey, frameCol, row;

        if (animDef) {
            sheetKey = animDef.spriteKey.replace('.png', '');
            const isMoving = Math.abs(player.dx || 0) > 0.1 || Math.abs(player.dy || 0) > 0.1;
            const isVertical = Math.abs(player.dy || 0) > Math.abs(player.dx || 0);
            const isBack = isVertical && (player.dy || 0) < 0;
            let animName;
            // Attack animation: local player uses aim direction, other players
            // use their movement direction to pick attack_side/down/up.
            const remoteAttacking = !isLocal && player.attacking && player.attackUntil > performance.now();
            if (isLocal && gameState.shootingAnim) {
                animName = gameState.shootingAnim;
            } else if (remoteAttacking) {
                // Other player is firing — pick attack anim from their velocity direction
                animName = isVertical ? (isBack ? 'attack_up' : 'attack_down') : 'attack_side';
            } else if (isMoving) {
                animName = isVertical ? (isBack ? 'walk_back' : 'walk_front') : 'walk_side';
            } else {
                animName = isVertical ? (isBack ? 'idle_back' : 'idle_front') : 'idle_side';
            }
            const isAttacking = (isLocal && gameState.shootingAnim) || remoteAttacking;
            const anim = animDef.animations[animName] || animDef.animations['idle_side'];
            const frames = anim.frames;
            let fIdx;
            if (isAttacking) {
                fIdx = (isLocal ? gameState.attackFrame : (player.animFrame || 0)) % frames.length;
            } else if (isMoving) {
                fIdx = player.animFrame % frames.length;
            } else {
                fIdx = 0;
            }
            row = frames[fIdx].row;
            frameCol = frames[fIdx].col;
        } else {
            // Legacy fallback
            const sheetIdx = Math.floor(classId / 3);
            const localRow = (classId % 3) * 4;
            sheetKey = `rotmg-classes-${sheetIdx}`;
            const isMoving = Math.abs(player.dx || 0) > 0.1 || Math.abs(player.dy || 0) > 0.1;
            frameCol = isMoving ? player.animFrame : 0;
            row = localRow;
        }

        // Check if player is wading through a slowing tile (water/lava)
        const wading = this._isEntityOnSlowTile(player, gameState);
        // When wading, clip bottom 30% of sprite to simulate legs submerged
        const wadingClip = wading ? 0.30 : 0;
        const visibleHeight = size * (1 - wadingClip);

        // Billboard container: counter-rotate so player always faces camera
        const bb = new PIXI.Container();
        bb.position.set(sx + size / 2, sy + size / 2);
        bb.rotation = -angle;
        // All child positions are relative to container center (-size/2 offsets)
        const lx = -size / 2, ly = -size / 2;

        // Circular ground shadow under player
        const pShadow = new PIXI.Graphics();
        pShadow.beginFill(0x000000, 0.3);
        pShadow.drawEllipse(0, size / 2 + size * 0.08, size * 0.4, size * 0.12);
        pShadow.endFill();
        bb.addChild(pShadow);

        const spW = animDef?.spriteSize || BASE_SPRITE_SIZE;
        const spH = animDef?.spriteHeight || spW;
        const tex = this.getRegion(sheetKey, frameCol, row, spW, spH);
        if (tex) {
            const flipX = player.facing === 'left';

            const spr = new PIXI.Sprite(tex);
            spr.x = lx; spr.y = ly;
            spr.width = size; spr.height = size;
            if (flipX) { spr.anchor.set(1, 0); spr.scale.x = -Math.abs(spr.scale.x); }

            // Status effect tinting
            const effects = isLocal ? gameState.effectIds : (player.effectIds || []);
            if (this._hasEffect(effects, StatusEffect.INVINCIBLE))      spr.tint = 0xFFFFCC;
            else if (this._hasEffect(effects, StatusEffect.ARMOR_BROKEN)) spr.tint = 0x7060CC;
            else if (this._hasEffect(effects, StatusEffect.PARALYZED))  spr.tint = 0x888888;
            else if (this._hasEffect(effects, StatusEffect.STUNNED))    spr.tint = 0x88AACC;
            else if (this._hasEffect(effects, StatusEffect.STASIS))     spr.tint = 0x333338;
            else if (this._hasEffect(effects, StatusEffect.INVISIBLE))  spr.tint = 0xCCBB88;
            else if (this._hasEffect(effects, StatusEffect.BERSERK))    spr.tint = 0xFF6644;
            else if (this._hasEffect(effects, StatusEffect.DAMAGING))   spr.tint = 0xFFAA66;
            else if (this._hasEffect(effects, StatusEffect.ARMORED))    spr.tint = 0x8899CC;
            else if (this._hasEffect(effects, StatusEffect.HEALING))    spr.tint = 0xFF8888;
            else if (this._hasEffect(effects, StatusEffect.SPEEDY))     spr.tint = 0xBBFF88;
            else if (this._hasEffect(effects, StatusEffect.DAZED))      spr.tint = 0x9988AA;
            else if (this._hasEffect(effects, StatusEffect.CURSED))     spr.tint = 0x992255;
            else if (this._hasEffect(effects, StatusEffect.POISONED))   spr.tint = 0x40CC40;

            // Wading effect: shift sprite down so the character sinks into the
            // liquid, then mask off the bottom so it looks submerged.
            if (wading) {
                const sinkOffset = size * wadingClip;
                spr.y = ly + sinkOffset;
                const mask = new PIXI.Graphics();
                mask.beginFill(0xFFFFFF);
                mask.drawRect(lx - 2, ly, size + 4, size);
                mask.endFill();
                bb.addChild(mask);
                spr.mask = mask;
                addSpriteWithOutline(bb, tex, lx, spr.y, size, size,
                    flipX ? { flipX: true, mask } : { mask });
            } else {
                addSpriteWithOutline(bb, tex, lx, ly, size, size,
                    flipX ? { flipX: true } : null);
            }
            bb.addChild(spr);
        } else {
            const g = new PIXI.Graphics();
            g.beginFill(isLocal ? 0x40c040 : 0x4080e0);
            g.drawRect(lx, ly, size, size);
            g.endFill();
            bb.addChild(g);
        }

        // HP and MP bars above player sprite
        const barWidth = size;
        const barHeight = 4;
        const barGap = 2;
        const barY = ly - barHeight * 2 - barGap - 4;

        const hp = isLocal ? gameState.health : (player.health || 0);
        const maxHp = isLocal ? (gameState.getComputedStats()?.hp || gameState.maxHealth || 100) : (player.maxHealth || 100);
        const mp = isLocal ? gameState.mana : (player.mana || 0);
        const maxMp = isLocal ? (gameState.getComputedStats()?.mp || gameState.maxMana || 100) : (player.maxMana || 100);
        const hpPct = maxHp > 0 ? Math.min(1, hp / maxHp) : 1;
        const mpPct = maxMp > 0 ? Math.min(1, mp / maxMp) : 1;

        const bars = new PIXI.Graphics();
        bars.beginFill(0x222222, 0.7);
        bars.drawRect(lx, barY, barWidth, barHeight);
        bars.endFill();
        bars.beginFill(0x40c040, 0.9);
        bars.drawRect(lx, barY, barWidth * hpPct, barHeight);
        bars.endFill();
        bars.beginFill(0x222222, 0.7);
        bars.drawRect(lx, barY + barHeight + barGap, barWidth, barHeight);
        bars.endFill();
        bars.beginFill(0x4080e0, 0.9);
        bars.drawRect(lx, barY + barHeight + barGap, barWidth * mpPct, barHeight);
        bars.endFill();
        bb.addChild(bars);

        // Player name above bars (other players only).
        // Pooled in _textContainer (screen-space) instead of inside `bb`, so the
        // Text instance survives the per-frame entityLayer destroy and we don't
        // leak <canvas> via PIXI.utils.BaseTextureCache.
        let iconAnchorY = barY - 2;
        if (!isLocal) {
            const name = player.name || CLASS_NAMES[classId] || 'Player';
            const nameColor = GameRenderer.getNameColorHex(player.chatRole);
            // Entity world-pixel center → screen coords. Add (0, barY-2) — the
            // original offset was inside the billboarded `bb` whose local Y axis
            // is screen-up, so the same offset applies in screen space.
            const cxWorld = (player.pos.x || 0) + (player.size || PLAYER_SIZE) / 2;
            const cyWorld = (player.pos.y || 0) + (player.size || PLAYER_SIZE) / 2;
            const screen = this.worldToScreen(cxWorld, cyWorld, gameState);
            const nameText = this._acquireNameText('p:' + String(player.id), name, nameColor);
            nameText.x = screen.x;
            nameText.y = screen.y + (barY - 2);
            iconAnchorY = barY - 18;
        }

        // Status effect icons above health bars / name. Pooled in screen-space.
        const playerEffects = isLocal ? gameState.effectIds : (player.effectIds || []);
        if (playerEffects && playerEffects.length) {
            const cxWorld = (player.pos.x || 0) + (player.size || PLAYER_SIZE) / 2;
            const cyWorld = (player.pos.y || 0) + (player.size || PLAYER_SIZE) / 2;
            const sc = this.worldToScreen(cxWorld, cyWorld, gameState);
            this._drawStatusIcons(playerEffects, sc.x, sc.y + iconAnchorY);
        }

        this.entityLayer.addChild(bb);
    }

    renderEnemy(enemy, angle, gameState) {
        const sx = enemy.pos.x * SCALE;
        const sy = enemy.pos.y * SCALE;
        const size = (enemy.size || PLAYER_SIZE) * SCALE;

        // Billboard container: counter-rotate so enemy faces camera
        const bb = new PIXI.Container();
        bb.position.set(sx + size / 2, sy + size / 2);
        bb.rotation = -angle;
        const lx = -size / 2, ly = -size / 2;

        const enemyDef = gameState.enemyData[enemy.enemyId];
        let tex = null;
        if (enemyDef && enemyDef.spriteKey) {
            const sw = enemyDef.spriteSize || BASE_SPRITE_SIZE;
            const sh = enemyDef.spriteHeight || sw;
            tex = this.getRegion(enemyDef.spriteKey, enemyDef.col || 0, enemyDef.row || 0, sw, sh);
        }

        // Shadow
        const shadowG = new PIXI.Graphics();
        shadowG.beginFill(0x000000, 0.3);
        shadowG.drawEllipse(0, size / 2 + size * 0.08, size * 0.4, size * 0.12);
        shadowG.endFill();
        bb.addChild(shadowG);

        if (tex) {
            const spr = new PIXI.Sprite(tex);
            spr.x = lx; spr.y = ly;
            spr.width = size; spr.height = size;

            if (enemy.effectIds) {
                if (this._hasEffect(enemy.effectIds, StatusEffect.STASIS))      spr.tint = 0x333338;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.INVINCIBLE))  spr.tint = 0xFFFFCC;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.ARMOR_BROKEN)) spr.tint = 0x7060CC;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.PARALYZED))   spr.tint = 0x888888;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.STUNNED))     spr.tint = 0x88AACC;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.DAZED))       spr.tint = 0x9988AA;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.CURSED))      spr.tint = 0x992255;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.POISONED))    spr.tint = 0x40CC40;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.BERSERK))     spr.tint = 0xFF6644;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.DAMAGING))    spr.tint = 0xFFAA66;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.ARMORED))     spr.tint = 0x8899CC;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.SPEEDY))      spr.tint = 0xBBFF88;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.HEALING))     spr.tint = 0xFF8888;
            }
            addSpriteWithOutline(bb, tex, lx, ly, size, size);
            bb.addChild(spr);
        } else {
            const g = new PIXI.Graphics();
            g.beginFill(0xe04040);
            g.drawRect(lx, ly, size, size);
            g.endFill();
            bb.addChild(g);
        }

        // Enemy name — pooled (see player-name comment above)
        let enemyIconAnchorY = ly - 2;
        if (enemyDef) {
            const cxWorld = (enemy.pos.x || 0) + (enemy.size || PLAYER_SIZE) / 2;
            const cyWorld = (enemy.pos.y || 0) + (enemy.size || PLAYER_SIZE) / 2;
            const screen = this.worldToScreen(cxWorld, cyWorld, gameState);
            const nameText = this._acquireNameText('e:' + String(enemy.id), enemyDef.name || 'Enemy', 0xff8080);
            nameText.x = screen.x;
            nameText.y = screen.y + (ly - 2);
            enemyIconAnchorY = ly - 18;
        }

        if (enemy.effectIds && enemy.effectIds.length) {
            const cxWorld = (enemy.pos.x || 0) + (enemy.size || PLAYER_SIZE) / 2;
            const cyWorld = (enemy.pos.y || 0) + (enemy.size || PLAYER_SIZE) / 2;
            const sc = this.worldToScreen(cxWorld, cyWorld, gameState);
            this._drawStatusIcons(enemy.effectIds, sc.x, sc.y + enemyIconAnchorY);
        }

        this.entityLayer.addChild(bb);
    }

    // renderBullet removed — bullets are now batched inline in renderEntities()

    renderLootContainer(loot, angle, gameState) {
        const sx = loot.pos.x * SCALE;
        const sy = loot.pos.y * SCALE;
        const fullSize = this.tileSize * SCALE;
        const tier = loot.tier;
        const isChest = loot.isChest || tier === -1;
        const lootDef = gameState?.lootContainerDefs?.[tier];
        const renderFull = lootDef ? lootDef.fullSize : isChest;

        const size = renderFull ? fullSize : fullSize / 2;
        const ox = renderFull ? 0 : fullSize / 4;
        const oy = renderFull ? 0 : fullSize / 4;

        // Billboard container
        const bb = new PIXI.Container();
        bb.position.set(sx + ox + size / 2, sy + oy + size / 2);
        bb.rotation = -angle;
        const lx = -size / 2, ly = -size / 2;

        const shadowG = new PIXI.Graphics();
        shadowG.beginFill(0x000000, 0.3);
        shadowG.drawEllipse(0, size / 2 + size * 0.08, size * 0.35, size * 0.1);
        shadowG.endFill();
        bb.addChild(shadowG);

        let tex = null;
        if (lootDef) {
            tex = this.getRegion(lootDef.spriteKey.replace('.png', ''), lootDef.col, lootDef.row, BASE_SPRITE_SIZE, BASE_SPRITE_SIZE);
        } else if (isChest) {
            tex = this.getRegion('rotmg-projectiles', 2, 0, BASE_SPRITE_SIZE, BASE_SPRITE_SIZE);
        } else {
            const col = (tier >= 0 && tier < 5) ? tier : 0;
            tex = this.getRegion('rotmg-misc', col, 9, BASE_SPRITE_SIZE, BASE_SPRITE_SIZE);
        }

        if (tex) {
            const spr = new PIXI.Sprite(tex);
            spr.x = lx; spr.y = ly;
            spr.width = size; spr.height = size;
            bb.addChild(spr);
        } else {
            const g = new PIXI.Graphics();
            g.beginFill(isChest ? 0xc8a86e : 0x8b6914);
            g.drawRect(lx + 2, ly + 2, size - 4, size - 4);
            g.endFill();
            bb.addChild(g);
        }

        this.entityLayer.addChild(bb);
    }

    renderPortal(portal, angle, gameState) {
        const sx = portal.pos.x * SCALE;
        const sy = portal.pos.y * SCALE;
        const size = this.tileSize * SCALE;

        // Billboard container
        const bb = new PIXI.Container();
        bb.position.set(sx + size / 2, sy + size / 2);
        bb.rotation = -angle;
        const lx = -size / 2, ly = -size / 2;

        const portalDef = gameState ? gameState.portalData[portal.portalId] : null;
        let tex = null;
        if (portalDef && portalDef.spriteKey) {
            const sw = portalDef.spriteSize || BASE_SPRITE_SIZE;
            const sh = portalDef.spriteHeight || sw;
            tex = this.getRegion(portalDef.spriteKey, portalDef.col || 0,
                                 portalDef.row || 0, sw, sh);
        }

        const portalShadow = new PIXI.Graphics();
        portalShadow.beginFill(0x000000, 0.3);
        portalShadow.drawEllipse(0, size / 2 + size * 0.08, size * 0.4, size * 0.12);
        portalShadow.endFill();
        bb.addChild(portalShadow);

        if (tex) {
            const spr = new PIXI.Sprite(tex);
            spr.x = lx; spr.y = ly;
            spr.width = size; spr.height = size;
            bb.addChild(spr);
        } else {
            const g = new PIXI.Graphics();
            g.beginFill(0x8040c0, 0.6);
            g.drawCircle(0, 0, size / 2);
            g.endFill();
            g.lineStyle(2, 0xc080ff, 0.8);
            g.drawCircle(0, 0, size / 2);
            bb.addChild(g);
        }

        this.entityLayer.addChild(bb);
    }

    renderHealthBars(gameState, angle) {
        this.healthBarGraphics.clear();

        for (const [id, enemy] of gameState.enemies) {
            if (enemy.maxHealth <= 0) continue;
            const size = (enemy.size || PLAYER_SIZE) * SCALE;
            // Convert world position to screen position for unrotated UI layer
            const screen = this.worldToScreen(
                enemy.pos.x + (enemy.size || PLAYER_SIZE) / 2,
                enemy.pos.y + (enemy.size || PLAYER_SIZE) / 2,
                gameState
            );
            const barW = size;
            const barH = 4;
            const barX = screen.x - barW / 2;
            const barY = screen.y + size / 2 + 2;

            const pct = Math.max(0, enemy.health / enemy.maxHealth);

            this.healthBarGraphics.beginFill(0x333333);
            this.healthBarGraphics.drawRect(barX, barY, barW, barH);
            this.healthBarGraphics.endFill();

            this.healthBarGraphics.beginFill(pct > 0.5 ? 0x40c040 : pct > 0.25 ? 0xc0c040 : 0xc04040);
            this.healthBarGraphics.drawRect(barX, barY, barW * pct, barH);
            this.healthBarGraphics.endFill();
        }
    }

    renderVisualEffects(gameState, angle) {
        if (!gameState.visualEffects || gameState.visualEffects.length === 0) return;
        const now = Date.now();
        const g = new PIXI.Graphics();

        for (const fx of gameState.visualEffects) {
            const elapsed = now - fx.startTime;
            const progress = Math.min(elapsed / fx.duration, 1.0);
            const alpha = 1.0 - progress; // fade out over duration
            const screen = this.worldToScreen(fx.x, fx.y, gameState);
            const sx = screen.x;
            const sy = screen.y;
            const r = fx.radius * SCALE;

            switch (fx.type) {
                case 0: // HEAL_RADIUS — expanding green ring with shimmer
                    g.lineStyle(2, 0x40ff40, alpha * 0.7);
                    g.drawCircle(sx, sy, r * (0.5 + progress * 0.5));
                    g.lineStyle(0);
                    // Shimmer particles along ring
                    for (let i = 0; i < 8; i++) {
                        const a = (i / 8) * Math.PI * 2 + elapsed * 0.005;
                        const pr = r * (0.5 + progress * 0.5);
                        g.beginFill(0x80ff80, alpha * 0.5);
                        g.drawCircle(sx + Math.cos(a) * pr, sy + Math.sin(a) * pr, 3);
                        g.endFill();
                    }
                    break;

                case 1: // VAMPIRISM — inward-sucking purple/red particles
                    for (let i = 0; i < 12; i++) {
                        const a = (i / 12) * Math.PI * 2 + elapsed * 0.003;
                        const dist = r * (1.0 - progress); // particles move inward
                        const px = sx + Math.cos(a) * dist;
                        const py = sy + Math.sin(a) * dist;
                        g.beginFill(0xcc40cc, alpha * 0.6);
                        g.drawCircle(px, py, 2 + (1 - progress) * 2);
                        g.endFill();
                    }
                    // Inner glow
                    g.beginFill(0xff4040, alpha * 0.15);
                    g.drawCircle(sx, sy, r * 0.3 * (1 - progress));
                    g.endFill();
                    break;

                case 2: // STASIS_FIELD — frozen blue/white ring
                    g.lineStyle(3, 0x80c0ff, alpha * 0.8);
                    g.drawCircle(sx, sy, r);
                    g.lineStyle(1, 0xffffff, alpha * 0.4);
                    g.drawCircle(sx, sy, r * 0.85);
                    g.lineStyle(0);
                    // Ice crystal particles
                    for (let i = 0; i < 6; i++) {
                        const a = (i / 6) * Math.PI * 2 + elapsed * 0.002;
                        g.beginFill(0xc0e0ff, alpha * 0.5);
                        g.drawRect(sx + Math.cos(a) * r * 0.7 - 2, sy + Math.sin(a) * r * 0.7 - 2, 4, 4);
                        g.endFill();
                    }
                    break;

                case 3: { // CHAIN_LIGHTNING — electric arc between two points
                    const _ts = this.worldToScreen(fx.targetX, fx.targetY, gameState);
                    const tx = _ts.x, ty = _ts.y;
                    const dx = tx - sx, dy = ty - sy;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const segments = Math.max(4, Math.floor(dist / 10));
                    const perpX = -dy / dist, perpY = dx / dist;

                    // Outer glow — thick mystic blue
                    g.lineStyle(6, 0x2040a0, alpha * 0.35);
                    g.moveTo(sx, sy);
                    for (let i = 1; i < segments; i++) {
                        const t = i / segments;
                        const jitter = (Math.random() - 0.5) * 20 * alpha;
                        g.lineTo(sx + dx * t + perpX * jitter, sy + dy * t + perpY * jitter);
                    }
                    g.lineTo(tx, ty);
                    // Main bolt — medium mystic blue
                    g.lineStyle(3, 0x4080e0, alpha * 0.85);
                    g.moveTo(sx, sy);
                    for (let i = 1; i < segments; i++) {
                        const t = i / segments;
                        const jitter = (Math.random() - 0.5) * 14 * alpha;
                        g.lineTo(sx + dx * t + perpX * jitter, sy + dy * t + perpY * jitter);
                    }
                    g.lineTo(tx, ty);
                    // Bright core — lighter blue
                    g.lineStyle(1.5, 0x90c0ff, alpha * 0.7);
                    g.moveTo(sx, sy);
                    for (let i = 1; i < segments; i++) {
                        const t = i / segments;
                        const jitter = (Math.random() - 0.5) * 6 * alpha;
                        g.lineTo(sx + dx * t + perpX * jitter, sy + dy * t + perpY * jitter);
                    }
                    g.lineTo(tx, ty);
                    g.lineStyle(0);
                    break;
                }

                case 4: // CURSE_RADIUS — dark swirling particles
                    g.lineStyle(2, 0x8040a0, alpha * 0.5);
                    g.drawCircle(sx, sy, r);
                    g.lineStyle(0);
                    for (let i = 0; i < 10; i++) {
                        const a = (i / 10) * Math.PI * 2 + elapsed * 0.004;
                        const dr = r * (0.4 + 0.5 * Math.sin(elapsed * 0.006 + i));
                        g.beginFill(0x6020a0, alpha * 0.4);
                        g.drawCircle(sx + Math.cos(a) * dr, sy + Math.sin(a) * dr, 2);
                        g.endFill();
                    }
                    break;

                case 5: { // POISON — either throw arc (line) or splash (AoE)
                    const isThrow = fx.targetX !== undefined && fx.targetY !== undefined
                            && (fx.targetX !== 0 || fx.targetY !== 0) && r === 0;
                    if (isThrow) {
                        // Chunky parabolic vial throw arc (800ms flight)
                        const tx = this.worldToScreen(fx.targetX, fx.targetY, gameState).x;
                        const ty = this.worldToScreen(fx.targetX, fx.targetY, gameState).y;
                        const pdx = tx - sx, pdy = ty - sy;
                        const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
                        const arcH = pdist * 0.5;
                        const vialFrac = Math.min(progress, 1.0);
                        const steps = 20;

                        // Thick trail behind vial
                        for (let i = 0; i < steps; i++) {
                            const f0 = i / steps, f1 = (i + 1) / steps;
                            if (f1 > vialFrac) break;
                            const x0 = sx + pdx * f0, y0 = sy + pdy * f0 - 4 * arcH * f0 * (1 - f0);
                            const x1 = sx + pdx * f1, y1 = sy + pdy * f1 - 4 * arcH * f1 * (1 - f1);
                            const thick = 2 + 6 * (f1 / Math.max(vialFrac, 0.01));
                            const ta = 0.15 + 0.4 * (f1 / Math.max(vialFrac, 0.01));
                            g.lineStyle(thick, 0x339920, ta);
                            g.moveTo(x0, y0);
                            g.lineTo(x1, y1);
                        }
                        g.lineStyle(0);

                        // Dripping particles
                        for (let i = 0; i < 5; i++) {
                            const pf = vialFrac * (0.3 + 0.7 * i / 5);
                            const px2 = sx + pdx * pf;
                            const py2 = sy + pdy * pf - 4 * arcH * pf * (1 - pf);
                            const dripOff = progress * 20 * (i + 1) / 5;
                            const da = Math.max(0, 0.5 - progress * 0.6);
                            if (da > 0) {
                                g.beginFill(0x2a8818, da);
                                g.drawRect(px2 - 2, py2 + dripOff, 4, 3 + i);
                                g.endFill();
                            }
                        }

                        // Fat vial blob
                        if (vialFrac < 1.0) {
                            const vx = sx + pdx * vialFrac;
                            const vy = sy + pdy * vialFrac - 4 * arcH * vialFrac * (1 - vialFrac);
                            g.beginFill(0x30771a, 0.4);
                            g.drawCircle(vx, vy, 10);
                            g.endFill();
                            g.beginFill(0x40cc30, 0.9);
                            g.drawCircle(vx, vy, 7);
                            g.endFill();
                            g.beginFill(0x90ff70, 0.7);
                            g.drawCircle(vx - 2, vy - 2, 3);
                            g.endFill();
                        }
                    } else {
                        // AoE poison splash cloud
                        g.lineStyle(2, 0x40cc40, alpha * 0.7);
                        g.drawCircle(sx, sy, r * (0.3 + progress * 0.7));
                        g.lineStyle(1, 0x30aa30, alpha * 0.4);
                        g.drawCircle(sx, sy, r * (0.5 + progress * 0.3));
                        g.lineStyle(0);
                        for (let i = 0; i < 10; i++) {
                            const a = (i / 10) * Math.PI * 2 + elapsed * 0.003;
                            const dist2 = r * 0.5 * (1.0 - progress * 0.3);
                            g.beginFill(0x30aa30, alpha * 0.5);
                            g.drawCircle(sx + Math.cos(a) * dist2, sy + Math.sin(a) * dist2, 3);
                            g.endFill();
                        }
                    }
                    break;
                }

                case 6: { // TRAP — thrown arc (grenade) then persistent ground ring
                    const isThrow = fx.targetX !== undefined && fx.targetY !== undefined
                            && (fx.targetX !== 0 || fx.targetY !== 0) && r === 0;
                    if (isThrow) {
                        // Parabolic trap throw arc (800ms flight)
                        const tx = this.worldToScreen(fx.targetX, fx.targetY, gameState).x;
                        const ty = this.worldToScreen(fx.targetX, fx.targetY, gameState).y;
                        const pdx = tx - sx, pdy = ty - sy;
                        const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
                        const arcH = pdist * 0.5;
                        const trapFrac = Math.min(progress, 1.0);
                        const steps = 20;

                        // Amber trail behind trap
                        for (let i = 0; i < steps; i++) {
                            const f0 = i / steps, f1 = (i + 1) / steps;
                            if (f1 > trapFrac) break;
                            const x0 = sx + pdx * f0, y0 = sy + pdy * f0 - 4 * arcH * f0 * (1 - f0);
                            const x1 = sx + pdx * f1, y1 = sy + pdy * f1 - 4 * arcH * f1 * (1 - f1);
                            const thick = 1 + 3 * (f1 / Math.max(trapFrac, 0.01));
                            const ta = 0.1 + 0.3 * (f1 / Math.max(trapFrac, 0.01));
                            g.lineStyle(thick, 0x996622, ta);
                            g.moveTo(x0, y0);
                            g.lineTo(x1, y1);
                        }
                        g.lineStyle(0);

                        // Spinning trap object
                        if (trapFrac < 1.0) {
                            const vx = sx + pdx * trapFrac;
                            const vy = sy + pdy * trapFrac - 4 * arcH * trapFrac * (1 - trapFrac);
                            g.beginFill(0x664411, 0.5);
                            g.drawCircle(vx, vy, 9);
                            g.endFill();
                            g.beginFill(0xcc8833, 0.9);
                            g.drawCircle(vx, vy, 6);
                            g.endFill();
                            // Teeth marks on the trap
                            for (let i = 0; i < 4; i++) {
                                const a = (i / 4) * Math.PI * 2 + elapsed * 0.01;
                                g.beginFill(0xffcc44, 0.8);
                                g.drawRect(vx + Math.cos(a) * 4 - 1, vy + Math.sin(a) * 4 - 1, 2, 2);
                                g.endFill();
                            }
                        }
                    } else {
                        // Persistent ground trap ring — stays mostly opaque, pulses
                        const pulse = 0.7 + 0.3 * Math.sin(elapsed * 0.004);
                        const fadeAlpha = progress > 0.85 ? (1.0 - progress) / 0.15 : 1.0;

                        // Outer ring
                        g.lineStyle(3, 0xcc8833, fadeAlpha * pulse * 0.8);
                        g.drawCircle(sx, sy, r);
                        // Inner ring
                        g.lineStyle(1, 0xffaa44, fadeAlpha * pulse * 0.5);
                        g.drawCircle(sx, sy, r * 0.75);
                        g.lineStyle(0);

                        // Semi-transparent fill
                        g.beginFill(0xcc6600, fadeAlpha * 0.1);
                        g.drawCircle(sx, sy, r);
                        g.endFill();

                        // Rotating teeth/spikes around the ring
                        const teeth = 8;
                        for (let i = 0; i < teeth; i++) {
                            const a = (i / teeth) * Math.PI * 2 + elapsed * 0.002;
                            const tr = r * 0.9;
                            g.beginFill(0xffcc44, fadeAlpha * pulse * 0.7);
                            g.drawPolygon([
                                sx + Math.cos(a) * (tr - 4), sy + Math.sin(a) * (tr - 4),
                                sx + Math.cos(a - 0.1) * (tr + 4), sy + Math.sin(a - 0.1) * (tr + 4),
                                sx + Math.cos(a + 0.1) * (tr + 4), sy + Math.sin(a + 0.1) * (tr + 4)
                            ]);
                            g.endFill();
                        }

                        // Center marker
                        g.beginFill(0xffaa44, fadeAlpha * pulse * 0.4);
                        g.drawCircle(sx, sy, 3);
                        g.endFill();
                    }
                    break;
                }

                case 7: { // TRAP_PLACED — persistent armed trap ring (same as case 6 AoE)
                    const pulse = 0.7 + 0.3 * Math.sin(elapsed * 0.004);
                    const fadeAlpha = progress > 0.85 ? (1.0 - progress) / 0.15 : 1.0;
                    g.lineStyle(3, 0xcc8833, fadeAlpha * pulse * 0.8);
                    g.drawCircle(sx, sy, r);
                    g.lineStyle(1, 0xffaa44, fadeAlpha * pulse * 0.5);
                    g.drawCircle(sx, sy, r * 0.75);
                    g.lineStyle(0);
                    g.beginFill(0xcc6600, fadeAlpha * 0.1);
                    g.drawCircle(sx, sy, r);
                    g.endFill();
                    const teeth = 8;
                    for (let i = 0; i < teeth; i++) {
                        const a = (i / teeth) * Math.PI * 2 + elapsed * 0.002;
                        const tr = r * 0.9;
                        g.beginFill(0xffcc44, fadeAlpha * pulse * 0.7);
                        g.drawPolygon([
                            sx + Math.cos(a) * (tr - 4), sy + Math.sin(a) * (tr - 4),
                            sx + Math.cos(a - 0.1) * (tr + 4), sy + Math.sin(a - 0.1) * (tr + 4),
                            sx + Math.cos(a + 0.1) * (tr + 4), sy + Math.sin(a + 0.1) * (tr + 4)
                        ]);
                        g.endFill();
                    }
                    g.beginFill(0xffaa44, fadeAlpha * pulse * 0.4);
                    g.drawCircle(sx, sy, 3);
                    g.endFill();
                    break;
                }

                case 8: { // TRAP_TRIGGER — closing circle snap + flash
                    // Circle rapidly closes inward then flashes
                    const closeR = r * (1.0 - progress);
                    const flashAlpha = progress < 0.3 ? 1.0 : Math.max(0, 1.0 - (progress - 0.3) / 0.7);
                    // Closing amber ring
                    g.lineStyle(4, 0xff8800, flashAlpha * 0.9);
                    g.drawCircle(sx, sy, closeR);
                    g.lineStyle(2, 0xffcc44, flashAlpha * 0.6);
                    g.drawCircle(sx, sy, closeR * 0.7);
                    g.lineStyle(0);
                    // Flash fill at moment of snap
                    if (progress < 0.2) {
                        g.beginFill(0xffaa00, (0.2 - progress) * 3);
                        g.drawCircle(sx, sy, r);
                        g.endFill();
                    }
                    // Inward-rushing particles
                    for (let i = 0; i < 8; i++) {
                        const a = (i / 8) * Math.PI * 2;
                        const pr = closeR + 8;
                        g.beginFill(0xffcc44, flashAlpha * 0.7);
                        g.drawCircle(sx + Math.cos(a) * pr, sy + Math.sin(a) * pr, 2);
                        g.endFill();
                    }
                    break;
                }
            }
        }

        this.uiLayer.addChild(g);
    }

    renderDamageTexts(gameState, angle) {
        const TEXT_LIFE = 50; // must match game.js
        for (const dt of gameState.damageTexts) {
            const screen = this.worldToScreen(dt.x, dt.y, gameState);
            const sx = screen.x;
            const sy = screen.y + (dt.screenOffY || 0);
            const alpha = Math.max(0, dt.life / TEXT_LIFE);
            const colorStr = '#' + dt.color.toString(16).padStart(6, '0');
            // Scale text slightly larger when fresh, shrink as it fades
            const scale = 0.8 + 0.4 * (dt.life / TEXT_LIFE);
            const txt = this._acquireDamageText(dt.text, colorStr);
            txt.x = sx; txt.y = sy;
            txt.alpha = alpha;
            txt.scale.set(scale);
        }
    }

    // Status effect icon definitions: [effectId, symbol, color]
    static STATUS_ICON_DEFS = [
        [StatusEffect.HEALING,      '+', 0xFF4444],   // red medical cross
        [StatusEffect.BERSERK,      'X', 0xFF6644],   // crossed swords / berserk
        [StatusEffect.SPEEDY,       '>', 0x44FF44],   // green arrow / speed boost
        [StatusEffect.INVINCIBLE,   'O', 0x44AAFF],   // blue shield / invulnerable
        [StatusEffect.ARMORED,      'A', 0x6688CC],   // blue-grey armor
        [StatusEffect.DAMAGING,     '!', 0xFFAA44],   // orange damage boost
        [StatusEffect.PARALYZED,    '=', 0x888888],   // grey paralysis
        [StatusEffect.STUNNED,      '*', 0x88CCFF],   // blue stun stars
        [StatusEffect.SLOWED,       'v', 0x6688FF],   // blue slow arrow
        [StatusEffect.POISONED,     '~', 0x40CC40],   // green poison
        [StatusEffect.CURSED,       'C', 0xAA2255],   // purple curse
        [StatusEffect.DAZED,        '?', 0x9988AA],   // purple daze
        [StatusEffect.STASIS,       '#', 0x444448],   // dark stasis
        [StatusEffect.ARMOR_BROKEN, 'V', 0x7060CC],   // purple broken armor
        [StatusEffect.INVISIBLE,    'I', 0xCCBB88],   // tan invisibility
    ];

    /**
     * Draw status effect icons above an entity at the given position.
     * Icons are small colored squares with a letter symbol, arranged in a row.
     * @param {number[]} effectIds - array of active effect IDs
     * @param {number} centerX - center X position (screen coords)
     * @param {number} topY - Y position above which icons are drawn
     */
    /** Draws status icons centered on (screenCenterX, screenTopY-iconSize-2),
     *  matching the original placement which was relative to the billboarded
     *  bb container. Now pooled via _acquireStatusIcon → no per-frame Graphics
     *  or PIXI.Text allocation. */
    _drawStatusIcons(effectIds, screenCenterX, screenTopY) {
        if (!effectIds || !effectIds.length) return;
        const active = [];
        for (const [eid, sym, color] of GameRenderer.STATUS_ICON_DEFS) {
            if (this._hasEffect(effectIds, eid)) active.push({ sym, color });
        }
        if (active.length === 0) return;

        const iconSize = 12;
        const iconGap = 2;
        const totalWidth = active.length * iconSize + (active.length - 1) * iconGap;
        let startX = screenCenterX - totalWidth / 2;
        const y = screenTopY - iconSize - 2;

        for (const { sym, color } of active) {
            const { bg, label } = this._acquireStatusIcon(sym);
            bg.beginFill(0x000000, 0.6);
            bg.drawRoundedRect(startX, y, iconSize, iconSize, 2);
            bg.endFill();
            bg.beginFill(color, 0.9);
            bg.drawRoundedRect(startX + 1, y + 1, iconSize - 2, iconSize - 2, 1);
            bg.endFill();
            label.x = startX + iconSize / 2;
            label.y = y + iconSize / 2;
            startX += iconSize + iconGap;
        }
    }

    /**
     * Check if an entity's center is on a slowing tile (water, lava, etc).
     * Used for the wading visual effect.
     */
    _isEntityOnSlowTile(entity, gameState) {
        if (!gameState.mapTiles || !gameState.tileData) return false;
        const ts = gameState.tileSize || 32;
        const entSize = entity.size || PLAYER_SIZE;
        const cx = Math.floor((entity.pos.x + entSize / 2) / ts);
        const cy = Math.floor((entity.pos.y + entSize / 2) / ts);
        if (cx < 0 || cx >= (gameState.mapWidth || 0) || cy < 0 || cy >= (gameState.mapHeight || 0)) return false;
        const tile = gameState.mapTiles[cy]?.[cx];
        if (!tile || tile.base <= 0) return false;
        const tileDef = gameState.tileData[tile.base];
        return !!(tileDef?.data?.slows);
    }

    // Check if an effect ID is present in an entity's effect array
    _hasEffect(effectIds, effectId) {
        if (!effectIds || !effectIds.length) return false;
        for (const id of effectIds) {
            if (id < 0) continue; // -1 = empty slot
            if (id === effectId) return true;
        }
        return false;
    }

    getTileFallbackColor(tileId) {
        // Simple hash for consistent colors
        const colors = [0x3a6b35, 0x4a7a45, 0x5a8a55, 0x6a5a40, 0x7a6a50,
                        0x404040, 0x505050, 0x2060a0, 0x8a7a60, 0x605030];
        return colors[Math.abs(tileId) % colors.length];
    }

    // Extract a sprite region as a data URL for use in HTML elements
    getSpriteDataUrl(spriteKey, col, row, spriteSize, spriteHeight) {
        const sw = spriteSize || BASE_SPRITE_SIZE;
        const sh = spriteHeight || sw;
        const tex = this.getRegion(spriteKey, col, row, sw, sh);
        if (!tex || !this.app) return null;
        try {
            const tempSprite = new PIXI.Sprite(tex);
            const rt = PIXI.RenderTexture.create({ width: sw, height: sh });
            this.app.renderer.render(tempSprite, { renderTexture: rt });
            const canvas = this.app.renderer.extract.canvas(rt);
            const url = canvas.toDataURL();
            rt.destroy();
            tempSprite.destroy();
            return url;
        } catch (e) { return null; }
    }

    destroy() {
        if (this.app) {
            this.app.destroy(true, { children: true, texture: false });
            this.app = null;
        }
    }

    getWorldCoords(screenX, screenY, gameState) {
        const screenW = this.app.screen.width;
        const screenH = this.app.screen.height;
        const angle = gameState.cameraAngle || 0;

        // Offset from screen center
        const dx = screenX - screenW / 2;
        const dy = screenY - screenH / 2;

        // Un-rotate by camera angle to get world-space offset
        const cos = Math.cos(-angle);
        const sin = Math.sin(-angle);
        const worldDx = (dx * cos - dy * sin) / SCALE;
        const worldDy = (dx * sin + dy * cos) / SCALE;

        // Pivot is at player center (cameraX/Y + half player size)
        const localPlayer = gameState.getLocalPlayer();
        const halfSize = (localPlayer?.size || PLAYER_SIZE) / 2;

        return {
            x: gameState.cameraX + halfSize + worldDx,
            y: gameState.cameraY + halfSize + worldDy
        };
    }

    /** Convert world position to screen position, accounting for camera rotation. */
    worldToScreen(worldX, worldY, gameState) {
        const screenW = this.app.screen.width;
        const screenH = this.app.screen.height;
        const angle = gameState.cameraAngle || 0;

        // Pivot is at player center (cameraX/Y + half player size)
        const localPlayer = gameState.getLocalPlayer();
        const halfSize = (localPlayer?.size || PLAYER_SIZE) / 2;
        const pivotX = gameState.cameraX + halfSize;
        const pivotY = gameState.cameraY + halfSize;

        const dx = (worldX - pivotX) * SCALE;
        const dy = (worldY - pivotY) * SCALE;

        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        return {
            x: screenW / 2 + dx * cos - dy * sin,
            y: screenH / 2 + dx * sin + dy * cos
        };
    }

    /**
     * Return a PixiJS hex color for a player name based on their chatRole.
     */
    static getNameColorHex(chatRole) {
        switch (chatRole) {
            case 'sysadmin': return 0xff4040;
            case 'admin':    return 0xc8a86e;
            case 'mod':      return 0xa040c0;
            case 'demo':     return 0xcccccc;
            default:         return 0x4080e0;
        }
    }

    /**
     * Return a CSS color string for a player name based on their chatRole.
     */
    static getNameColorCSS(chatRole) {
        switch (chatRole) {
            case 'sysadmin': return '#ff4040';
            case 'admin':    return '#c8a86e';
            case 'mod':      return '#a040c0';
            case 'demo':     return '#cccccc';
            default:         return '#4080e0';
        }
    }
}
