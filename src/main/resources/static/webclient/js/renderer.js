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
        // Last position where tile layer was built; rebuild only when player
        // has moved past REBUILD_THRESHOLD tiles from this center.
        this._tileBuildCenter = null;

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

        // ---- Entity pool ----
        // Per-entity persistent containers + pre-allocated children (shadow,
        // body sprite, outline sprites, HP/MP bars, optional wading mask).
        // Replaces the old destroy-and-recreate-every-frame model that caused
        // GC hitches in dense combat. Keys: 'p:'+id (player), 'e:'+id (enemy),
        // 'l:'+id (loot), 'po:'+id (portal).
        this._entityPool = new Map();
        this._entityFrameId = 0;

        // ---- Y-sort buffer ----
        // Reused per frame; entries are pulled from a record pool to avoid
        // per-frame {type,data,y} object allocation.
        this._sortBuf = [];
        this._sortRecPool = [];
        this._sortRecIdx = 0;

        // ---- Bullet pool ----
        // Fixed-size pool of PIXI.Sprite — bullets toggle .visible instead of
        // being destroyed/recreated. Created lazily in init() so we know
        // MAX_RENDERED_BULLETS before allocation.
        this._bulletPool = [];
        this._bulletFallbackGfx = null;

        // ---- Persistent VFX graphics ----
        // One PIXI.Graphics that stays in uiLayer; cleared at start of
        // renderVisualEffects and redrawn in place. Replaces per-frame
        // `new PIXI.Graphics()` in the visual-effects block.
        this._fxGraphics = null;
    }

    /** Force tile layer rebuild on next frame. Safe to call frequently —
     *  it does NOT touch the entity pool. The server streams LoadMapPacket
     *  at ~4 Hz to deliver incremental tile data on the same map; before
     *  this was decoupled, every one of those packets nuked every pooled
     *  entity (the cause of the per-second blinking the user reported). */
    invalidateTileCache() {
        this._tileCacheKey = null;
        this._tileBuildCenter = null;
        this._billboardSprites = [];
    }

    /** Reset for an actual realm/map change: drop all pooled entities AND
     *  invalidate the tile cache. Different entities exist in the new realm
     *  and stale containers would linger as invisible (until the periodic
     *  prune) which is wasteful for a large transition. */
    prepareForNewRealm() {
        this._reapEntityPool(true);
        this.invalidateTileCache();
    }

    /** Static y-sort comparator — hoisted to avoid per-frame closure alloc. */
    static SORT_BY_Y(a, b) { return a.y - b.y; }

    /** Acquire a sort-record from the pool (or create one). Reset by
     *  resetting _sortRecIdx to 0 each frame. */
    _acquireSortRec() {
        let r = this._sortRecPool[this._sortRecIdx];
        if (!r) {
            r = { type: 0, data: null, id: 0, y: 0 };
            this._sortRecPool[this._sortRecIdx] = r;
        }
        this._sortRecIdx++;
        return r;
    }

    /** Acquire (or create) a pooled entity entry by key. The entry is a
     *  persistent PIXI.Container plus pre-allocated children. Children are
     *  built the first time the entity is seen (with `hasOutlines` controlling
     *  whether 4 outline sprites are pre-allocated for player/enemy entities).
     *  On subsequent frames, callers mutate position/texture/tint in place
     *  rather than allocating new PIXI objects. */
    _acquireEntity(key, hasOutlines) {
        let e = this._entityPool.get(key);
        if (e) {
            e.lastSeenFrame = this._entityFrameId;
            e.bb.visible = true;
            return e;
        }
        const bb = new PIXI.Container();
        const shadow = new PIXI.Graphics();
        const body = new PIXI.Sprite();
        bb.addChild(shadow);
        const outlines = [];
        if (hasOutlines) {
            for (let i = 0; i < 4; i++) {
                const ol = new PIXI.Sprite();
                ol.tint = OUTLINE_TINT;
                ol.alpha = OUTLINE_ALPHA;
                bb.addChild(ol);
                outlines.push(ol);
            }
        }
        bb.addChild(body);
        // Bars + mask created lazily — only player needs bars, only wading
        // entities need a mask. Saves ~3 PIXI objects per entity until used.
        e = {
            bb, shadow, body, outlines,
            bars: null, mask: null,
            cachedTex: null, cachedTint: -1,
            cachedFlipX: null, cachedWading: null,
            cachedShadowSize: -1,
            shadowKind: null, // 'pe' (player/enemy ellipse) | 'l' (loot) | 'po' (portal)
            hasOutlines,
            lastSeenFrame: this._entityFrameId,
        };
        this._entityPool.set(key, e);
        this.entityLayer.addChild(bb);
        return e;
    }

    /** Hide entity-pool entries not seen this frame, and periodically reap
     *  long-stale entries (e.g. enemies that have left the realm). */
    _reapEntityPool(forceAll) {
        if (forceAll) {
            for (const [, e] of this._entityPool) this._destroyEntity(e);
            this._entityPool.clear();
            return;
        }
        // Hide-on-miss every frame so stale containers don't show last-frame
        // position when an entity briefly drops out of the visible set.
        for (const e of this._entityPool.values()) {
            if (e.lastSeenFrame !== this._entityFrameId) {
                e.bb.visible = false;
            }
        }
        // Periodic prune to bound memory across long sessions.
        if ((this._entityFrameId & 255) === 0) {
            const cutoff = this._entityFrameId - 600; // ~10 seconds at 60fps
            for (const [k, e] of this._entityPool) {
                if (e.lastSeenFrame < cutoff) {
                    this._destroyEntity(e);
                    this._entityPool.delete(k);
                }
            }
        }
    }

    _destroyEntity(e) {
        if (!e || !e.bb) return;
        if (e.bb.parent) e.bb.parent.removeChild(e.bb);
        try { e.bb.destroy({ children: true }); } catch (_) {}
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
                fontSize: 11, fill: 0xFFFFFF,
                fontFamily: 'OryxSimplex, monospace', fontWeight: 'bold',
                stroke: 0x000000, strokeThickness: 2
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

        // Persistent VFX graphics — cleared and redrawn each frame in place.
        this._fxGraphics = new PIXI.Graphics();
        this.uiLayer.addChild(this._fxGraphics);
        // Keep healthbars and text container above VFX
        this.uiLayer.addChild(this.healthBarGraphics);
        this.uiLayer.addChild(this._textContainer);

        // Pre-allocate bullet sprite pool. Sized to match the cap in
        // renderEntities (MAX_RENDERED_BULLETS). Sprites stay parented to
        // entityLayer; we toggle .visible per frame and reuse texture/position.
        const BULLET_POOL_SIZE = 256;
        for (let i = 0; i < BULLET_POOL_SIZE; i++) {
            const s = new PIXI.Sprite();
            s.anchor.set(0.5, 0.5);
            s.visible = false;
            this._bulletPool.push(s);
        }
        // Persistent fallback graphics for bullets that have no sprite texture.
        this._bulletFallbackGfx = new PIXI.Graphics();
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

    /**
     * Returns a dye-recolored texture for a class sprite cell. Falls back to
     * the unmodified getRegion if no mask or no dye is set. Caches the
     * dyed canvas/texture per (classId, row, col, dyeId) so we only recolor
     * each unique sprite once.
     *
     * The dye is resolved through gameState.dyeAssets (keyed by dyeId) so a
     * "dye" can be any recolor strategy — solid color today, patterned cloths
     * later. For solid-color dyes we hue-shift each masked pixel toward the
     * dye color while preserving the original luminance, so shading stays.
     */
    getDyedRegion(textureKey, classId, col, row, w, h, dyeId, gameState) {
        if (!dyeId || dyeId === 0) return this.getRegion(textureKey, col, row, w, h);
        const dye = gameState && gameState.dyeAssets && gameState.dyeAssets[dyeId];
        if (!dye) return this.getRegion(textureKey, col, row, w, h);
        const frameKey = `${classId}:${row}:${col}`;
        const frame = gameState && gameState.classMaskFrameIndex && gameState.classMaskFrameIndex[frameKey];
        if (!frame || !frame.mask) return this.getRegion(textureKey, col, row, w, h);

        if (!this._dyeTexCache) this._dyeTexCache = {};
        const cacheKey = `${classId}:${row}:${col}:${dyeId}`;
        if (this._dyeTexCache[cacheKey]) return this._dyeTexCache[cacheKey];

        const key = textureKey.replace('.png', '');
        const tex = this.textures[key];
        if (!tex) return null;
        const src = tex.baseTexture.resource && tex.baseTexture.resource.source;
        if (!src) return this.getRegion(textureKey, col, row, w, h);

        // Render the source cell into an offscreen canvas at 1:1 so we can
        // sample/edit pixels.
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        try {
            ctx.drawImage(src, col * w, row * h, w, h, 0, 0, w, h);
        } catch (e) {
            // Possible cross-origin canvas taint — bail to original.
            return this.getRegion(textureKey, col, row, w, h);
        }
        let imgData;
        try { imgData = ctx.getImageData(0, 0, w, h); }
        catch (e) { return this.getRegion(textureKey, col, row, w, h); }
        const pixels = imgData.data;
        // Solid-color path: HSL hue/sat shift on every masked pixel that
        // isn't transparent. Future dye types ("pattern", "gradient") branch
        // off the dye.type field.
        if (dye.type === 'solid') {
            const dr = (dye.color >> 16) & 0xff;
            const dg = (dye.color >> 8) & 0xff;
            const db = dye.color & 0xff;
            for (let y = 0; y < h; y++) {
                const maskRow = frame.mask[y];
                if (!maskRow) continue;
                for (let x = 0; x < w; x++) {
                    const v = maskRow[x];
                    if (!v) continue; // 0 = no recolor
                    const i = (y * w + x) * 4;
                    if (pixels[i + 3] === 0) continue;
                    // Preserve luminance: scale dye color so that the painted
                    // pixel keeps the original brightness. This matches what
                    // the editor's preview does.
                    const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
                    // Average dye luminance is just for normalization — clamp
                    // each channel scaled by (lum / 128) so darker source
                    // pixels stay dark and lighter ones stay light.
                    const scale = lum / 128;
                    pixels[i] = Math.min(255, Math.max(0, dr * scale));
                    pixels[i + 1] = Math.min(255, Math.max(0, dg * scale));
                    pixels[i + 2] = Math.min(255, Math.max(0, db * scale));
                }
            }
        }
        // Sprite-overlay path: dye is an 8×8 sprite cell that gets composited
        // through the same mask. Useful for patterned cloths (plaid, stripes,
        // gradients) — drop the sprite into the mask region and the per-class
        // mask still controls which pixels get painted.
        if (dye.type === 'sprite' && dye.spriteKey) {
            const dyeKey = dye.spriteKey.replace('.png', '');
            const dyeTex = this.textures[dyeKey];
            const dyeSrc = dyeTex && dyeTex.baseTexture.resource && dyeTex.baseTexture.resource.source;
            if (dyeSrc) {
                const dRow = dye.row || 0, dCol = dye.col || 0;
                const dW = dye.spriteSize || w, dH = dye.spriteHeight || dye.spriteSize || h;
                const overlay = document.createElement('canvas');
                overlay.width = w; overlay.height = h;
                const oCtx = overlay.getContext('2d');
                oCtx.imageSmoothingEnabled = false;
                try {
                    // Stretch / center the dye cell over the mask region. For
                    // 8x8 dye + 8x8 mask this is a 1:1 copy; non-matching
                    // sizes get nearest-neighbor scaled.
                    oCtx.drawImage(dyeSrc, dCol * dW, dRow * dH, dW, dH, 0, 0, w, h);
                    const overlayData = oCtx.getImageData(0, 0, w, h).data;
                    for (let y = 0; y < h; y++) {
                        const maskRow = frame.mask[y];
                        if (!maskRow) continue;
                        for (let x = 0; x < w; x++) {
                            const v = maskRow[x];
                            if (!v) continue;
                            const i = (y * w + x) * 4;
                            if (pixels[i + 3] === 0) continue;
                            const oa = overlayData[i + 3];
                            if (oa === 0) continue;
                            // Multiply original luminance by the overlay
                            // color, same brightness preservation as the
                            // solid path so shading carries through.
                            const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
                            const scale = lum / 128;
                            pixels[i] = Math.min(255, overlayData[i] * scale);
                            pixels[i + 1] = Math.min(255, overlayData[i + 1] * scale);
                            pixels[i + 2] = Math.min(255, overlayData[i + 2] * scale);
                        }
                    }
                } catch (e) {
                    // Fallthrough — keep original sprite if the overlay sheet
                    // is cross-origin tainted or missing.
                }
            }
        }
        ctx.putImageData(imgData, 0, 0);
        const dyedTex = PIXI.Texture.from(canvas);
        dyedTex.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
        this._dyeTexCache[cacheKey] = dyedTex;
        return dyedTex;
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

        // Clear UI layer (damage text, etc.) - keep healthbar graphics, the
        // persistent VFX graphics, and the pooled-text container.
        const keepers = [this.healthBarGraphics, this._fxGraphics, this._textContainer];
        for (let i = this.uiLayer.children.length - 1; i >= 0; i--) {
            const child = this.uiLayer.children[i];
            if (keepers.indexOf(child) !== -1) continue;
            this.uiLayer.removeChildAt(i);
            child.destroy();
        }
        // Ensure all keepers are present and z-ordered: VFX under healthbars under text.
        if (this._fxGraphics.parent !== this.uiLayer) this.uiLayer.addChild(this._fxGraphics);
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

        // Build a region LARGER than the visible viewport, then only rebuild
        // when the player has moved past the rebuild threshold from the last
        // build center. Without this padding, every tile-boundary crossing
        // (~1/sec at running speed) destroyed and re-allocated ~2000 PIXI
        // objects, causing visible stalls and entity-render choppiness.
        const REBUILD_THRESHOLD = 8; // tiles of movement before rebuild
        const BUILD_PADDING = REBUILD_THRESHOLD + 2; // extra cached tiles
        const center = this._tileBuildCenter;
        const needsRebuild = !center
            || Math.abs(playerTileX - center.x) > REBUILD_THRESHOLD
            || Math.abs(playerTileY - center.y) > REBUILD_THRESHOLD
            || center.range !== range;

        if (needsRebuild) {
            this._tileBuildCenter = { x: playerTileX, y: playerTileY, range };
            const buildRange = range + BUILD_PADDING;
            const minR = Math.max(0, playerTileY - buildRange);
            const maxR = Math.min(gameState.mapHeight - 1, playerTileY + buildRange);
            const minC = Math.max(0, playerTileX - buildRange);
            const maxC = Math.min(gameState.mapWidth - 1, playerTileX + buildRange);
            this._tileCacheKey = `${minR},${maxR},${minC},${maxC},${gameState.mapWidth}`;
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
        // Pool-based rendering: containers are persistent across frames,
        // children are mutated in place, and we y-sort by reordering existing
        // children rather than destroying and recreating everything.
        this._entityFrameId++;

        // Reuse y-sort buffer + record pool; static comparator avoids closure alloc.
        const buf = this._sortBuf;
        buf.length = 0;
        this._sortRecIdx = 0;

        for (const [id, loot] of gameState.lootContainers) {
            const r = this._acquireSortRec();
            r.type = 0; r.data = loot; r.id = id;
            r.y = loot.pos.y + (loot.size || 32);
            buf.push(r);
        }
        for (const [id, portal] of gameState.portals) {
            const r = this._acquireSortRec();
            r.type = 1; r.data = portal; r.id = id;
            r.y = portal.pos.y + (portal.size || 32);
            buf.push(r);
        }
        for (const [id, enemy] of gameState.enemies) {
            // Skip dead enemies. Server's UnloadPacket can lag under heavy
            // load (1000+ enemy stress test), leaving zero-HP corpses in the
            // map for several seconds. Client-side predicted hits set
            // health=0 immediately — hide them right away so the screen
            // doesn't fill with phantom sprites waiting to be unloaded.
            if (enemy.maxHealth > 0 && enemy.health <= 0) continue;
            const r = this._acquireSortRec();
            r.type = 2; r.data = enemy; r.id = id;
            r.y = enemy.pos.y + (enemy.size || 32);
            buf.push(r);
        }
        for (const [id, player] of gameState.players) {
            const r = this._acquireSortRec();
            r.type = 3; r.data = player; r.id = id;
            r.y = player.pos.y + (player.size || 32);
            buf.push(r);
        }
        buf.sort(GameRenderer.SORT_BY_Y);

        // Render each entity into its pooled container. The pool key is built
        // from the Map iteration key (ent.id), not from data.id — they only
        // sometimes match (lootContainers is keyed by lootContainerId, not
        // by an `id` property). The pool entry is acquired here so the same
        // key is guaranteed during re-add below.
        for (const ent of buf) {
            const hasOutlines = ent.type === 2 || ent.type === 3;
            const key = ent.type === 0 ? 'l:' + ent.id
                      : ent.type === 1 ? 'po:' + ent.id
                      : ent.type === 2 ? 'e:' + ent.id
                      : 'p:' + ent.id;
            const e = this._acquireEntity(key, hasOutlines);
            if (ent.type === 0) this.renderLootContainer(ent.data, angle, gameState, e);
            else if (ent.type === 1) this.renderPortal(ent.data, angle, gameState, e);
            else if (ent.type === 2) this.renderEnemy(ent.data, angle, gameState, e);
            else if (ent.type === 3) this.renderPlayer(ent.data, angle, ent.id === gameState.playerId, gameState, e);
        }

        // Re-order entityLayer children in y-sorted order. removeChildren
        // unparents but does NOT destroy — cheap. We then re-add visible
        // pooled containers in sorted order, followed by bullet pool sprites.
        this.entityLayer.removeChildren();
        for (const ent of buf) {
            const key = ent.type === 0 ? 'l:' + ent.id
                      : ent.type === 1 ? 'po:' + ent.id
                      : ent.type === 2 ? 'e:' + ent.id
                      : 'p:' + ent.id;
            const e = this._entityPool.get(key);
            if (e && e.bb.visible) this.entityLayer.addChild(e.bb);
        }

        // Render bullets via the persistent bullet sprite pool. Sprites stay
        // alive across frames; we just toggle .visible and update tex/pos/rot.
        // Replaces the old per-frame `new PIXI.Sprite()` per visible bullet.
        if (!this._bulletTexCache) this._bulletTexCache = {};
        const screenW = this.app.screen.width, screenH = this.app.screen.height;
        const cullMargin = angle !== 0 ? 256 : 64;
        const camX = gameState.cameraX * SCALE, camY = gameState.cameraY * SCALE;
        const halfW = screenW / 2 + cullMargin, halfH = screenH / 2 + cullMargin;
        const MAX_RENDERED_BULLETS = Math.min(this._bulletPool.length, 200);
        const hideOtherPlayerBullets = !!(gameState.settings
                && gameState.settings.graphics
                && gameState.settings.graphics.hideOtherPlayerBullets);
        const localPlayerId = gameState.playerId;

        // Reset fallback graphics in place — no allocation.
        const bulletGfx = this._bulletFallbackGfx;
        bulletGfx.clear();
        let bulletCount = 0;

        for (const [id, bullet] of gameState.bullets) {
            if (bulletCount >= MAX_RENDERED_BULLETS) break;

            if (hideOtherPlayerBullets && bullet.flags
                    && bullet.flags.includes(ProjectileFlag.PLAYER_PROJECTILE)) {
                const isMine = bullet._predicted
                        || (bullet.srcEntityId !== undefined && bullet.srcEntityId === localPlayerId);
                if (!isMine) continue;
            }

            const sx = bullet.pos.x * SCALE;
            const sy = bullet.pos.y * SCALE;
            if (Math.abs(sx - camX) > halfW || Math.abs(sy - camY) > halfH) continue;

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
                const spr = this._bulletPool[bulletCount++];
                if (spr.texture !== tex) spr.texture = tex;
                spr.x = sx + size / 2;
                spr.y = sy + size / 2;
                spr.width = size; spr.height = size;
                const tfAngle = Math.PI / 2;
                const angleOffset = projGroup ? parseAngleTemplate(projGroup.angleOffset) : 0;
                spr.rotation = -bullet.angle + tfAngle + (angleOffset > 0 ? angleOffset : 0);
                spr.visible = true;
                this.entityLayer.addChild(spr); // re-parent (was unparented by removeChildren above)
            } else {
                bulletGfx.beginFill(0xffff80);
                bulletGfx.drawCircle(sx + size / 2, sy + size / 2, size / 3);
                bulletGfx.endFill();
            }
        }
        // Hide the unused tail of the bullet pool.
        for (let i = bulletCount; i < this._bulletPool.length; i++) {
            const s = this._bulletPool[i];
            if (s.visible) s.visible = false;
        }
        // Add the fallback graphics if it has anything to draw this frame.
        if (bulletGfx.geometry.graphicsData.length > 0) {
            this.entityLayer.addChild(bulletGfx);
        }

        // Reap entity pool: hide entries not seen this frame, periodic prune.
        this._reapEntityPool(false);
    }

    renderPlayer(player, angle, isLocal, gameState, e) {
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

        // Pool entry passed in by renderEntities (acquired with the correct
        // Map key). Children persist across frames.
        const bb = e.bb;
        bb.position.set(Math.round(sx + size / 2), Math.round(sy + size / 2));
        bb.rotation = -angle;
        const lx = -size / 2, ly = -size / 2;

        // Circular ground shadow — only redraw when size changes.
        if (e.shadowKind !== 'pe' || e.cachedShadowSize !== size) {
            e.shadow.clear();
            e.shadow.beginFill(0x000000, 0.3);
            e.shadow.drawEllipse(0, size / 2 + size * 0.08, size * 0.4, size * 0.12);
            e.shadow.endFill();
            e.shadowKind = 'pe';
            e.cachedShadowSize = size;
        }

        const spW = animDef?.spriteSize || BASE_SPRITE_SIZE;
        const spH = animDef?.spriteHeight || spW;
        const playerDyeId = isLocal ? (gameState.dyeId || player.dyeId || 0) : (player.dyeId || 0);
        const tex = playerDyeId
            ? this.getDyedRegion(sheetKey, classId, frameCol, row, spW, spH, playerDyeId, gameState)
            : this.getRegion(sheetKey, frameCol, row, spW, spH);
        if (tex) {
            const flipX = player.facing === 'left';
            const spr = e.body;
            if (e.cachedTex !== tex) { spr.texture = tex; e.cachedTex = tex; }
            spr.x = lx; spr.y = ly;
            spr.width = size; spr.height = size;
            // PIXI's width setter PRESERVES the sign of scale.x. So once we
            // mirror the sprite (negative scale.x for flipX), `width = size`
            // does NOT restore positive scale on the next frame — we must
            // do it explicitly. Without this we get a phantom mirrored sprite
            // on the wrong side after the player turns around.
            if (e.cachedFlipX !== flipX) {
                if (flipX) spr.anchor.set(1, 0);
                else       spr.anchor.set(0, 0);
                e.cachedFlipX = flipX;
            }
            spr.scale.x = flipX ? -Math.abs(spr.scale.x) : Math.abs(spr.scale.x);

            // Status-effect tint, only assigned when changed (preserves PIXI batching).
            const effects = isLocal ? gameState.effectIds : (player.effectIds || []);
            let newTint = 0xFFFFFF;
            if (this._hasEffect(effects, StatusEffect.INVINCIBLE))      newTint = 0xFFFFCC;
            else if (this._hasEffect(effects, StatusEffect.ARMOR_BROKEN)) newTint = 0x7060CC;
            else if (this._hasEffect(effects, StatusEffect.PARALYZED))  newTint = 0x888888;
            else if (this._hasEffect(effects, StatusEffect.STUNNED))    newTint = 0x88AACC;
            else if (this._hasEffect(effects, StatusEffect.STASIS))     newTint = 0x333338;
            else if (this._hasEffect(effects, StatusEffect.INVISIBLE))  newTint = 0xCCBB88;
            else if (this._hasEffect(effects, StatusEffect.BERSERK))    newTint = 0xFF6644;
            else if (this._hasEffect(effects, StatusEffect.DAMAGING))   newTint = 0xFFAA66;
            else if (this._hasEffect(effects, StatusEffect.ARMORED))    newTint = 0x8899CC;
            else if (this._hasEffect(effects, StatusEffect.HEALING))    newTint = 0xFF8888;
            else if (this._hasEffect(effects, StatusEffect.SPEEDY))     newTint = 0xBBFF88;
            else if (this._hasEffect(effects, StatusEffect.DAZED))      newTint = 0x9988AA;
            else if (this._hasEffect(effects, StatusEffect.CURSED))     newTint = 0x992255;
            else if (this._hasEffect(effects, StatusEffect.POISONED))   newTint = 0x40CC40;
            if (e.cachedTint !== newTint) { spr.tint = newTint; e.cachedTint = newTint; }

            // Wading: lazy-allocate the mask Graphics once, reuse across frames.
            if (wading) {
                const sinkOffset = size * wadingClip;
                spr.y = ly + sinkOffset;
                if (!e.mask) {
                    e.mask = new PIXI.Graphics();
                    bb.addChild(e.mask);
                }
                if (e.cachedWading !== size) {
                    e.mask.clear();
                    e.mask.beginFill(0xFFFFFF);
                    e.mask.drawRect(lx - 2, ly, size + 4, size);
                    e.mask.endFill();
                    e.cachedWading = size;
                }
                e.mask.visible = true;
                spr.mask = e.mask;
            } else {
                if (e.mask) e.mask.visible = false;
                spr.mask = null;
                e.cachedWading = null;
            }

            // Update outline sprites (4 cardinal-offset tinted copies).
            // Mirror via anchor + negative scale.x like the original
            // addSpriteWithOutline; the position stays at lx + ox in both
            // orientations (the anchor change is what reflects the sprite).
            // scale.x sign must be applied every frame — see body comment.
            for (let i = 0; i < 4; i++) {
                const ox = OUTLINE_OFFSETS[i][0], oy = OUTLINE_OFFSETS[i][1];
                const ol = e.outlines[i];
                if (ol.texture !== tex) ol.texture = tex;
                ol.width = size; ol.height = size;
                ol.x = lx + ox;
                ol.y = (wading ? spr.y : ly) + oy;
                if (flipX) ol.anchor.set(1, 0);
                else       ol.anchor.set(0, 0);
                ol.scale.x = flipX ? -Math.abs(ol.scale.x) : Math.abs(ol.scale.x);
                ol.mask = wading ? e.mask : null;
                ol.visible = true;
            }
        } else {
            // Texture missing — hide body, hide outlines.
            e.body.visible = false;
            for (let i = 0; i < 4; i++) e.outlines[i].visible = false;
        }
        if (tex) e.body.visible = true;

        // HP and MP bars — lazy-allocate one Graphics, redraw via clear() (no alloc).
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
        if (!e.bars) { e.bars = new PIXI.Graphics(); bb.addChild(e.bars); }
        const bars = e.bars;
        bars.clear();
        bars.beginFill(0x222222, 0.7); bars.drawRect(lx, barY, barWidth, barHeight); bars.endFill();
        bars.beginFill(0x40c040, 0.9); bars.drawRect(lx, barY, barWidth * hpPct, barHeight); bars.endFill();
        bars.beginFill(0x222222, 0.7); bars.drawRect(lx, barY + barHeight + barGap, barWidth, barHeight); bars.endFill();
        bars.beginFill(0x4080e0, 0.9); bars.drawRect(lx, barY + barHeight + barGap, barWidth * mpPct, barHeight); bars.endFill();
        bars.visible = true;

        // Compute the same effective world-space center the sprite renders at,
        // so the (pooled, screen-space) name + status icons stay glued to the
        // sprite. Using raw player.pos.x/y here makes them follow the discrete
        // sim-tick position while the sprite uses the smooth interpolated
        // _renderX/_renderY (+ _smoothX/Y for local-player reconciliation),
        // producing visible drift / "jump back" each tick.
        const ePosX = isLocal && player._renderX !== undefined ? player._renderX : player.pos.x;
        const ePosY = isLocal && player._renderY !== undefined ? player._renderY : player.pos.y;
        const eSmoothX = isLocal ? (player._smoothX || 0) : 0;
        const eSmoothY = isLocal ? (player._smoothY || 0) : 0;
        const halfSize = (player.size || PLAYER_SIZE) / 2;
        const eCxWorld = ePosX + halfSize + eSmoothX;
        const eCyWorld = ePosY + halfSize + eSmoothY;

        // Player name above bars (other players only).
        // Pooled in _textContainer (screen-space) instead of inside `bb`, so the
        // Text instance survives the per-frame entityLayer destroy and we don't
        // leak <canvas> via PIXI.utils.BaseTextureCache.
        let iconAnchorY = barY - 2;
        if (!isLocal) {
            const name = player.name || CLASS_NAMES[classId] || 'Player';
            const nameColor = GameRenderer.getNameColorHex(player.chatRole);
            // The original offset was inside the billboarded `bb` whose local Y
            // axis is screen-up, so the same offset applies in screen space.
            const screen = this.worldToScreen(eCxWorld, eCyWorld, gameState);
            const nameText = this._acquireNameText('p:' + String(player.id), name, nameColor);
            nameText.x = screen.x;
            nameText.y = screen.y + (barY - 2);
            iconAnchorY = barY - 18;
        }

        // Status effect icons above health bars / name. Pooled in screen-space.
        const playerEffects = isLocal ? gameState.effectIds : (player.effectIds || []);
        if (playerEffects && playerEffects.length) {
            const sc = this.worldToScreen(eCxWorld, eCyWorld, gameState);
            this._drawStatusIcons(playerEffects, sc.x, sc.y + iconAnchorY);
        }
        // bb is already parented; renderEntities re-orders the entityLayer.
    }

    renderEnemy(enemy, angle, gameState, e) {
        const sx = enemy.pos.x * SCALE;
        const sy = enemy.pos.y * SCALE;
        const size = (enemy.size || PLAYER_SIZE) * SCALE;

        const bb = e.bb;
        bb.position.set(Math.round(sx + size / 2), Math.round(sy + size / 2));
        bb.rotation = -angle;
        const lx = -size / 2, ly = -size / 2;

        const enemyDef = gameState.enemyData[enemy.enemyId];
        let tex = null;
        if (enemyDef && enemyDef.spriteKey) {
            const sw = enemyDef.spriteSize || BASE_SPRITE_SIZE;
            const sh = enemyDef.spriteHeight || sw;
            tex = this.getRegion(enemyDef.spriteKey, enemyDef.col || 0, enemyDef.row || 0, sw, sh);
        }

        // Shadow — redraw only on size change.
        if (e.shadowKind !== 'pe' || e.cachedShadowSize !== size) {
            e.shadow.clear();
            e.shadow.beginFill(0x000000, 0.3);
            e.shadow.drawEllipse(0, size / 2 + size * 0.08, size * 0.4, size * 0.12);
            e.shadow.endFill();
            e.shadowKind = 'pe';
            e.cachedShadowSize = size;
        }

        if (tex) {
            const spr = e.body;
            if (e.cachedTex !== tex) { spr.texture = tex; e.cachedTex = tex; }
            spr.x = lx; spr.y = ly;
            spr.width = size; spr.height = size;

            let newTint = 0xFFFFFF;
            if (enemy.effectIds) {
                if (this._hasEffect(enemy.effectIds, StatusEffect.STASIS))      newTint = 0x333338;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.INVINCIBLE))  newTint = 0xFFFFCC;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.ARMOR_BROKEN)) newTint = 0x7060CC;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.PARALYZED))   newTint = 0x888888;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.STUNNED))     newTint = 0x88AACC;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.DAZED))       newTint = 0x9988AA;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.CURSED))      newTint = 0x992255;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.POISONED))    newTint = 0x40CC40;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.BERSERK))     newTint = 0xFF6644;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.DAMAGING))    newTint = 0xFFAA66;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.ARMORED))     newTint = 0x8899CC;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.SPEEDY))      newTint = 0xBBFF88;
                else if (this._hasEffect(enemy.effectIds, StatusEffect.HEALING))     newTint = 0xFF8888;
            }
            if (e.cachedTint !== newTint) { spr.tint = newTint; e.cachedTint = newTint; }

            // Outline sprites (4 cardinal-offset tinted copies).
            for (let i = 0; i < 4; i++) {
                const ox = OUTLINE_OFFSETS[i][0], oy = OUTLINE_OFFSETS[i][1];
                const ol = e.outlines[i];
                if (ol.texture !== tex) ol.texture = tex;
                ol.x = lx + ox; ol.y = ly + oy;
                ol.width = size; ol.height = size;
                ol.visible = true;
            }
            spr.visible = true;
        } else {
            e.body.visible = false;
            for (let i = 0; i < 4; i++) e.outlines[i].visible = false;
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
    }

    // renderBullet removed — bullets are now batched inline in renderEntities()

    renderLootContainer(loot, angle, gameState, e) {
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

        const bb = e.bb;
        bb.position.set(Math.round(sx + ox + size / 2), Math.round(sy + oy + size / 2));
        bb.rotation = -angle;
        const lx = -size / 2, ly = -size / 2;

        if (e.shadowKind !== 'l' || e.cachedShadowSize !== size) {
            e.shadow.clear();
            e.shadow.beginFill(0x000000, 0.3);
            e.shadow.drawEllipse(0, size / 2 + size * 0.08, size * 0.35, size * 0.1);
            e.shadow.endFill();
            e.shadowKind = 'l';
            e.cachedShadowSize = size;
        }

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
            const spr = e.body;
            if (e.cachedTex !== tex) { spr.texture = tex; e.cachedTex = tex; }
            spr.x = lx; spr.y = ly;
            spr.width = size; spr.height = size;
            spr.visible = true;
        } else {
            e.body.visible = false;
        }
    }

    renderPortal(portal, angle, gameState, e) {
        const sx = portal.pos.x * SCALE;
        const sy = portal.pos.y * SCALE;
        const size = this.tileSize * SCALE;

        const bb = e.bb;
        bb.position.set(Math.round(sx + size / 2), Math.round(sy + size / 2));
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

        if (e.shadowKind !== 'po' || e.cachedShadowSize !== size) {
            e.shadow.clear();
            e.shadow.beginFill(0x000000, 0.3);
            e.shadow.drawEllipse(0, size / 2 + size * 0.08, size * 0.4, size * 0.12);
            e.shadow.endFill();
            e.shadowKind = 'po';
            e.cachedShadowSize = size;
        }

        if (tex) {
            const spr = e.body;
            if (e.cachedTex !== tex) { spr.texture = tex; e.cachedTex = tex; }
            spr.x = lx; spr.y = ly;
            spr.width = size; spr.height = size;
            spr.visible = true;
        } else {
            e.body.visible = false;
        }
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

    /**
     * Draws an armed snare ring with inward-pointing teeth — used by both
     * trap cases (placed-after-throw and standalone). Distinct from a plain
     * heal/buff ring because the inward teeth read as "jaws ready to snap".
     */
    _drawSnareRing(g, sx, sy, r, elapsed, progress, tierColor, alpha) {
        const pulse = 0.7 + 0.3 * Math.sin(elapsed * 0.004);
        const fadeAlpha = progress > 0.85 ? (1.0 - progress) / 0.15 : 1.0;
        const a = fadeAlpha * pulse * alpha;
        const innerR = r * 0.7;

        // Filled body — darker tier wash so the jaws POP against it.
        g.beginFill(tierColor, fadeAlpha * 0.22);
        g.drawCircle(sx, sy, r);
        g.endFill();
        g.beginFill(0x000000, fadeAlpha * 0.18);
        g.drawCircle(sx, sy, innerR);
        g.endFill();

        // Bold double outer ring — chunky tier-coloured + bright white.
        g.lineStyle(6, tierColor, a * 0.95);
        g.drawCircle(sx, sy, r);
        g.lineStyle(3, 0xffffff, a * 0.9);
        g.drawCircle(sx, sy, r * 0.97);
        // Inner snare ring — warm amber so it always reads as "trap"
        // regardless of the tier-tinted outer.
        g.lineStyle(2, 0xffaa44, a * 0.85);
        g.drawCircle(sx, sy, innerR);
        g.lineStyle(0);

        // INWARD-facing snare teeth. Each tooth's two base vertices sit on
        // the outer ring at offset angles, with the tip pointing radially
        // inward toward the center — gives the unmistakable look of jaws
        // closing around the trigger area. Slow rotation animates them.
        const teethCount = 14;
        const baseHalfAng = (Math.PI / teethCount) * 0.7;
        const tipDepth = Math.max(14, r * 0.18);
        const rot = elapsed * 0.0015;
        for (let i = 0; i < teethCount; i++) {
            const ang = (i / teethCount) * Math.PI * 2 + rot;
            const baseR = r * 0.99;
            const tipR = r - tipDepth;
            // Two base points on the outer ring
            const b1x = sx + Math.cos(ang - baseHalfAng) * baseR;
            const b1y = sy + Math.sin(ang - baseHalfAng) * baseR;
            const b2x = sx + Math.cos(ang + baseHalfAng) * baseR;
            const b2y = sy + Math.sin(ang + baseHalfAng) * baseR;
            // Tip pointing INWARD
            const tx = sx + Math.cos(ang) * tipR;
            const ty = sy + Math.sin(ang) * tipR;
            // Outer tier-coloured halo for the tooth
            g.beginFill(tierColor, a * 0.55);
            g.drawPolygon([
                sx + Math.cos(ang - baseHalfAng) * (baseR + 4),
                sy + Math.sin(ang - baseHalfAng) * (baseR + 4),
                tx, ty,
                sx + Math.cos(ang + baseHalfAng) * (baseR + 4),
                sy + Math.sin(ang + baseHalfAng) * (baseR + 4)
            ]);
            g.endFill();
            // Bright white tooth body
            g.beginFill(0xffeecc, a * 0.95);
            g.drawPolygon([b1x, b1y, tx, ty, b2x, b2y]);
            g.endFill();
            // Dark tip point — sharper read
            g.beginFill(0x442200, a * 0.85);
            g.drawCircle(tx, ty, 1.6);
            g.endFill();
        }

        // Center trigger marker — pulsing tier-coloured dot + white core
        const corePulse = 0.6 + 0.4 * Math.sin(elapsed * 0.012);
        g.beginFill(tierColor, a * 0.7 * corePulse);
        g.drawCircle(sx, sy, 6);
        g.endFill();
        g.beginFill(0xffffff, a * 0.95);
        g.drawCircle(sx, sy, 3);
        g.endFill();

        // Faint danger-zone diagonal lines crossing through the center —
        // makes the trigger area pop more on busy tile backgrounds.
        g.lineStyle(2, 0xffaa44, a * 0.55);
        g.moveTo(sx - innerR * 0.55, sy - innerR * 0.55);
        g.lineTo(sx + innerR * 0.55, sy + innerR * 0.55);
        g.moveTo(sx + innerR * 0.55, sy - innerR * 0.55);
        g.lineTo(sx - innerR * 0.55, sy + innerR * 0.55);
        g.lineStyle(0);
    }

    renderVisualEffects(gameState, angle) {
        // Persistent FX graphics — clear in place each frame instead of
        // allocating a fresh Graphics object. Always clear, even when no
        // effects exist this frame, otherwise last-frame draws would linger.
        const g = this._fxGraphics;
        g.clear();
        if (!gameState.visualEffects || gameState.visualEffects.length === 0) return;
        const now = Date.now();

        // Tier-color palette: T0 white → T6 purple. Used by tiered ability
        // effects (priest heal, necro skull, scepter lightning, poison,
        // trap, plus the four class-cast visuals) so a teammate's loot tier
        // is readable from across the screen.
        const TIER_COLORS = GameRenderer.TIER_COLORS;

        for (const fx of gameState.visualEffects) {
            const elapsed = now - fx.startTime;
            const progress = Math.min(elapsed / fx.duration, 1.0);
            const alpha = 1.0 - progress; // fade out over duration
            const screen = this.worldToScreen(fx.x, fx.y, gameState);
            const sx = screen.x;
            const sy = screen.y;
            const r = fx.radius * SCALE;
            const tier = Math.max(0, Math.min(6, fx.tier | 0));
            const tierColor = TIER_COLORS[tier];

            switch (fx.type) {
                case 0: { // HEAL_RADIUS — full-throated priest tome blast
                    // Expanding ring grows fast then settles, with a
                    // tier-coloured outer halo so a T6 tome looks visibly
                    // different from a T0. Multi-layer ring + filled body
                    // + cross beams + shimmer particles + bright core.
                    const ringR = r * (0.4 + progress * 0.6);
                    // Soft outer halo in tier colour — biggest visual cue
                    g.beginFill(tierColor, alpha * 0.18);
                    g.drawCircle(sx, sy, ringR * 1.15);
                    g.endFill();
                    // Inner translucent green body — preserves the "heal" feel
                    g.beginFill(0x60ff60, alpha * 0.22);
                    g.drawCircle(sx, sy, ringR);
                    g.endFill();
                    // Three concentric rings: tier-coloured outer, bright
                    // green mid, white inner. Read as a "shockwave of light".
                    g.lineStyle(5, tierColor, alpha * 0.85);
                    g.drawCircle(sx, sy, ringR);
                    g.lineStyle(3, 0x80ff80, alpha * 0.95);
                    g.drawCircle(sx, sy, ringR * 0.92);
                    g.lineStyle(2, 0xffffff, alpha * 0.85);
                    g.drawCircle(sx, sy, ringR * 0.82);
                    g.lineStyle(0);
                    // Cross beams — cardinal sparkle lines pulsing outward
                    const beamLen = ringR * 0.55;
                    const beamAlpha = alpha * 0.6 * (0.5 + 0.5 * Math.sin(elapsed * 0.012));
                    g.lineStyle(3, 0xffffff, beamAlpha);
                    for (let b = 0; b < 4; b++) {
                        const a = b * (Math.PI / 2) + elapsed * 0.003;
                        g.moveTo(sx + Math.cos(a) * (ringR * 0.2), sy + Math.sin(a) * (ringR * 0.2));
                        g.lineTo(sx + Math.cos(a) * (ringR * 0.2 + beamLen), sy + Math.sin(a) * (ringR * 0.2 + beamLen));
                    }
                    g.lineStyle(0);
                    // Shimmer particles — 16 of them, rotating, with tier-
                    // coloured halo + white core for that "magic sparkle"
                    const particles = 16;
                    for (let i = 0; i < particles; i++) {
                        const a = (i / particles) * Math.PI * 2 + elapsed * 0.005;
                        const pr = ringR * (0.85 + 0.1 * Math.sin(elapsed * 0.008 + i));
                        const px = sx + Math.cos(a) * pr;
                        const py = sy + Math.sin(a) * pr;
                        g.beginFill(tierColor, alpha * 0.55);
                        g.drawCircle(px, py, 6);
                        g.endFill();
                        g.beginFill(0xffffff, alpha * 0.95);
                        g.drawCircle(px, py, 2.5);
                        g.endFill();
                    }
                    // Rising sparks — 8 small dots that drift upward over
                    // the duration, giving the effect vertical motion.
                    for (let i = 0; i < 8; i++) {
                        const seed = i * 0.7;
                        const driftA = (seed * 1.3) % (Math.PI * 2);
                        const lift = 24 + 60 * progress + (i & 1) * 8;
                        const sxi = sx + Math.cos(driftA) * (ringR * 0.4);
                        const syi = sy + Math.sin(driftA) * (ringR * 0.2) - lift;
                        g.beginFill(0xc0ffc0, alpha * 0.8);
                        g.drawCircle(sxi, syi, 3);
                        g.endFill();
                    }
                    // Bright pulsing core
                    const corePulse = 0.6 + 0.4 * Math.sin(elapsed * 0.02);
                    g.beginFill(0xffffff, alpha * 0.85 * corePulse);
                    g.drawCircle(sx, sy, ringR * 0.16);
                    g.endFill();
                    g.beginFill(tierColor, alpha * 0.5 * corePulse);
                    g.drawCircle(sx, sy, ringR * 0.28);
                    g.endFill();
                    break;
                }

                case 1: { // VAMPIRISM — necromancer life-drain spiral
                    // Outer translucent boundary so the drain area is visible.
                    // Tier-coloured ring distinguishes T0..T6 skulls.
                    g.lineStyle(3, tierColor, alpha * 0.9);
                    g.drawCircle(sx, sy, r);
                    g.beginFill(0x4a0a4a, alpha * 0.18);
                    g.drawCircle(sx, sy, r);
                    g.endFill();
                    g.lineStyle(0);
                    // Twin-spiral inward-pulling streams. Two phase-offset rings
                    // of particles spiraling toward center for clear visual flow.
                    const vampParticles = 24;
                    for (let i = 0; i < vampParticles; i++) {
                        const a = (i / vampParticles) * Math.PI * 2 + elapsed * 0.005;
                        const dist = r * (1.0 - progress) * (0.4 + 0.6 * ((i % 2) === 0 ? 1 : 0.65));
                        const px = sx + Math.cos(a) * dist;
                        const py = sy + Math.sin(a) * dist;
                        // Trail dot — bright magenta
                        g.beginFill(0xff60ff, alpha * 0.85);
                        g.drawCircle(px, py, 4 + (1 - progress) * 3);
                        g.endFill();
                        // Outer dim halo for blob feel
                        g.beginFill(0xcc20cc, alpha * 0.35);
                        g.drawCircle(px, py, 7 + (1 - progress) * 4);
                        g.endFill();
                    }
                    // Throbbing core glow — red blood pulse.
                    const corePulse = 0.6 + 0.4 * Math.sin(elapsed * 0.02);
                    g.beginFill(0xff2030, alpha * 0.5 * corePulse);
                    g.drawCircle(sx, sy, r * 0.35 * (1 - progress * 0.6));
                    g.endFill();
                    g.beginFill(0xffa0a0, alpha * 0.7);
                    g.drawCircle(sx, sy, r * 0.18 * (1 - progress * 0.5));
                    g.endFill();
                    break;
                }

                case 2: { // STASIS_FIELD — mystic AoE freeze
                    // Frosted area fill so the field is unmistakable.
                    g.beginFill(0x6090d0, alpha * 0.22);
                    g.drawCircle(sx, sy, r);
                    g.endFill();
                    // Outer glow ring — chunky, bright cyan-blue.
                    g.lineStyle(6, 0x60a0ff, alpha * 0.55);
                    g.drawCircle(sx, sy, r);
                    g.lineStyle(4, 0xb0e0ff, alpha * 0.95);
                    g.drawCircle(sx, sy, r);
                    g.lineStyle(2, 0xffffff, alpha * 0.7);
                    g.drawCircle(sx, sy, r * 0.92);
                    g.lineStyle(0);
                    // Twelve rotating ice shards on the edge — diamond-shaped
                    // for that "frozen crystal" feel.
                    for (let i = 0; i < 12; i++) {
                        const a = (i / 12) * Math.PI * 2 + elapsed * 0.003;
                        const cx = sx + Math.cos(a) * r * 0.78;
                        const cy = sy + Math.sin(a) * r * 0.78;
                        // Glow halo
                        g.beginFill(0xa0d0ff, alpha * 0.35);
                        g.drawCircle(cx, cy, 7);
                        g.endFill();
                        // Crystal body
                        g.beginFill(0xe0f0ff, alpha * 0.95);
                        g.drawPolygon([cx, cy - 5, cx + 4, cy, cx, cy + 5, cx - 4, cy]);
                        g.endFill();
                    }
                    // Inner snowflake bursts — twinkle
                    for (let i = 0; i < 8; i++) {
                        const a = (i / 8) * Math.PI * 2 - elapsed * 0.004;
                        const dr = r * (0.25 + 0.4 * Math.abs(Math.sin(elapsed * 0.005 + i)));
                        g.beginFill(0xffffff, alpha * 0.6);
                        g.drawCircle(sx + Math.cos(a) * dr, sy + Math.sin(a) * dr, 2);
                        g.endFill();
                    }
                    break;
                }

                case 3: { // CHAIN_LIGHTNING — high-voltage forked arc
                    const _ts = this.worldToScreen(fx.targetX, fx.targetY, gameState);
                    const tx = _ts.x, ty = _ts.y;
                    const dx = tx - sx, dy = ty - sy;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const segments = Math.max(8, Math.floor(dist / 7));
                    const perpX = -dy / dist, perpY = dx / dist;

                    // Strike-flash envelope — sharp early flash that fades fast,
                    // then a slower decay for the trailing arc. Multiplies all
                    // layers below so the bolt POPS at impact and lingers softly.
                    const strike = progress < 0.18 ? 1.0 : Math.max(0, 1.0 - (progress - 0.18) / 0.82);
                    // Erratic flicker — high-frequency noise to fake AC sizzle.
                    const flicker = 0.7 + 0.3 * Math.sin(elapsed * 0.08 + sx * 0.13);

                    // Build a jagged spine path used by every layer (so glow,
                    // bolt, and core line up). Larger jitter near midpoint,
                    // tapering to 0 at endpoints so the bolt actually connects.
                    const path = new Array(segments + 1);
                    path[0] = [sx, sy];
                    for (let i = 1; i < segments; i++) {
                        const t = i / segments;
                        const taper = Math.sin(t * Math.PI); // 0 at ends, 1 at middle
                        const jitter = (Math.random() - 0.5) * 28 * taper;
                        path[i] = [
                            sx + dx * t + perpX * jitter,
                            sy + dy * t + perpY * jitter
                        ];
                    }
                    path[segments] = [tx, ty];

                    const drawPath = (width, color, a) => {
                        g.lineStyle(width, color, a);
                        g.moveTo(path[0][0], path[0][1]);
                        for (let i = 1; i <= segments; i++) g.lineTo(path[i][0], path[i][1]);
                    };

                    // Layer 1 — wide outer aura (tier-coloured plasma haze)
                    drawPath(14, tierColor, alpha * 0.32 * strike);
                    // Layer 2 — thick electric blue glow
                    drawPath(9, 0x2060ff, alpha * 0.45 * strike * flicker);
                    // Layer 3 — main bolt body (cyan-white)
                    drawPath(5, 0x80c0ff, alpha * 0.85 * strike);
                    // Layer 4 — hot inner core (pure white)
                    drawPath(2, 0xffffff, Math.min(1, alpha * 1.2) * strike);
                    g.lineStyle(0);

                    // Branching micro-bolts — short forks that split off at random
                    // segments, perpendicular-ish to the main spine. Adds the
                    // "crackling" feel without obscuring the main path.
                    const forkCount = 5;
                    for (let f = 0; f < forkCount; f++) {
                        const segIdx = 1 + Math.floor(Math.random() * (segments - 1));
                        const [bx, by] = path[segIdx];
                        // Direction roughly perpendicular with random sign + tilt
                        const sign = Math.random() < 0.5 ? -1 : 1;
                        const tilt = (Math.random() - 0.5) * 0.6;
                        const fdx = (perpX * sign + (dx / dist) * tilt) * (12 + Math.random() * 26);
                        const fdy = (perpY * sign + (dy / dist) * tilt) * (12 + Math.random() * 26);
                        // 3-step jagged sub-bolt
                        const fp = [
                            [bx, by],
                            [bx + fdx * 0.5 + (Math.random() - 0.5) * 6, by + fdy * 0.5 + (Math.random() - 0.5) * 6],
                            [bx + fdx, by + fdy]
                        ];
                        g.lineStyle(4, 0x2060ff, alpha * 0.4 * strike * flicker);
                        g.moveTo(fp[0][0], fp[0][1]); g.lineTo(fp[1][0], fp[1][1]); g.lineTo(fp[2][0], fp[2][1]);
                        g.lineStyle(2, 0xa0d0ff, alpha * 0.7 * strike);
                        g.moveTo(fp[0][0], fp[0][1]); g.lineTo(fp[1][0], fp[1][1]); g.lineTo(fp[2][0], fp[2][1]);
                        g.lineStyle(1, 0xffffff, alpha * 0.9 * strike);
                        g.moveTo(fp[0][0], fp[0][1]); g.lineTo(fp[1][0], fp[1][1]); g.lineTo(fp[2][0], fp[2][1]);
                        g.lineStyle(0);
                    }

                    // Impact burst at the target — radial spark + bright flash.
                    if (progress < 0.55) {
                        const burstA = (1.0 - progress / 0.55);
                        // Big soft halo
                        g.beginFill(0x80c0ff, alpha * 0.35 * burstA);
                        g.drawCircle(tx, ty, 28 * burstA + 12);
                        g.endFill();
                        // Tighter electric core
                        g.beginFill(0xe0f0ff, alpha * 0.7 * burstA);
                        g.drawCircle(tx, ty, 12 * burstA + 6);
                        g.endFill();
                        // White-hot center
                        g.beginFill(0xffffff, Math.min(1, alpha * burstA * 1.2));
                        g.drawCircle(tx, ty, 5 * burstA + 2);
                        g.endFill();
                        // Radial spark spokes
                        const spokes = 10;
                        g.lineStyle(2, 0xffffff, alpha * 0.85 * burstA);
                        for (let i = 0; i < spokes; i++) {
                            const a = (i / spokes) * Math.PI * 2 + elapsed * 0.02;
                            const len = 14 + 18 * burstA + Math.random() * 8;
                            g.moveTo(tx, ty);
                            g.lineTo(tx + Math.cos(a) * len, ty + Math.sin(a) * len);
                        }
                        g.lineStyle(0);
                    }

                    // Origin-side glow — small steady flicker so the player feels
                    // like they're actively channeling the bolt.
                    g.beginFill(0x80c0ff, alpha * 0.45 * strike * flicker);
                    g.drawCircle(sx, sy, 6 + 2 * Math.sin(elapsed * 0.05));
                    g.endFill();
                    g.beginFill(0xffffff, alpha * 0.7 * strike);
                    g.drawCircle(sx, sy, 3);
                    g.endFill();
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
                        // AoE poison splash — chunky toxic cloud, expands fast then
                        // lingers. Filled translucent body + thick outline + drifting
                        // bubbles so it reads at a glance.
                        const expand = 0.4 + progress * 0.6;
                        const cloudR = r * expand;
                        // Soft outer halo — tier-coloured for instant tier read
                        g.beginFill(tierColor, alpha * 0.25);
                        g.drawCircle(sx, sy, cloudR * 1.1);
                        g.endFill();
                        // Main cloud body — saturated green fill
                        g.beginFill(0x4cc530, alpha * 0.4);
                        g.drawCircle(sx, sy, cloudR);
                        g.endFill();
                        // Thick tier-tinted border
                        g.lineStyle(4, tierColor, alpha * 0.9);
                        g.drawCircle(sx, sy, cloudR);
                        g.lineStyle(2, 0xa0ff70, alpha * 0.7);
                        g.drawCircle(sx, sy, cloudR * 0.85);
                        g.lineStyle(0);
                        // Drifting toxic bubbles — large, varied positions
                        for (let i = 0; i < 14; i++) {
                            const a = (i / 14) * Math.PI * 2 + elapsed * 0.003;
                            const wobble = Math.sin(elapsed * 0.005 + i) * 0.15;
                            const dist2 = cloudR * (0.45 + wobble);
                            const bx = sx + Math.cos(a) * dist2;
                            const by = sy + Math.sin(a) * dist2;
                            // Halo
                            g.beginFill(0x80e060, alpha * 0.4);
                            g.drawCircle(bx, by, 7);
                            g.endFill();
                            // Bubble core
                            g.beginFill(0xc0ff80, alpha * 0.85);
                            g.drawCircle(bx, by, 4);
                            g.endFill();
                        }
                        // Central skull-fume burst — bright pulse
                        const fumePulse = 0.5 + 0.5 * Math.sin(elapsed * 0.012);
                        g.beginFill(0x60ff40, alpha * 0.7 * fumePulse);
                        g.drawCircle(sx, sy, cloudR * 0.25);
                        g.endFill();
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
                        // Persistent ground trap ring — armed snare with
                        // INWARD-facing teeth. Bright multi-layer ring +
                        // hazardous fill so the trap is unmistakable, plus
                        // 14 sharp triangles ringing the perimeter pointing
                        // toward the center to read as "snare jaws".
                        this._drawSnareRing(g, sx, sy, r, elapsed, progress, tierColor, alpha);
                    }
                    break;
                }

                case 7: { // TRAP_PLACED — persistent armed trap ring
                    this._drawSnareRing(g, sx, sy, r, elapsed, progress, tierColor, alpha);
                    break;
                }

                case 8: { // TRAP_TRIGGER — closing circle snap + flash
                    // Circle rapidly closes inward then flashes
                    const closeR = r * (1.0 - progress);
                    const flashAlpha = progress < 0.3 ? 1.0 : Math.max(0, 1.0 - (progress - 0.3) / 0.7);
                    // Closing tier-coloured outer ring + warm amber inner —
                    // tier reads even at the moment of detonation.
                    g.lineStyle(4, tierColor, flashAlpha * 0.95);
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

                case 9: { // SMOKE_POOF — rogue cloak vanish
                    // A puff of smoke at the caster, expanding and fading.
                    // Tier tints the smoke so a T6 cloak feels distinct from
                    // a T0 — but it stays smoky-grey at the core for the
                    // unmistakable "vanish" read.
                    const puffR = r * (0.6 + progress * 1.4);
                    // Outer translucent puff cluster — 6 overlapping circles
                    // with offsets that rotate slowly so it billows.
                    for (let i = 0; i < 6; i++) {
                        const a = (i / 6) * Math.PI * 2 + elapsed * 0.002;
                        const dist = puffR * 0.45;
                        const px = sx + Math.cos(a) * dist;
                        const py = sy + Math.sin(a) * dist;
                        const pr = puffR * (0.65 + 0.1 * Math.sin(elapsed * 0.01 + i));
                        // Tier tint outer
                        g.beginFill(tierColor, alpha * 0.18);
                        g.drawCircle(px, py, pr);
                        g.endFill();
                        // Smoky grey core
                        g.beginFill(0x808080, alpha * 0.32);
                        g.drawCircle(px, py, pr * 0.78);
                        g.endFill();
                        // Inner dark wisp
                        g.beginFill(0x404040, alpha * 0.4);
                        g.drawCircle(px, py, pr * 0.45);
                        g.endFill();
                    }
                    // Central bright flash at the start — the "POP" of the cast
                    if (progress < 0.25) {
                        const flashA = 1.0 - progress / 0.25;
                        g.beginFill(0xffffff, flashA * 0.85);
                        g.drawCircle(sx, sy, puffR * 0.35 * (1 + progress));
                        g.endFill();
                        g.beginFill(tierColor, flashA * 0.55);
                        g.drawCircle(sx, sy, puffR * 0.55 * (1 + progress));
                        g.endFill();
                    }
                    // Drifting wisps that float upward (the "smoke rising" feel)
                    for (let i = 0; i < 8; i++) {
                        const seed = i * 0.83;
                        const driftA = (seed * 1.7) % (Math.PI * 2);
                        const lift = 18 * progress * (1 + (i & 1));
                        const wx = sx + Math.cos(driftA) * (puffR * 0.4) + (i - 4) * 3;
                        const wy = sy + Math.sin(driftA) * (puffR * 0.2) - lift;
                        g.beginFill(0xa0a0a0, alpha * 0.55);
                        g.drawCircle(wx, wy, 4 - progress * 2);
                        g.endFill();
                    }
                    break;
                }

                case 10: { // WIZARD_BURST — arcane release at cast
                    // Tight glyph + radial spokes + sparkle ring. Reads as
                    // "I am the caster, behold this spell" without competing
                    // visually with the projectile.
                    const burstR = r * (0.5 + progress * 0.6);
                    // Filled magic-circle floor
                    g.beginFill(tierColor, alpha * 0.18);
                    g.drawCircle(sx, sy, burstR);
                    g.endFill();
                    // Two counter-rotating runic rings
                    g.lineStyle(3, tierColor, alpha * 0.85);
                    g.drawCircle(sx, sy, burstR);
                    g.lineStyle(2, 0xffffff, alpha * 0.85);
                    g.drawCircle(sx, sy, burstR * 0.78);
                    g.lineStyle(0);
                    // Six rune-points orbiting outward
                    const runes = 6;
                    for (let i = 0; i < runes; i++) {
                        const a = (i / runes) * Math.PI * 2 + elapsed * 0.006;
                        const px = sx + Math.cos(a) * burstR;
                        const py = sy + Math.sin(a) * burstR;
                        // Outer halo
                        g.beginFill(tierColor, alpha * 0.55);
                        g.drawCircle(px, py, 8);
                        g.endFill();
                        // Bright diamond core
                        g.beginFill(0xffffff, alpha * 0.95);
                        g.drawPolygon([px, py - 5, px + 4, py, px, py + 5, px - 4, py]);
                        g.endFill();
                    }
                    // Radial spokes that fade as the burst expands
                    const spokeA = alpha * (1.0 - progress * 0.7);
                    g.lineStyle(2, 0xffffff, spokeA);
                    for (let i = 0; i < 8; i++) {
                        const a = (i / 8) * Math.PI * 2;
                        const inner = burstR * 0.2;
                        const outer = burstR * 0.95;
                        g.moveTo(sx + Math.cos(a) * inner, sy + Math.sin(a) * inner);
                        g.lineTo(sx + Math.cos(a) * outer, sy + Math.sin(a) * outer);
                    }
                    g.lineStyle(0);
                    // Initial flash at cast moment
                    if (progress < 0.2) {
                        const flashA = 1.0 - progress / 0.2;
                        g.beginFill(0xffffff, flashA * 0.85);
                        g.drawCircle(sx, sy, burstR * 0.4);
                        g.endFill();
                    }
                    // Bright pulsing core
                    g.beginFill(tierColor, alpha * 0.75);
                    g.drawCircle(sx, sy, burstR * 0.18);
                    g.endFill();
                    break;
                }

                case 11: { // KNIGHT_SHOCKWAVE — forward thrust shield bash
                    // Conveys "knight winds up briefly, then THRUSTS the
                    // shield FORWARD with the stun". Phases compressed so
                    // the slam lands roughly when the projectiles do —
                    // earlier versions had the impact arrive long after
                    // the projectiles already hit. REACH is now the
                    // ACTUAL distance to the cursor (capped) so the
                    // animation finishes where the shield projectiles
                    // land rather than at a fixed offset.

                    const _ts11 = this.worldToScreen(fx.targetX, fx.targetY, gameState);
                    const tx11 = _ts11.x, ty11 = _ts11.y;
                    let kdx = tx11 - sx, kdy = ty11 - sy;
                    const kdist = Math.sqrt(kdx * kdx + kdy * kdy);
                    const dirX = kdist > 0.5 ? kdx / kdist : 1;
                    const dirY = kdist > 0.5 ? kdy / kdist : 0;
                    const perpX = -dirY, perpY = dirX;

                    // Reach the actual cursor distance, clamped to a
                    // sane minimum + maximum so cursor-on-knight clicks
                    // and far-cursor stretches both look sensible.
                    const REACH = Math.max(60, Math.min(280, kdist));
                    // Compressed phase timings — total fx duration is
                    // 600ms (down from 900ms) and the slam lands at 50%
                    // (~300ms) so it matches the visible projectile
                    // arrival roughly.
                    const WINDUP_END = 0.12;
                    const THRUST_END = 0.50;
                    const SLAM_END = 0.70;

                    // ── Ground-shadow streak along the thrust axis ──────
                    // Faint dark band on the ground from the knight to the
                    // slam point — gives the thrust visual weight.
                    const streakStart = -40;
                    const streakEnd = REACH * Math.min(1.2, progress * 1.4);
                    const startX = sx + dirX * streakStart, startY = sy + dirY * streakStart;
                    const endX = sx + dirX * streakEnd, endY = sy + dirY * streakEnd;
                    g.lineStyle(28, tierColor, alpha * 0.10);
                    g.moveTo(startX, startY); g.lineTo(endX, endY);
                    g.lineStyle(16, tierColor, alpha * 0.22);
                    g.moveTo(startX, startY); g.lineTo(endX, endY);
                    g.lineStyle(6, 0x000000, alpha * 0.45);
                    g.moveTo(startX, startY); g.lineTo(endX, endY);
                    g.lineStyle(0);

                    // ── Force chevrons sweeping forward ─────────────────
                    // 6 chevrons stagger in along the thrust axis. Each
                    // chevron is a V-shape pointing forward, with its
                    // axial position along the dash line driven by
                    // (progress - phaseOffset). At wind-up they crouch
                    // behind the knight; during thrust they fly forward
                    // through the player and out the front.
                    const chevCount = 6;
                    for (let i = 0; i < chevCount; i++) {
                        // Per-chevron phase offset so the back chevrons
                        // emerge first, leading chevrons trail behind a
                        // fraction of a beat.
                        const phaseOff = i * 0.045;
                        // Position along thrust axis: -0.6 (behind knight)
                        // → +1.2 (past the slam point).
                        let lt;
                        if (progress < WINDUP_END) {
                            // Wind-up: gather behind. Lines drift slightly
                            // backward as the knight braces.
                            const t = progress / WINDUP_END;
                            lt = -0.55 - 0.10 * t - i * 0.08;
                        } else if (progress < THRUST_END) {
                            // Thrust: ease-in-out forward.
                            const t = Math.max(0, Math.min(1,
                                    (progress - WINDUP_END - phaseOff)
                                    / (THRUST_END - WINDUP_END - phaseOff)));
                            const eased = t * t * (3 - 2 * t);
                            const startLT = -0.55 - 0.10 - i * 0.08;
                            const endLT = 1.20 - i * 0.05;
                            lt = startLT + (endLT - startLT) * eased;
                        } else {
                            // Slam aftermath: chevrons hold at the front,
                            // fading.
                            lt = 1.20 - i * 0.05;
                        }

                        const cx = sx + dirX * REACH * lt;
                        const cy = sy + dirY * REACH * lt;
                        // Fade based on how close the chevron is to its
                        // active range (-0.6 to 1.2). Beyond that, fade.
                        const ltClamped = Math.max(-0.7, Math.min(1.3, lt));
                        const distFromCore = Math.max(0, ltClamped - 1.0);
                        const aheadFade = 1 - distFromCore * 1.8;
                        const fade = alpha * Math.max(0.2, aheadFade) * (1 - i * 0.06);

                        // Chevron geometry: V-shape, tip pointing forward.
                        // Larger trailing chevrons, smaller leading ones.
                        const arm = 22 - i * 2.2;
                        const tipFwd = arm * 0.55;
                        const tipX = cx + dirX * tipFwd;
                        const tipY = cy + dirY * tipFwd;
                        const back1X = cx + perpX * arm - dirX * arm * 0.4;
                        const back1Y = cy + perpY * arm - dirY * arm * 0.4;
                        const back2X = cx - perpX * arm - dirX * arm * 0.4;
                        const back2Y = cy - perpY * arm - dirY * arm * 0.4;

                        // Outer tier-coloured stroke
                        g.lineStyle(7, tierColor, fade * 0.85);
                        g.moveTo(back1X, back1Y);
                        g.lineTo(tipX, tipY);
                        g.lineTo(back2X, back2Y);
                        // Inner black underlay for silhouette pop on bright tiles
                        g.lineStyle(3, 0x000000, fade * 0.6);
                        g.moveTo(back1X, back1Y);
                        g.lineTo(tipX, tipY);
                        g.lineTo(back2X, back2Y);
                        // Bright white core
                        g.lineStyle(2, 0xffffff, fade * 0.95);
                        g.moveTo(back1X, back1Y);
                        g.lineTo(tipX, tipY);
                        g.lineTo(back2X, back2Y);
                        g.lineStyle(0);
                    }

                    // ── Brace flash behind knight during wind-up ────────
                    // Small tier-coloured dust burst at the knight's feet
                    // as they crouch into the thrust.
                    if (progress < WINDUP_END) {
                        const wt = progress / WINDUP_END;
                        const brakeA = alpha * (1 - wt) * 0.7;
                        const braceX = sx - dirX * 18;
                        const braceY = sy - dirY * 18;
                        g.beginFill(0x553322, brakeA * 0.5);
                        g.drawCircle(braceX, braceY, 14 + wt * 8);
                        g.endFill();
                        g.beginFill(tierColor, brakeA * 0.4);
                        g.drawCircle(braceX, braceY, 10 + wt * 6);
                        g.endFill();
                    }

                    // ── Slam impact at the front ───────────────────────
                    // Big punchy burst when the thrust reaches its peak.
                    // Anchored at the FRONT of the thrust (REACH px ahead
                    // of the knight in the dash direction).
                    if (progress >= WINDUP_END) {
                        const slamProg = Math.max(0, Math.min(1,
                                (progress - WINDUP_END) / (SLAM_END - WINDUP_END)));
                        // Slam alpha peaks near the THRUST_END moment, then fades.
                        const slamPeak = (THRUST_END - WINDUP_END) / (SLAM_END - WINDUP_END);
                        let slamA;
                        if (slamProg <= slamPeak) {
                            slamA = slamProg / slamPeak;
                        } else {
                            slamA = Math.max(0, 1 - (slamProg - slamPeak) / (1 - slamPeak));
                        }
                        slamA *= alpha;
                        if (slamA > 0.02) {
                            const slamX = sx + dirX * REACH;
                            const slamY = sy + dirY * REACH;
                            // Big tier halo
                            g.beginFill(tierColor, slamA * 0.55);
                            g.drawCircle(slamX, slamY, 38 + slamA * 18);
                            g.endFill();
                            // White-hot core
                            g.beginFill(0xffffff, slamA * 0.95);
                            g.drawCircle(slamX, slamY, 18 + slamA * 10);
                            g.endFill();
                            // Inner punch dot
                            g.beginFill(tierColor, slamA);
                            g.drawCircle(slamX, slamY, 8);
                            g.endFill();
                            // 12 radial spokes around the slam — heavy
                            // shield-bash impact lines.
                            g.lineStyle(3, 0xffffff, slamA * 0.9);
                            const spokes = 12;
                            for (let i = 0; i < spokes; i++) {
                                const a = (i / spokes) * Math.PI * 2;
                                const inner = 12;
                                const outer = 28 + slamA * 22;
                                g.moveTo(slamX + Math.cos(a) * inner, slamY + Math.sin(a) * inner);
                                g.lineTo(slamX + Math.cos(a) * outer, slamY + Math.sin(a) * outer);
                            }
                            g.lineStyle(0);
                            // Forward-only crack lines (asymmetric — the
                            // bash pushes ENERGY forward, not equally in
                            // all directions).
                            g.lineStyle(4, tierColor, slamA * 0.85);
                            for (let i = -1; i <= 1; i++) {
                                const tilt = i * 0.45;
                                const cTilt = Math.cos(tilt), sTilt = Math.sin(tilt);
                                const fX = dirX * cTilt - dirY * sTilt;
                                const fY = dirY * cTilt + dirX * sTilt;
                                g.moveTo(slamX, slamY);
                                g.lineTo(slamX + fX * (40 + slamA * 30), slamY + fY * (40 + slamA * 30));
                            }
                            g.lineStyle(0);
                        }
                    }

                    // ── Aftermath shockwave from slam point ────────────
                    if (progress >= THRUST_END) {
                        const aftT = (progress - THRUST_END) / (1.0 - THRUST_END);
                        const waveR = 30 + aftT * 60;
                        const ringA = alpha * (1.0 - aftT) * 0.85;
                        const slamX = sx + dirX * REACH;
                        const slamY = sy + dirY * REACH;
                        g.lineStyle(6, tierColor, ringA);
                        g.drawCircle(slamX, slamY, waveR);
                        g.lineStyle(3, 0xffffff, ringA);
                        g.drawCircle(slamX, slamY, waveR * 0.93);
                        g.lineStyle(0);
                    }
                    break;
                }

                case 14: { // PALADIN_SEAL — holy cross + divine light pillar
                    // Distinct from priest heal: a vertical beam of light
                    // with a radiant gold cross at the caster, ascending
                    // motes, and a slowly rotating halo. Reads as
                    // "consecration" rather than "AoE healing pulse".
                    const baseR = r * (0.55 + 0.45 * progress);
                    const goldA = alpha;

                    // Vertical pillar of light rising from the player —
                    // tall translucent rectangle with a soft falloff.
                    const pillarH = baseR * 2.4;
                    const pillarW = baseR * 0.55;
                    g.beginFill(tierColor, goldA * 0.18);
                    g.drawRect(sx - pillarW, sy - pillarH, pillarW * 2, pillarH);
                    g.endFill();
                    g.beginFill(0xfff0a0, goldA * 0.30);
                    g.drawRect(sx - pillarW * 0.55, sy - pillarH * 0.95, pillarW * 1.1, pillarH * 0.95);
                    g.endFill();
                    g.beginFill(0xffffff, goldA * 0.45);
                    g.drawRect(sx - pillarW * 0.20, sy - pillarH * 0.92, pillarW * 0.4, pillarH * 0.92);
                    g.endFill();

                    // Slowly rotating halo behind the cross — gives the
                    // cross something to be silhouetted against.
                    const haloR = baseR * 0.78;
                    g.beginFill(tierColor, goldA * 0.22);
                    g.drawCircle(sx, sy - baseR * 0.15, haloR);
                    g.endFill();
                    g.lineStyle(3, 0xffe070, goldA * 0.85);
                    g.drawCircle(sx, sy - baseR * 0.15, haloR);
                    g.lineStyle(2, 0xffffff, goldA * 0.6);
                    g.drawCircle(sx, sy - baseR * 0.15, haloR * 0.92);
                    g.lineStyle(0);

                    // Halo radial sun-rays — 12 spokes that pulse with elapsed.
                    const spokes = 12;
                    const spokePulse = 0.8 + 0.2 * Math.sin(elapsed * 0.012);
                    g.lineStyle(2, 0xfff0a0, goldA * 0.7 * spokePulse);
                    for (let i = 0; i < spokes; i++) {
                        const a = (i / spokes) * Math.PI * 2 + elapsed * 0.0015;
                        const inner = haloR * 0.95;
                        const outer = haloR * (1.15 + 0.08 * Math.sin(elapsed * 0.008 + i));
                        g.moveTo(sx + Math.cos(a) * inner, sy - baseR * 0.15 + Math.sin(a) * inner);
                        g.lineTo(sx + Math.cos(a) * outer, sy - baseR * 0.15 + Math.sin(a) * outer);
                    }
                    g.lineStyle(0);

                    // The cross itself — vertical beam + horizontal beam,
                    // each rendered as a stacked outer-glow + bright core.
                    const crossCx = sx;
                    const crossCy = sy - baseR * 0.15;
                    const vH = haloR * 1.55;            // vertical arm length
                    const vW = haloR * 0.18;            // beam thickness
                    const hH = haloR * 0.18;            // horizontal arm thickness
                    const hW = haloR * 1.05;            // horizontal arm length
                    const hOff = -vH * 0.12;            // horizontal sits slightly above center

                    // Outer tier-coloured glow (slightly bigger so it
                    // bleeds beyond the white core)
                    g.beginFill(tierColor, goldA * 0.55);
                    g.drawRect(crossCx - vW * 1.5, crossCy - vH * 0.55, vW * 3, vH * 1.1);
                    g.drawRect(crossCx - hW, crossCy + hOff - hH * 1.5, hW * 2, hH * 3);
                    g.endFill();
                    // Mid layer — warm gold
                    g.beginFill(0xffe070, goldA * 0.85);
                    g.drawRect(crossCx - vW, crossCy - vH * 0.5, vW * 2, vH);
                    g.drawRect(crossCx - hW * 0.95, crossCy + hOff - hH, hW * 1.9, hH * 2);
                    g.endFill();
                    // Bright white-hot core
                    g.beginFill(0xffffff, Math.min(1, goldA * 1.0));
                    g.drawRect(crossCx - vW * 0.45, crossCy - vH * 0.5, vW * 0.9, vH);
                    g.drawRect(crossCx - hW * 0.92, crossCy + hOff - hH * 0.45, hW * 1.84, hH * 0.9);
                    g.endFill();

                    // Cross-arm endpoint flares (small bright dots at the
                    // tip of each arm — "stars" on the cross)
                    const flareR = 4 + 2 * spokePulse;
                    g.beginFill(0xffffff, goldA * 0.9);
                    g.drawCircle(crossCx, crossCy - vH * 0.5, flareR);            // top
                    g.drawCircle(crossCx, crossCy + vH * 0.5, flareR);            // bottom
                    g.drawCircle(crossCx - hW * 0.95, crossCy + hOff, flareR);    // left
                    g.drawCircle(crossCx + hW * 0.95, crossCy + hOff, flareR);    // right
                    g.endFill();
                    g.beginFill(tierColor, goldA * 0.5);
                    g.drawCircle(crossCx, crossCy - vH * 0.5, flareR * 1.8);
                    g.drawCircle(crossCx, crossCy + vH * 0.5, flareR * 1.8);
                    g.drawCircle(crossCx - hW * 0.95, crossCy + hOff, flareR * 1.8);
                    g.drawCircle(crossCx + hW * 0.95, crossCy + hOff, flareR * 1.8);
                    g.endFill();

                    // Ascending divine motes — small bright dots that drift
                    // upward over the duration. Motes are seeded from the
                    // ground and rise, fading at the top, like prayer light.
                    const motes = 14;
                    for (let i = 0; i < motes; i++) {
                        const seed = i * 0.61;
                        // Each mote has its own phase offset so they don't
                        // all move in lockstep.
                        const phase = (progress + seed) % 1.0;
                        const moteA = Math.sin(phase * Math.PI) * goldA;
                        if (moteA <= 0.05) continue;
                        // Gentle horizontal drift via per-mote sine
                        const dx2 = Math.sin(seed * 7 + elapsed * 0.001) * baseR * 0.5;
                        const my = sy + baseR * 0.6 - phase * pillarH * 1.05;
                        const mx = sx + dx2;
                        // Outer warm halo
                        g.beginFill(0xffe070, moteA * 0.5);
                        g.drawCircle(mx, my, 5);
                        g.endFill();
                        // Bright core
                        g.beginFill(0xffffff, Math.min(1, moteA));
                        g.drawCircle(mx, my, 2.5);
                        g.endFill();
                    }

                    // Initial consecration flash at cast moment
                    if (progress < 0.18) {
                        const flashA = 1.0 - progress / 0.18;
                        g.beginFill(0xffffff, flashA * 0.95);
                        g.drawCircle(sx, sy, baseR * 0.55);
                        g.endFill();
                        g.beginFill(0xffe070, flashA * 0.7);
                        g.drawCircle(sx, sy, baseR * 0.85);
                        g.endFill();
                    }
                    break;
                }

                case 13: { // NINJA_DASH — vortex of slicing blades along the path
                    // Line from start (sx,sy) to end (targetX,targetY).
                    const _ts = this.worldToScreen(fx.targetX, fx.targetY, gameState);
                    const tx = _ts.x, ty = _ts.y;
                    const dx = tx - sx, dy = ty - sy;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const dirX = dx / dist, dirY = dy / dist;
                    const perpX = -dirY, perpY = dirX;

                    // ── 1. Dash spine — soft tier aura, slim core ──────────
                    // Toned down significantly so the slashes/blades are
                    // the visual focus, not a wall of colour. Thin black
                    // outline added behind the white core for contrast on
                    // bright tile backgrounds.
                    g.lineStyle(20, tierColor, alpha * 0.10);
                    g.moveTo(sx, sy); g.lineTo(tx, ty);
                    g.lineStyle(10, tierColor, alpha * 0.25);
                    g.moveTo(sx, sy); g.lineTo(tx, ty);
                    g.lineStyle(5, 0x000000, alpha * 0.55);
                    g.moveTo(sx, sy); g.lineTo(tx, ty);
                    g.lineStyle(3, 0xffffff, alpha * 0.75);
                    g.moveTo(sx, sy); g.lineTo(tx, ty);
                    g.lineStyle(0);

                    // ── 2. Vortex of orbiting blades ─────────────────────────
                    // Blades distributed along the dash path. Each one:
                    //   • orbits perpendicular to the path (gives the
                    //     "vortex/spiral" read in 2D — alternating signs
                    //     so blades sweep across opposite sides)
                    //   • spins fast on its own axis (each blade is a
                    //     diamond/lens that rotates as it orbits)
                    //   • pops in late, peaks mid-life, shrinks at the end
                    // Count scales with dash distance so 3-tile and 5-tile
                    // dashes both feel proportionally dense.
                    const bladeCount = Math.max(14, Math.floor(dist / 14));
                    const ORBIT_AMP = 44;       // perpendicular orbit reach (px)
                    const ORBIT_SPEED = 0.011;  // radians/ms — was 0.020 (slowed)
                    const SPIN_SPEED = 0.016;   // radians/ms — was 0.030 (slowed)
                    for (let i = 0; i < bladeCount; i++) {
                        const t = (i + 0.5) / bladeCount;
                        // Stagger appearance along the path so the vortex
                        // fills in front-to-back, not all-at-once.
                        const appear = t * 0.45;
                        if (progress < appear) continue;
                        const local = (progress - appear) / Math.max(0.001, 1 - appear);
                        let bScale = 1.0;
                        if (local < 0.15) bScale = local / 0.15;
                        else if (local > 0.75) bScale = Math.max(0, (1 - local) / 0.25);
                        if (bScale <= 0) continue;

                        // Orbit center is on the dash line at fraction t
                        const cx = sx + dx * t;
                        const cy = sy + dy * t;
                        // Alternate +/- sign so half the blades sweep one
                        // side and half the other — true vortex feel rather
                        // than a single column of bobbing blades.
                        const sign = (i & 1) ? 1 : -1;
                        const orbitPhase = sign * (elapsed * ORBIT_SPEED + i * 0.55);
                        const orbit = Math.sin(orbitPhase) * ORBIT_AMP * bScale;
                        const bx = cx + perpX * orbit;
                        const by = cy + perpY * orbit;

                        // Per-blade spin (independent of orbit phase)
                        const spin = elapsed * SPIN_SPEED + i * 0.4;
                        const cs = Math.cos(spin), sn = Math.sin(spin);

                        // Outer tier-coloured glow blade — toned alpha so the
                        // sword silhouettes elsewhere read as primary.
                        const gLen = 22 * bScale, gWid = 7 * bScale;
                        g.beginFill(tierColor, alpha * 0.32 * bScale);
                        g.drawPolygon([
                            bx + gLen * cs,  by + gLen * sn,
                            bx - gWid * sn,  by + gWid * cs,
                            bx - gLen * cs,  by - gLen * sn,
                            bx + gWid * sn,  by - gWid * cs
                        ]);
                        g.endFill();

                        // Thin black outline around the blade core — gives
                        // each spinning blade a crisp silhouette against
                        // the tier-coloured aura and busy tile bg.
                        const cLen = 16 * bScale, cWid = 4 * bScale;
                        g.lineStyle(1, 0x000000, alpha * 0.7 * bScale);
                        g.drawPolygon([
                            bx + cLen * cs,  by + cLen * sn,
                            bx - cWid * sn,  by + cWid * cs,
                            bx - cLen * cs,  by - cLen * sn,
                            bx + cWid * sn,  by - cWid * cs
                        ]);
                        g.lineStyle(0);
                        // Inner white-hot blade core
                        g.beginFill(0xffffff, alpha * 0.85 * bScale);
                        g.drawPolygon([
                            bx + cLen * cs,  by + cLen * sn,
                            bx - cWid * sn,  by + cWid * cs,
                            bx - cLen * cs,  by - cLen * sn,
                            bx + cWid * sn,  by - cWid * cs
                        ]);
                        g.endFill();

                        // Motion-trail line behind the blade tip — toned
                        // down so 14 of them don't merge into a streak.
                        const trailLen = 14 * bScale;
                        g.lineStyle(2, tierColor, alpha * 0.45 * bScale);
                        g.moveTo(bx + cLen * cs, by + cLen * sn);
                        g.lineTo(bx + cLen * cs - dirX * trailLen,
                                 by + cLen * sn - dirY * trailLen);
                        g.lineStyle(0);
                    }

                    // ── 3. Katana slashes — sword silhouette + crescent arc ─
                    // For each slash position along the path, a sword
                    // visibly swings through an arc, leaving a fading
                    // crescent trail behind. Reads as a slashing cut, not
                    // a static lightning bolt. Adjacent slashes alternate
                    // swing direction so the cuts feel like a flurry, not
                    // a metronome.
                    const slashCount = Math.max(3, Math.floor(dist / 40));
                    const SLASH_DUR = 0.50;        // fraction of fx life — was 0.32 (slowed)
                    const SWEEP_SPAN = Math.PI * 0.95; // ~170° arc per swing
                    const SWORD_REACH = 56;
                    const perpAngle = Math.atan2(perpY, perpX);
                    for (let i = 0; i < slashCount; i++) {
                        const t = (i + 0.5) / slashCount;
                        const sStart = t * 0.55; // stagger by path position
                        if (progress < sStart) continue;
                        const sLifeRaw = (progress - sStart) / SLASH_DUR;
                        if (sLifeRaw > 1.4) continue; // afterglow window
                        const cx = sx + dx * t;
                        const cy = sy + dy * t;

                        // Alternate swing direction per slash.
                        const dir = (i & 1) ? 1 : -1;
                        const sweepStart = perpAngle - dir * SWEEP_SPAN / 2;
                        const sweepEnd = perpAngle + dir * SWEEP_SPAN / 2;

                        // Ease-in-out so the swing is fast through the middle
                        // (where the actual cut happens) and slow at the
                        // start/finish — feels like a real katana motion.
                        const sLife = Math.min(1, sLifeRaw);
                        const eased = sLife < 0.5
                                ? 2 * sLife * sLife
                                : 1 - Math.pow(-2 * sLife + 2, 2) / 2;
                        const currentAngle = sweepStart + (sweepEnd - sweepStart) * eased;

                        // Fade: full alpha during swing, decay through afterglow.
                        const fadeA = (sLifeRaw <= 1)
                                ? alpha
                                : alpha * Math.max(0, 1 - (sLifeRaw - 1) / 0.4);

                        // ── Crescent motion trail (multi-segment polyline)
                        // Sample 14 points along the swept arc from start
                        // to currentAngle. Older segments thinner and fainter
                        // so the leading edge POPS. Toned alpha so multiple
                        // overlapping slashes don't blur together.
                        const arcSegs = 14;
                        for (let s = 0; s < arcSegs; s++) {
                            const segT0 = s / arcSegs;
                            const segT1 = (s + 1) / arcSegs;
                            const a0 = sweepStart + (currentAngle - sweepStart) * segT0;
                            const a1 = sweepStart + (currentAngle - sweepStart) * segT1;
                            const x0 = cx + Math.cos(a0) * SWORD_REACH;
                            const y0 = cy + Math.sin(a0) * SWORD_REACH;
                            const x1 = cx + Math.cos(a1) * SWORD_REACH;
                            const y1 = cy + Math.sin(a1) * SWORD_REACH;
                            const lead = segT1;
                            const segA = fadeA * Math.pow(lead, 1.4);
                            g.lineStyle(2 + 5 * lead, tierColor, segA * 0.40);
                            g.moveTo(x0, y0); g.lineTo(x1, y1);
                            g.lineStyle(1 + 3 * lead, 0xffffff, segA * 0.75);
                            g.moveTo(x0, y0); g.lineTo(x1, y1);
                        }
                        g.lineStyle(0);

                        // ── Sword silhouette at current angle (only during
                        // active swing — no body during afterglow, just the
                        // crescent fading.)
                        if (sLifeRaw <= 1.0) {
                            const tipX = cx + Math.cos(currentAngle) * SWORD_REACH;
                            const tipY = cy + Math.sin(currentAngle) * SWORD_REACH;
                            // Hilt sits a small distance from the pivot — keeps
                            // the blade from intersecting the dash spine and
                            // gives a sense of "sword in hand".
                            const hiltDist = 4;
                            const hiltX = cx + Math.cos(currentAngle) * hiltDist;
                            const hiltY = cy + Math.sin(currentAngle) * hiltDist;
                            const midX = (tipX + hiltX) * 0.5;
                            const midY = (tipY + hiltY) * 0.5;
                            // Blade-perpendicular axis for the lens shape.
                            const bnx = -Math.sin(currentAngle);
                            const bny = Math.cos(currentAngle);
                            const bladeWid = 5;

                            // Outer tier-coloured glow blade (slightly bigger)
                            g.beginFill(tierColor, fadeA * 0.40);
                            g.drawPolygon([
                                tipX, tipY,
                                midX + bnx * (bladeWid + 2), midY + bny * (bladeWid + 2),
                                hiltX, hiltY,
                                midX - bnx * (bladeWid + 2), midY - bny * (bladeWid + 2)
                            ]);
                            g.endFill();
                            // Thin black silhouette outline so the sword
                            // shape reads cleanly against the tier glow
                            // and tile background.
                            g.lineStyle(1, 0x000000, fadeA * 0.85);
                            g.drawPolygon([
                                tipX, tipY,
                                midX + bnx * bladeWid, midY + bny * bladeWid,
                                hiltX, hiltY,
                                midX - bnx * bladeWid, midY - bny * bladeWid
                            ]);
                            g.lineStyle(0);
                            // Steel core (silver-white, gives the sword its body)
                            g.beginFill(0xe8e8f0, fadeA * 0.92);
                            g.drawPolygon([
                                tipX, tipY,
                                midX + bnx * bladeWid, midY + bny * bladeWid,
                                hiltX, hiltY,
                                midX - bnx * bladeWid, midY - bny * bladeWid
                            ]);
                            g.endFill();
                            // Bright cutting-edge dot at the tip
                            g.beginFill(0xffffff, fadeA);
                            g.drawCircle(tipX, tipY, 3);
                            g.endFill();
                            // Hilt ball — small dark circle so the sword
                            // visually has a handle, not just a floating blade.
                            g.beginFill(0x2a1810, fadeA * 0.9);
                            g.drawCircle(hiltX, hiltY, 2.5);
                            g.endFill();
                        }
                    }

                    // ── 4. Vanish puff at start ─────────────────────────────
                    const startPuffA = Math.max(0, 1.0 - progress * 1.6);
                    if (startPuffA > 0) {
                        g.beginFill(0x808080, startPuffA * 0.6);
                        g.drawCircle(sx, sy, 16);
                        g.endFill();
                        g.beginFill(tierColor, startPuffA * 0.4);
                        g.drawCircle(sx, sy, 26);
                        g.endFill();
                    }

                    // ── 5. Arrival flash + radial sparks at endpoint ────────
                    const arriveA = (progress < 0.5) ? (1.0 - progress / 0.5) : 0;
                    if (arriveA > 0) {
                        g.beginFill(0xffffff, arriveA * 0.9);
                        g.drawCircle(tx, ty, 12 + arriveA * 10);
                        g.endFill();
                        g.beginFill(tierColor, arriveA * 0.6);
                        g.drawCircle(tx, ty, 26 + arriveA * 14);
                        g.endFill();
                        g.lineStyle(2, 0xffffff, arriveA * 0.9);
                        const spokes = 10;
                        for (let i = 0; i < spokes; i++) {
                            const a = (i / spokes) * Math.PI * 2 + elapsed * 0.005;
                            const inner = 8;
                            const outer = 22 + arriveA * 18;
                            g.moveTo(tx + Math.cos(a) * inner, ty + Math.sin(a) * inner);
                            g.lineTo(tx + Math.cos(a) * outer, ty + Math.sin(a) * outer);
                        }
                        g.lineStyle(0);
                    }
                    break;
                }

                case 12: { // WARRIOR_BUFF — gritty battle rally
                    // Conveys "warrior raising sword and roaring": crossed
                    // war-blades at center pointing skyward, jagged shockwave
                    // ring, scattered ember/dust particles, and outward
                    // chevrons reading as a battle cry pushing nearby
                    // allies into combat. Distinct from the priest heal —
                    // sharp/angular shapes and warm orange-red tones layered
                    // over the tier color rather than a soft glowing ring.
                    const buffR = r * (0.5 + progress * 0.55);
                    const earlyA = (progress < 0.35) ? alpha : alpha * (1.0 - (progress - 0.35) / 0.65);

                    // 1. Smoke/dust haze fill — gritty undertone (warm grey)
                    g.beginFill(0x553322, alpha * 0.22);
                    g.drawCircle(sx, sy, buffR * 1.1);
                    g.endFill();

                    // 2. Jagged shockwave ring — instead of a smooth circle,
                    // draw 16 segments with random radial wobble for a
                    // "ground cracking under the rally" feel.
                    const jagSegs = 16;
                    g.lineStyle(5, tierColor, alpha * 0.85);
                    for (let i = 0; i < jagSegs; i++) {
                        const a0 = (i / jagSegs) * Math.PI * 2;
                        const a1 = ((i + 1) / jagSegs) * Math.PI * 2;
                        const r0 = buffR * (0.92 + 0.08 * Math.sin(i * 5.7 + elapsed * 0.005));
                        const r1 = buffR * (0.92 + 0.08 * Math.sin((i + 1) * 5.7 + elapsed * 0.005));
                        g.moveTo(sx + Math.cos(a0) * r0, sy + Math.sin(a0) * r0);
                        g.lineTo(sx + Math.cos(a1) * r1, sy + Math.sin(a1) * r1);
                    }
                    g.lineStyle(0);

                    // 3. Crossed war-blades raised high at the center —
                    // two diagonal stretched diamonds that spread apart
                    // slightly over the duration, like swords being thrown
                    // up in defiance. Tier-coloured glow + bright steel core.
                    const bladeAngle1 = -Math.PI / 4 + Math.sin(elapsed * 0.004) * 0.06;
                    const bladeAngle2 = -Math.PI * 3 / 4 - Math.sin(elapsed * 0.004) * 0.06;
                    const bladeLen = buffR * 0.55;
                    const bladeWid = 6;
                    const drawBlade = (cx, cy, ang) => {
                        const cs = Math.cos(ang), sn = Math.sin(ang);
                        // Outer warm glow (orange-red flame heat)
                        g.beginFill(0xff8030, alpha * 0.55);
                        g.drawPolygon([
                            cx + bladeLen * 1.1 * cs,            cy + bladeLen * 1.1 * sn,
                            cx - (bladeWid + 3) * sn,            cy + (bladeWid + 3) * cs,
                            cx - bladeLen * 0.55 * cs,           cy - bladeLen * 0.55 * sn,
                            cx + (bladeWid + 3) * sn,            cy - (bladeWid + 3) * cs
                        ]);
                        g.endFill();
                        // Steel-bright core
                        g.beginFill(0xffffff, alpha * 0.95);
                        g.drawPolygon([
                            cx + bladeLen * cs,             cy + bladeLen * sn,
                            cx - bladeWid * sn,             cy + bladeWid * cs,
                            cx - bladeLen * 0.5 * cs,       cy - bladeLen * 0.5 * sn,
                            cx + bladeWid * sn,             cy - bladeWid * cs
                        ]);
                        g.endFill();
                    };
                    drawBlade(sx, sy, bladeAngle1);
                    drawBlade(sx, sy, bladeAngle2);

                    // 4. Outward war-cry chevrons — rotating "V" marks
                    // pointing OUTWARD from the warrior, reading as
                    // "rally lines" pushing allies forward.
                    const chevs = 8;
                    for (let i = 0; i < chevs; i++) {
                        const a = (i / chevs) * Math.PI * 2 + elapsed * 0.005;
                        const cx = sx + Math.cos(a) * buffR * 0.78;
                        const cy = sy + Math.sin(a) * buffR * 0.78;
                        const ox = Math.cos(a), oy = Math.sin(a);
                        const tx = -oy, ty = ox; // tangent perpendicular
                        // Bigger, sharper chevrons than before — gritty look
                        g.lineStyle(4, tierColor, alpha * 0.85);
                        g.moveTo(cx - tx * 8 - ox * 4, cy - ty * 8 - oy * 4);
                        g.lineTo(cx + ox * 9, cy + oy * 9);
                        g.lineTo(cx + tx * 8 - ox * 4, cy + ty * 8 - oy * 4);
                        g.lineStyle(2, 0xffe0c0, alpha * 0.95);
                        g.moveTo(cx - tx * 8 - ox * 4, cy - ty * 8 - oy * 4);
                        g.lineTo(cx + ox * 9, cy + oy * 9);
                        g.lineTo(cx + tx * 8 - ox * 4, cy + ty * 8 - oy * 4);
                        g.lineStyle(0);
                    }

                    // 5. Embers scattering outward — orange/red dust motes
                    // riding the shockwave front. Alternate sizes for grit.
                    const embers = 18;
                    for (let i = 0; i < embers; i++) {
                        const seed = i * 0.91;
                        const a = (seed * 6.28) + elapsed * 0.004;
                        const dist = buffR * (0.85 + 0.20 * Math.sin(elapsed * 0.008 + seed));
                        const ex = sx + Math.cos(a) * dist;
                        const ey = sy + Math.sin(a) * dist;
                        const sz = (i & 1) ? 3 : 2;
                        // Hot inner ember
                        g.beginFill(0xff6020, alpha * 0.85);
                        g.drawRect(ex - sz, ey - sz, sz * 2, sz * 2);
                        g.endFill();
                        // Cooling outer
                        g.beginFill(0x884400, alpha * 0.55);
                        g.drawRect(ex - sz - 1, ey - sz - 1, sz * 2 + 2, sz * 2 + 2);
                        g.endFill();
                    }

                    // 6. Initial roar flash — short, angry pulse at cast
                    if (progress < 0.18) {
                        const flashA = 1.0 - progress / 0.18;
                        g.beginFill(0xffe0c0, flashA * 0.95);
                        g.drawCircle(sx, sy, buffR * 0.28);
                        g.endFill();
                        g.beginFill(0xff8030, flashA * 0.7);
                        g.drawCircle(sx, sy, buffR * 0.5);
                        g.endFill();
                    }

                    // 7. Throbbing core — warm tier tint pulsing as the
                    // rally aura pumps into nearby allies.
                    const corePulse = 0.6 + 0.4 * Math.sin(elapsed * 0.022);
                    g.beginFill(tierColor, earlyA * 0.65 * corePulse);
                    g.drawCircle(sx, sy, buffR * 0.22);
                    g.endFill();
                    break;
                }
            }
        }
        // _fxGraphics is permanently parented in init() — no per-frame addChild.
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

    // Tier color palette — drives the tier-aware tinting in
    // renderVisualEffects so heal/poison/trap/lightning/etc. read at a
    // glance as T0..T6. Indices map directly to item.getTier().
    static TIER_COLORS = [
        0xc0c0c0, // T0 silver
        0x60c0ff, // T1 light blue
        0x60ff80, // T2 green
        0xffd040, // T3 yellow / gold
        0xff8040, // T4 orange
        0xff4060, // T5 red
        0xc060ff  // T6 purple
    ];

    // Status effect icon definitions: [effectId, label, color]
    // Labels are short abbreviations rather than single glyphs so a
    // teammate can read at a glance whether they're slowed, paralysed,
    // damage-boosted, etc. Buffs use "+" and debuffs use "-" suffix
    // where the effect modifies a stat.
    static STATUS_ICON_DEFS = [
        [StatusEffect.HEALING,      'Heal',  0xFF4444],   // HoT
        [StatusEffect.SPEEDY,       'Spd+',  0x44FF44],   // movement speed up
        [StatusEffect.BERSERK,      'Aspd+', 0xFF6644],   // attack speed up
        [StatusEffect.DAMAGING,     'Atk+',  0xFFAA44],   // attack damage up
        [StatusEffect.ARMORED,      'Armr+', 0x6688CC],   // defense up
        [StatusEffect.INVINCIBLE,   'Invuln',0x44AAFF],   // invulnerable
        [StatusEffect.INVISIBLE,    'Hide',  0xCCBB88],   // stealth
        [StatusEffect.SLOWED,       'Slow',  0x6688FF],   // movement speed down
        [StatusEffect.PARALYZED,    'Para',  0x888888],   // can't move
        [StatusEffect.STUNNED,      'Stun',  0x88CCFF],   // can't act
        [StatusEffect.STASIS,       'Stasis',0x444448],   // frozen
        [StatusEffect.DAZED,        'Daze',  0x9988AA],   // disoriented
        [StatusEffect.POISONED,     'Pois',  0x40CC40],   // DoT
        [StatusEffect.CURSED,       'Curse', 0xAA2255],   // damage taken up
        [StatusEffect.ARMOR_BROKEN, 'Armr-', 0x7060CC],   // defense down
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
        for (const [eid, label, color] of GameRenderer.STATUS_ICON_DEFS) {
            if (this._hasEffect(effectIds, eid)) active.push({ label, color });
        }
        if (active.length === 0) return;

        // Vertical stack of pill-shaped chips above the entity. Bottommost
        // chip sits just above the head (screenTopY); each additional
        // effect stacks upward. Reads in two passes — colour to identify
        // the effect, abbreviation text to confirm what it does.
        const iconW = 40;
        const iconH = 14;
        const iconGap = 2;
        const bottomY = screenTopY - 2;
        const x = screenCenterX - iconW / 2;
        for (let i = 0; i < active.length; i++) {
            const { label: text, color } = active[i];
            // i = 0 is bottommost (just above entity), grows upward.
            const y = bottomY - (i + 1) * (iconH + iconGap);
            const { bg, label } = this._acquireStatusIcon(text);
            // Black border + drop shadow for legibility on busy tiles
            bg.beginFill(0x000000, 0.85);
            bg.drawRoundedRect(x - 1, y - 1, iconW + 2, iconH + 2, 4);
            bg.endFill();
            // Coloured body (effect identity)
            bg.beginFill(color, 0.92);
            bg.drawRoundedRect(x, y, iconW, iconH, 3);
            bg.endFill();
            // Subtle highlight strip along top edge for a more polished look
            bg.beginFill(0xffffff, 0.18);
            bg.drawRoundedRect(x + 1, y + 1, iconW - 2, 3, 2);
            bg.endFill();
            label.x = screenCenterX;
            label.y = y + iconH / 2;
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
