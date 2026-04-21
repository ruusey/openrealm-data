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
        this.tileLayer = null;
        this.entityLayer = null;
        this.uiLayer = null;

        // Graphics for health bars and shapes
        this.healthBarGraphics = null;
        this.tileGraphics = null;

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

        // Create layers
        this.tileLayer = new PIXI.Container();
        this.entityLayer = new PIXI.Container();
        this.uiLayer = new PIXI.Container();

        this.app.stage.addChild(this.tileLayer);
        this.app.stage.addChild(this.entityLayer);
        this.app.stage.addChild(this.uiLayer);

        this.healthBarGraphics = new PIXI.Graphics();
        this.uiLayer.addChild(this.healthBarGraphics);

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

        // Camera offset (center of screen) — round to integers to prevent
        // sub-pixel gaps between tiles (thin black lines at tile seams)
        const offsetX = Math.round(screenW / 2 - camX * SCALE);
        const offsetY = Math.round(screenH / 2 - camY * SCALE);

        // Clear UI layer (damage text, etc.) - keep healthbar graphics
        const keep = this.healthBarGraphics;
        while (this.uiLayer.children.length > 0) {
            const child = this.uiLayer.children[0];
            this.uiLayer.removeChildAt(0);
            if (child !== keep) child.destroy();
        }
        this.uiLayer.addChild(keep);

        this.renderTiles(gameState, offsetX, offsetY, screenW, screenH);
        this.renderEntities(gameState, offsetX, offsetY);
        this.renderVisualEffects(gameState, offsetX, offsetY);
        this.renderHealthBars(gameState, offsetX, offsetY);
        this.renderDamageTexts(gameState, offsetX, offsetY);
    }

    renderTiles(gameState, offsetX, offsetY, screenW, screenH) {
        // Destroy all children to free GPU memory (prevents massive leak)
        for (let i = this.tileLayer.children.length - 1; i >= 0; i--) {
            this.tileLayer.children[i].destroy();
        }
        this.tileLayer.removeChildren();
        if (!gameState.mapTiles) return;

        const localPlayer = gameState.getLocalPlayer();
        if (!localPlayer) return;

        const ts = this.tileSize; // Actual tile size from map data (e.g., 32)
        const playerTileX = Math.floor(localPlayer.pos.x / ts);
        const playerTileY = Math.floor(localPlayer.pos.y / ts);

        const minR = Math.max(0, playerTileY - VIEWPORT_TILES);
        const maxR = Math.min(gameState.mapHeight - 1, playerTileY + VIEWPORT_TILES);
        const minC = Math.max(0, playerTileX - VIEWPORT_TILES);
        const maxC = Math.min(gameState.mapWidth - 1, playerTileX + VIEWPORT_TILES);


        const drawSize = ts * SCALE;
        // Two-pass rendering: base tiles first, then collision layer on top.
        // This ensures wall side faces and shadows are never covered by base tiles.

        // === PASS 1: All base tiles ===
        for (let r = minR; r <= maxR; r++) {
            for (let c = minC; c <= maxC; c++) {
                const tile = gameState.mapTiles[r]?.[c];
                if (!tile || tile.base <= 0) continue;

                const sx = c * ts * SCALE + offsetX;
                const sy = r * ts * SCALE + offsetY;
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

                const sx = c * ts * SCALE + offsetX;
                const sy = r * ts * SCALE + offsetY;
                const tex = this.tileTextures[tile.collision];
                if (!tex) continue;

                // Check tile type from game data using isWall flag
                const tileDef = gameState.tileData[tile.collision];
                const hasCollision = tileDef?.data?.hasCollision;
                const isWall = !!tileDef?.data?.isWall;
                const isObject = hasCollision && !isWall;

                if (isWall) {
                    // === WALL 3D EFFECT ===
                    // Light from NW: bright top/left edges, cast shadow to S + E on floor.
                    // Neighbor-aware: effect pieces only draw on edges not abutting another wall.
                    const isWallAt = (rr, cc) => {
                        const t = gameState.mapTiles[rr]?.[cc];
                        if (!t || t.collision <= 0) return false;
                        return !!gameState.tileData[t.collision]?.data?.isWall;
                    };
                    const wN = isWallAt(r - 1, c);
                    const wS = isWallAt(r + 1, c);
                    const wW = isWallAt(r, c - 1);
                    const wE = isWallAt(r, c + 1);

                    // 1) South ground shadow — tall 3-band gradient, reads as wall depth
                    if (!wS) {
                        const sideH = Math.max(Math.round(drawSize * 0.28), 4);
                        const bandH = Math.ceil(sideH / 3);
                        // Extend horizontally to include the SE corner under the east shadow
                        const xEnd = drawSize + (!wE ? Math.round(drawSize * 0.18) : 0);
                        const sg = new PIXI.Graphics();
                        sg.beginFill(0x000000, 0.55).drawRect(sx, sy + drawSize,             xEnd, bandH).endFill();
                        sg.beginFill(0x000000, 0.32).drawRect(sx, sy + drawSize + bandH,     xEnd, bandH).endFill();
                        sg.beginFill(0x000000, 0.13).drawRect(sx, sy + drawSize + 2 * bandH, xEnd, bandH).endFill();
                        this.tileLayer.addChild(sg);
                    }

                    // 2) East ground shadow — softer, narrower than south
                    if (!wE) {
                        const sideW = Math.max(Math.round(drawSize * 0.18), 3);
                        const bandW = Math.ceil(sideW / 3);
                        // If N is also open, pull top down a hair so corner doesn't stick out
                        const startY = sy + (wN ? 0 : 2);
                        const h = (sy + drawSize) - startY;
                        const eg = new PIXI.Graphics();
                        eg.beginFill(0x000000, 0.42).drawRect(sx + drawSize,             startY, bandW, h).endFill();
                        eg.beginFill(0x000000, 0.24).drawRect(sx + drawSize + bandW,     startY, bandW, h).endFill();
                        eg.beginFill(0x000000, 0.10).drawRect(sx + drawSize + 2 * bandW, startY, bandW, h).endFill();
                        this.tileLayer.addChild(eg);
                    }

                    // 2b) West contact AO — weaker than east (faces NW light but wall still occludes)
                    if (!wW) {
                        const sideW = Math.max(Math.round(drawSize * 0.13), 3);
                        const bandW = Math.ceil(sideW / 3);
                        const wg = new PIXI.Graphics();
                        // Gradient fades from near-wall (right) outward (left)
                        wg.beginFill(0x000000, 0.32).drawRect(sx - bandW,         sy, bandW, drawSize).endFill();
                        wg.beginFill(0x000000, 0.18).drawRect(sx - 2 * bandW,     sy, bandW, drawSize).endFill();
                        wg.beginFill(0x000000, 0.08).drawRect(sx - 3 * bandW,     sy, bandW, drawSize).endFill();
                        this.tileLayer.addChild(wg);
                    }

                    // 2c) North contact AO — weakest, short
                    if (!wN) {
                        const sideH = Math.max(Math.round(drawSize * 0.12), 3);
                        const bandH = Math.ceil(sideH / 3);
                        // Pull in from corners if neighbors are open, so it doesn't bleed past
                        const xStart = sx + (wW ? 0 : 2);
                        const xEnd   = sx + drawSize - (wE ? 0 : 2);
                        const w = xEnd - xStart;
                        const ng = new PIXI.Graphics();
                        ng.beginFill(0x000000, 0.28).drawRect(xStart, sy - bandH,         w, bandH).endFill();
                        ng.beginFill(0x000000, 0.15).drawRect(xStart, sy - 2 * bandH,     w, bandH).endFill();
                        ng.beginFill(0x000000, 0.06).drawRect(xStart, sy - 3 * bandH,     w, bandH).endFill();
                        this.tileLayer.addChild(ng);
                    }

                    // 3) Thin contour outline (1px) — skip the side that abuts another wall
                    const outlines = [
                        [ 1,  0, wE],
                        [-1,  0, wW],
                        [ 0,  1, wS],
                        [ 0, -1, wN],
                    ];
                    for (const [ox, oy, skip] of outlines) {
                        if (skip) continue;
                        const ol = new PIXI.Sprite(tex);
                        ol.x = sx + ox; ol.y = sy + oy;
                        ol.width = drawSize; ol.height = drawSize;
                        ol.tint = 0x111118; ol.alpha = 0.55;
                        this.tileLayer.addChild(ol);
                    }

                    // 4) Main wall tile
                    const spr = new PIXI.Sprite(tex);
                    spr.x = sx; spr.y = sy;
                    spr.width = drawSize; spr.height = drawSize;
                    this.tileLayer.addChild(spr);

                    // 5) Top-edge rim highlight (light from above) when no wall to the north
                    if (!wN) {
                        const hl = new PIXI.Graphics();
                        hl.beginFill(0xFFFFFF, 0.26).drawRect(sx, sy,     drawSize, 2).endFill();
                        hl.beginFill(0xFFFFFF, 0.11).drawRect(sx, sy + 2, drawSize, 2).endFill();
                        this.tileLayer.addChild(hl);
                    }

                    // 6) Left-edge rim highlight (softer) when no wall to the west
                    if (!wW) {
                        const hl = new PIXI.Graphics();
                        hl.beginFill(0xFFFFFF, 0.14).drawRect(sx,     sy, 1, drawSize).endFill();
                        hl.beginFill(0xFFFFFF, 0.06).drawRect(sx + 1, sy, 1, drawSize).endFill();
                        this.tileLayer.addChild(hl);
                    }
                } else if (isObject) {
                    // === COLLISION OBJECT WITH GROUND SHADOW ===
                    const shadowG = new PIXI.Graphics();
                    shadowG.beginFill(0x000000, 0.35);
                    shadowG.drawEllipse(sx + drawSize / 2, sy + drawSize * 0.9, drawSize * 0.4, drawSize * 0.12);
                    shadowG.endFill();
                    this.tileLayer.addChild(shadowG);

                    addSpriteWithOutline(this.tileLayer, tex, sx, sy, drawSize, drawSize);
                    const spr = new PIXI.Sprite(tex);
                    spr.x = sx; spr.y = sy;
                    spr.width = drawSize; spr.height = drawSize;
                    this.tileLayer.addChild(spr);
                } else {
                    // === DECORATION (non-collision) - with ground shadow ===
                    const decShadow = new PIXI.Graphics();
                    decShadow.beginFill(0x000000, 0.25);
                    decShadow.drawEllipse(sx + drawSize / 2, sy + drawSize + drawSize * 0.08, drawSize * 0.3, drawSize * 0.07);
                    decShadow.endFill();
                    this.tileLayer.addChild(decShadow);

                    const spr = new PIXI.Sprite(tex);
                    spr.x = sx; spr.y = sy;
                    spr.width = drawSize; spr.height = drawSize;
                    this.tileLayer.addChild(spr);
                }
            }
        }
    }

    renderEntities(gameState, offsetX, offsetY) {
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
            if (ent.type === 'loot') this.renderLootContainer(ent.data, offsetX, offsetY, gameState);
            else if (ent.type === 'portal') this.renderPortal(ent.data, offsetX, offsetY, gameState);
            else if (ent.type === 'enemy') this.renderEnemy(ent.data, offsetX, offsetY, gameState);
            else if (ent.type === 'player') this.renderPlayer(ent.data, offsetX, offsetY, ent.id === gameState.playerId, gameState);
        }

        // Render bullets — viewport-culled + capped for performance.
        const bulletGfx = new PIXI.Graphics();
        if (!this._bulletTexCache) this._bulletTexCache = {};
        const screenW = this.app.screen.width, screenH = this.app.screen.height;
        const MAX_RENDERED_BULLETS = 200;
        let bulletCount = 0;
        // User setting: hide OTHER players' projectiles entirely to save CPU
        // in crowded areas. Our own bullets and enemy bullets always render.
        const hideOtherPlayerBullets = !!(gameState.settings
                && gameState.settings.graphics
                && gameState.settings.graphics.hideOtherPlayerBullets);
        const localPlayerId = gameState.playerId;

        for (const [id, bullet] of gameState.bullets) {
            // Filter out other players' bullets when the setting is enabled.
            // A bullet is a "player bullet" iff it has the PLAYER_PROJECTILE
            // flag. It's MINE iff its srcEntityId matches my player id (or it
            // was locally predicted and has a negative id).
            if (hideOtherPlayerBullets && bullet.flags
                    && bullet.flags.includes(ProjectileFlag.PLAYER_PROJECTILE)) {
                const isMine = bullet._predicted
                        || (bullet.srcEntityId !== undefined && bullet.srcEntityId === localPlayerId);
                if (!isMine) continue;
            }

            const sx = bullet.pos.x * SCALE + offsetX;
            const sy = bullet.pos.y * SCALE + offsetY;

            // Viewport culling — skip bullets outside screen bounds
            if (sx < -64 || sx > screenW + 64 || sy < -64 || sy > screenH + 64) continue;
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

    renderPlayer(player, offsetX, offsetY, isLocal, gameState) {
        const collisionSize = (player.size || PLAYER_SIZE) * SCALE;
        const size = PLAYER_RENDER_SIZE * SCALE;
        const renderOffset = (size - collisionSize) / 2;
        const px = isLocal && player._renderX !== undefined ? player._renderX : player.pos.x;
        const py = isLocal && player._renderY !== undefined ? player._renderY : player.pos.y;
        const smX = isLocal ? (player._smoothX || 0) * SCALE : 0;
        const smY = isLocal ? (player._smoothY || 0) * SCALE : 0;
        const sx = px * SCALE + offsetX - renderOffset + smX;
        const sy = py * SCALE + offsetY - renderOffset + smY;

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

        // Circular ground shadow under player
        const pShadow = new PIXI.Graphics();
        pShadow.beginFill(0x000000, 0.3);
        pShadow.drawEllipse(sx + size / 2, sy + size + size * 0.08, size * 0.4, size * 0.12);
        pShadow.endFill();
        this.entityLayer.addChild(pShadow);

        const spW = animDef?.spriteSize || BASE_SPRITE_SIZE;
        const spH = animDef?.spriteHeight || spW;
        const tex = this.getRegion(sheetKey, frameCol, row, spW, spH);
        if (tex) {
            const flipX = player.facing === 'left';

            const spr = new PIXI.Sprite(tex);
            spr.x = sx; spr.y = sy;
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

            addSpriteWithOutline(this.entityLayer, tex, sx, sy, size, size,
                flipX ? { flipX: true } : null);
            this.entityLayer.addChild(spr);
        } else {
            // Fallback: colored square
            const g = new PIXI.Graphics();
            g.beginFill(isLocal ? 0x40c040 : 0x4080e0);
            g.drawRect(sx, sy, size, size);
            g.endFill();
            this.entityLayer.addChild(g);
        }

        // HP and MP bars above player sprite
        const barWidth = size;
        const barHeight = 4;
        const barGap = 2;
        const barY = sy - barHeight * 2 - barGap - 4;

        // Get health/mana data
        const hp = isLocal ? gameState.health : (player.health || 0);
        const maxHp = isLocal ? (gameState.getComputedStats()?.hp || gameState.maxHealth || 100) : (player.maxHealth || 100);
        const mp = isLocal ? gameState.mana : (player.mana || 0);
        const maxMp = isLocal ? (gameState.getComputedStats()?.mp || gameState.maxMana || 100) : (player.maxMana || 100);
        const hpPct = maxHp > 0 ? Math.min(1, hp / maxHp) : 1;
        const mpPct = maxMp > 0 ? Math.min(1, mp / maxMp) : 1;

        const bars = new PIXI.Graphics();
        // HP bar background
        bars.beginFill(0x222222, 0.7);
        bars.drawRect(sx, barY, barWidth, barHeight);
        bars.endFill();
        // HP bar fill
        bars.beginFill(0x40c040, 0.9);
        bars.drawRect(sx, barY, barWidth * hpPct, barHeight);
        bars.endFill();
        // MP bar background
        bars.beginFill(0x222222, 0.7);
        bars.drawRect(sx, barY + barHeight + barGap, barWidth, barHeight);
        bars.endFill();
        // MP bar fill
        bars.beginFill(0x4080e0, 0.9);
        bars.drawRect(sx, barY + barHeight + barGap, barWidth * mpPct, barHeight);
        bars.endFill();
        this.entityLayer.addChild(bars);

        // Player name above bars (other players only — local player name goes in sidebar)
        let iconAnchorY = barY - 2;
        if (!isLocal) {
            const name = player.name || CLASS_NAMES[classId] || 'Player';
            const nameColor = GameRenderer.getNameColorHex(player.chatRole);
            const nameText = new PIXI.Text(name, {
                fontSize: 16, fill: nameColor,
                fontFamily: 'OryxSimplex, monospace', fontWeight: 'bold',
                stroke: 0x000000, strokeThickness: 3
            });
            nameText.anchor.set(0.5, 1);
            nameText.x = sx + size / 2;
            nameText.y = barY - 2;
            this.entityLayer.addChild(nameText);
            iconAnchorY = barY - 18;
        }

        // Status effect icons above health bars / name
        const playerEffects = isLocal ? gameState.effectIds : (player.effectIds || []);
        this._drawStatusIcons(playerEffects, sx + size / 2, iconAnchorY);
    }

    renderEnemy(enemy, offsetX, offsetY, gameState) {
        const sx = enemy.pos.x * SCALE + offsetX;
        const sy = enemy.pos.y * SCALE + offsetY;
        const size = (enemy.size || PLAYER_SIZE) * SCALE;

        // Try enemy sprite from data
        const enemyDef = gameState.enemyData[enemy.enemyId];
        let tex = null;
        if (enemyDef && enemyDef.spriteKey) {
            const sw = enemyDef.spriteSize || BASE_SPRITE_SIZE;
            const sh = enemyDef.spriteHeight || sw;
            tex = this.getRegion(enemyDef.spriteKey, enemyDef.col || 0, enemyDef.row || 0, sw, sh);
        }

        // Circular ground shadow under enemy
        const shadowG = new PIXI.Graphics();
        shadowG.beginFill(0x000000, 0.3);
        shadowG.drawEllipse(sx + size / 2, sy + size + size * 0.08, size * 0.4, size * 0.12);
        shadowG.endFill();
        this.entityLayer.addChild(shadowG);

        if (tex) {
            const spr = new PIXI.Sprite(tex);
            spr.x = sx; spr.y = sy;
            spr.width = size; spr.height = size;

            // Status effect tinting — all ProjectileEffectTypes that affect enemies
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
            addSpriteWithOutline(this.entityLayer, tex, sx, sy, size, size);
            this.entityLayer.addChild(spr);
        } else {
            const g = new PIXI.Graphics();
            g.beginFill(0xe04040);
            g.drawRect(sx, sy, size, size);
            g.endFill();
            this.entityLayer.addChild(g);
        }

        // Enemy name
        let enemyIconAnchorY = sy - 2;
        if (enemyDef) {
            const nameText = new PIXI.Text(enemyDef.name || `Enemy`, {
                fontSize: 16, fill: 0xff8080,
                fontFamily: 'OryxSimplex, monospace', fontWeight: 'bold',
                stroke: 0x000000, strokeThickness: 3
            });
            nameText.anchor.set(0.5, 1);
            nameText.x = sx + size / 2;
            nameText.y = sy - 2;
            this.entityLayer.addChild(nameText);
            enemyIconAnchorY = sy - 18;
        }

        // Status effect icons above enemy name
        if (enemy.effectIds) {
            this._drawStatusIcons(enemy.effectIds, sx + size / 2, enemyIconAnchorY);
        }
    }

    // renderBullet removed — bullets are now batched inline in renderEntities()

    renderLootContainer(loot, offsetX, offsetY, gameState) {
        const sx = loot.pos.x * SCALE + offsetX;
        const sy = loot.pos.y * SCALE + offsetY;
        const fullSize = this.tileSize * SCALE;
        const tier = loot.tier;
        const isChest = loot.isChest || tier === -1;
        const lootDef = gameState?.lootContainerDefs?.[tier];
        const renderFull = lootDef ? lootDef.fullSize : isChest;

        const size = renderFull ? fullSize : fullSize / 2;
        const ox = renderFull ? 0 : fullSize / 4;
        const oy = renderFull ? 0 : fullSize / 4;

        // Circular ground shadow (slightly below sprite)
        const shadowG = new PIXI.Graphics();
        shadowG.beginFill(0x000000, 0.3);
        shadowG.drawEllipse(sx + ox + size / 2, sy + oy + size + size * 0.08, size * 0.35, size * 0.1);
        shadowG.endFill();
        this.entityLayer.addChild(shadowG);

        // Data-driven loot sprite lookup
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
            spr.x = sx + ox; spr.y = sy + oy;
            spr.width = size; spr.height = size;
            this.entityLayer.addChild(spr);
        } else {
            const g = new PIXI.Graphics();
            g.beginFill(isChest ? 0xc8a86e : 0x8b6914);
            g.drawRect(sx + ox + 2, sy + oy + 2, size - 4, size - 4);
            g.endFill();
            this.entityLayer.addChild(g);
        }
    }

    renderPortal(portal, offsetX, offsetY, gameState) {
        const sx = portal.pos.x * SCALE + offsetX;
        const sy = portal.pos.y * SCALE + offsetY;
        const size = this.tileSize * SCALE;

        // Look up portal sprite from portal model data (portals.json)
        const portalDef = gameState ? gameState.portalData[portal.portalId] : null;
        let tex = null;
        if (portalDef && portalDef.spriteKey) {
            const sw = portalDef.spriteSize || BASE_SPRITE_SIZE;
            const sh = portalDef.spriteHeight || sw;
            tex = this.getRegion(portalDef.spriteKey, portalDef.col || 0,
                                 portalDef.row || 0, sw, sh);
        }

        // Circular ground shadow
        const portalShadow = new PIXI.Graphics();
        portalShadow.beginFill(0x000000, 0.3);
        portalShadow.drawEllipse(sx + size / 2, sy + size + size * 0.08, size * 0.4, size * 0.12);
        portalShadow.endFill();
        this.entityLayer.addChild(portalShadow);

        if (tex) {
            const spr = new PIXI.Sprite(tex);
            spr.x = sx; spr.y = sy;
            spr.width = size; spr.height = size;
            this.entityLayer.addChild(spr);
        } else {
            // Fallback: purple circle
            const g = new PIXI.Graphics();
            g.beginFill(0x8040c0, 0.6);
            g.drawCircle(sx + size / 2, sy + size / 2, size / 2);
            g.endFill();
            g.lineStyle(2, 0xc080ff, 0.8);
            g.drawCircle(sx + size / 2, sy + size / 2, size / 2);
            this.entityLayer.addChild(g);
        }
    }

    renderHealthBars(gameState, offsetX, offsetY) {
        this.healthBarGraphics.clear();

        for (const [id, enemy] of gameState.enemies) {
            if (enemy.maxHealth <= 0) continue;
            const sx = enemy.pos.x * SCALE + offsetX;
            const sy = enemy.pos.y * SCALE + offsetY;
            const size = (enemy.size || PLAYER_SIZE) * SCALE;
            const barW = size;
            const barH = 4;
            const barY = sy + size + 2;

            const pct = Math.max(0, enemy.health / enemy.maxHealth);

            // Background
            this.healthBarGraphics.beginFill(0x333333);
            this.healthBarGraphics.drawRect(sx, barY, barW, barH);
            this.healthBarGraphics.endFill();

            // Fill
            this.healthBarGraphics.beginFill(pct > 0.5 ? 0x40c040 : pct > 0.25 ? 0xc0c040 : 0xc04040);
            this.healthBarGraphics.drawRect(sx, barY, barW * pct, barH);
            this.healthBarGraphics.endFill();
        }
    }

    renderVisualEffects(gameState, offsetX, offsetY) {
        if (!gameState.visualEffects || gameState.visualEffects.length === 0) return;
        const now = Date.now();
        const g = new PIXI.Graphics();

        for (const fx of gameState.visualEffects) {
            const elapsed = now - fx.startTime;
            const progress = Math.min(elapsed / fx.duration, 1.0);
            const alpha = 1.0 - progress; // fade out over duration
            const sx = fx.x * SCALE + offsetX;
            const sy = fx.y * SCALE + offsetY;
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
                    const tx = fx.targetX * SCALE + offsetX;
                    const ty = fx.targetY * SCALE + offsetY;
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
                        const tx = fx.targetX * SCALE + offsetX;
                        const ty = fx.targetY * SCALE + offsetY;
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
                        const tx = fx.targetX * SCALE + offsetX;
                        const ty = fx.targetY * SCALE + offsetY;
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

    renderDamageTexts(gameState, offsetX, offsetY) {
        const TEXT_LIFE = 50; // must match game.js
        for (const dt of gameState.damageTexts) {
            const sx = dt.x * SCALE + offsetX;
            const sy = dt.y * SCALE + offsetY;
            const alpha = Math.max(0, dt.life / TEXT_LIFE);
            const colorStr = '#' + dt.color.toString(16).padStart(6, '0');
            // Scale text slightly larger when fresh, shrink as it fades
            const scale = 0.8 + 0.4 * (dt.life / TEXT_LIFE);
            const txt = new PIXI.Text(dt.text, {
                fontSize: 24, fill: colorStr,
                fontFamily: 'OryxSimplex, monospace', fontWeight: 'bold',
                stroke: '#000000', strokeThickness: 4
            });
            txt.anchor.set(0.5, 0.5);
            txt.x = sx; txt.y = sy;
            txt.alpha = alpha;
            txt.scale.set(scale);
            this.uiLayer.addChild(txt);
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
    _drawStatusIcons(effectIds, centerX, topY) {
        if (!effectIds || !effectIds.length) return;
        const active = [];
        for (const [eid, sym, color] of GameRenderer.STATUS_ICON_DEFS) {
            if (this._hasEffect(effectIds, eid)) active.push({ sym, color });
        }
        if (active.length === 0) return;

        const iconSize = 12;
        const iconGap = 2;
        const totalWidth = active.length * iconSize + (active.length - 1) * iconGap;
        let startX = centerX - totalWidth / 2;
        const y = topY - iconSize - 2;

        for (const { sym, color } of active) {
            // Background square
            const bg = new PIXI.Graphics();
            bg.beginFill(0x000000, 0.6);
            bg.drawRoundedRect(startX, y, iconSize, iconSize, 2);
            bg.endFill();
            bg.beginFill(color, 0.9);
            bg.drawRoundedRect(startX + 1, y + 1, iconSize - 2, iconSize - 2, 1);
            bg.endFill();
            this.entityLayer.addChild(bg);

            // Symbol text
            const txt = new PIXI.Text(sym, {
                fontSize: 9, fill: 0xFFFFFF,
                fontFamily: 'OryxSimplex, monospace', fontWeight: 'bold',
                stroke: 0x000000, strokeThickness: 1
            });
            txt.anchor.set(0.5, 0.5);
            txt.x = startX + iconSize / 2;
            txt.y = y + iconSize / 2;
            this.entityLayer.addChild(txt);

            startX += iconSize + iconGap;
        }
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
        const worldX = (screenX - screenW / 2) / SCALE + gameState.cameraX;
        const worldY = (screenY - screenH / 2) / SCALE + gameState.cameraY;
        return { x: worldX, y: worldY };
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
