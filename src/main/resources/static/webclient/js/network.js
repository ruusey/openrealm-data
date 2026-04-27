// WebSocket connection to game server with packet dispatch

import { parseFrame, PacketId, PacketWriters } from './codec.js';

export class GameNetwork {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.handlers = {};
        this.onConnect = null;
        this.onDisconnect = null;
        this.heartbeatInterval = null;
        this.playerId = null;
    }

    on(packetId, handler) {
        if (!this.handlers[packetId]) this.handlers[packetId] = [];
        this.handlers[packetId].push(handler);
    }

    // Clear all handlers and state for clean reconnect
    reset() {
        this.handlers = {};
        this.onConnect = null;
        this.onDisconnect = null;
        this.stopHeartbeat();
        this.playerId = null;
        this.connected = false;
        if (this.ws) {
            this.ws.onclose = null; // Prevent disconnect callback
            this.ws.close();
            this.ws = null;
        }
    }

    connect(gameServerHost) {
        const host = gameServerHost || 'useast';
        let url;
        // Path-segment hosts (useast, euwest, local) route through the nginx
        // reverse proxy. Direct hostnames/IPs (localhost, 192.168.x.x) connect
        // straight to the game server on port 2223.
        const isProxyPath = !host.includes('.') && !host.includes(':') && host !== 'localhost';
        if (isProxyPath) {
            const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
            url = `${scheme}://${location.host}/ws/${host}`;
        } else {
            url = `ws://${host}:2223`;
        }
        console.log('[NET] Connecting to', url);

        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log('[NET] WebSocket connected');
            this.connected = true;
            if (this.onConnect) this.onConnect();
        };

        this.ws.onmessage = (event) => {
            try {
                const packet = parseFrame(event.data);
                if (!packet) return;
                if (packet.data === null) return;

                // Notify perf metrics of incoming server packet (for ping measurement)
                if (this.onServerPacket) this.onServerPacket();

                const handlers = this.handlers[packet.id];
                if (handlers) {
                    for (const h of handlers) {
                        try {
                            h(packet.data);
                        } catch (handlerErr) {
                            console.error(`[NET] Handler error for packet ${packet.id}:`, handlerErr);
                        }
                    }
                }
            } catch (e) {
                console.error('[NET] Error processing message:', e);
            }
        };

        this.ws.onclose = (event) => {
            console.log('[NET] WebSocket disconnected:', event.code, event.reason);
            this.connected = false;
            this.stopHeartbeat();
            if (this.onDisconnect) this.onDisconnect();
        };

        this.ws.onerror = (event) => {
            console.error('[NET] WebSocket error:', event);
        };
    }

    send(packetBytes) {
        if (this.ws && this.connected) {
            this.ws.send(packetBytes);
        }
    }

    sendLogin(characterUuid, email, password, token) {
        const loginMsg = JSON.stringify({ characterUuid, email, password, token: token || '' });
        this.send(PacketWriters.command(-1, 1, loginMsg)); // commandId 1 = LOGIN_REQUEST
    }

    sendLoginAck(playerId) {
        this.send(PacketWriters.loginAck(playerId));
    }

    sendPlayerMove(entityId, seq, vx, vy) {
        this.send(PacketWriters.playerMove(entityId, seq, vx, vy));
    }

    sendHeartbeat() {
        if (this.playerId !== null) {
            this.send(PacketWriters.heartbeat(this.playerId, Date.now()));
            if (this.onHeartbeatSend) this.onHeartbeatSend();
        }
    }

    startHeartbeat(playerId) {
        this.playerId = playerId;
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 1000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    sendShoot(projectileId, entityId, projectileGroupId, destX, destY, srcX, srcY) {
        this.send(PacketWriters.playerShoot(projectileId, entityId, projectileGroupId, destX, destY, srcX, srcY));
    }

    sendUseAbility(playerId, posX, posY) {
        this.send(PacketWriters.useAbility(playerId, posX, posY));
    }

    sendMoveItem(playerId, targetSlot, fromSlot, drop, consume) {
        console.log(`[NET] Sending MoveItem: target=${targetSlot} from=${fromSlot} drop=${drop} consume=${consume}`);
        this.send(PacketWriters.moveItem(playerId, targetSlot, fromSlot, drop, consume));
    }

    sendUsePortal(portalId, fromRealmId, playerId, toVault, toNexus) {
        this.send(PacketWriters.usePortal(portalId, fromRealmId, playerId, toVault, toNexus));
    }

    sendText(from, to, message) {
        this.send(PacketWriters.text(from, to, message));
    }

    sendConsumeShardStack(playerId, fromSlot) {
        this.send(PacketWriters.consumeShardStack(playerId, fromSlot));
    }

    sendInteractTile(playerId, tileX, tileY) {
        this.send(PacketWriters.interactTile(playerId, tileX, tileY));
    }

    sendForgeEnchant(playerId, targetItemSlot, crystalItemId, crystalSlotIndex, essenceSlotIndex, pixelX, pixelY) {
        this.send(PacketWriters.forgeEnchant(playerId, targetItemSlot, crystalItemId, crystalSlotIndex, essenceSlotIndex, pixelX, pixelY));
    }

    sendForgeDisenchant(playerId, targetItemSlot) {
        this.send(PacketWriters.forgeDisenchant(playerId, targetItemSlot));
    }

    disconnect() {
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
