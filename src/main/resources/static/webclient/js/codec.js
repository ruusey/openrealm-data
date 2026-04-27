// Binary packet codec matching OpenRealm's Java IOService serialization format.
// All multi-byte values are big-endian (network byte order).

const HEADER_SIZE = 5;

export class BinaryReader {
    constructor(data) {
        // Always normalize to a clean ArrayBuffer with byteOffset=0
        // to avoid issues with Uint8Array views from pako/slice
        if (data instanceof Uint8Array) {
            if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) {
                // Copy to a clean buffer
                const copy = new Uint8Array(data.byteLength);
                copy.set(data);
                this.buffer = copy.buffer;
            } else {
                this.buffer = data.buffer;
            }
        } else if (data instanceof ArrayBuffer) {
            this.buffer = data;
        } else {
            throw new Error('BinaryReader: unsupported input type');
        }
        this.view = new DataView(this.buffer);
        this.bytes = new Uint8Array(this.buffer);
        this.offset = 0;
    }

    remaining() { return this.buffer.byteLength - this.offset; }

    readByte() { const v = this.view.getInt8(this.offset); this.offset += 1; return v; }
    readUByte() { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
    readBoolean() { return this.readByte() !== 0; }
    readShort() { const v = this.view.getInt16(this.offset, false); this.offset += 2; return v; }
    readUShort() { const v = this.view.getUint16(this.offset, false); this.offset += 2; return v; }
    readInt() { const v = this.view.getInt32(this.offset, false); this.offset += 4; return v; }
    readFloat() { const v = this.view.getFloat32(this.offset, false); this.offset += 4; return v; }

    readLong() {
        const hi = this.view.getInt32(this.offset, false);
        const lo = this.view.getUint32(this.offset + 4, false);
        this.offset += 8;
        // Use BigInt to preserve full 64-bit precision for entity IDs
        return (BigInt(hi) << 32n) | BigInt(lo);
    }

    readString() {
        const len = this.readInt();
        if (len <= 0) return '';
        if (this.offset + len > this.buffer.byteLength) {
            throw new Error(`String read overflow: offset=${this.offset}, len=${len}, bufLen=${this.buffer.byteLength}`);
        }
        const slice = this.bytes.subarray(this.offset, this.offset + len);
        this.offset += len;
        return new TextDecoder('utf-8').decode(slice);
    }

    readArray(readFn) {
        const count = this.readInt();
        if (count < 0 || count > 100000) {
            throw new Error(`Suspicious array count: ${count} at offset ${this.offset - 4}`);
        }
        const arr = [];
        for (let i = 0; i < count; i++) arr.push(readFn(this));
        return arr;
    }

    readShortArray() { return this.readArray(r => r.readShort()); }
    readLongArray() { return this.readArray(r => r.readLong()); }
    readBooleanArray() { return this.readArray(r => r.readBoolean()); }
}

export class BinaryWriter {
    constructor(initialSize = 1024) {
        this.buffer = new ArrayBuffer(initialSize);
        this.view = new DataView(this.buffer);
        this.offset = 0;
    }

    ensure(bytes) {
        if (this.offset + bytes > this.buffer.byteLength) {
            const newSize = Math.max(this.buffer.byteLength * 2, this.offset + bytes);
            const newBuf = new ArrayBuffer(newSize);
            new Uint8Array(newBuf).set(new Uint8Array(this.buffer));
            this.buffer = newBuf;
            this.view = new DataView(this.buffer);
        }
    }

    writeByte(v) { this.ensure(1); this.view.setInt8(this.offset, v); this.offset += 1; }
    writeBoolean(v) { this.writeByte(v ? 1 : 0); }
    writeShort(v) { this.ensure(2); this.view.setInt16(this.offset, v, false); this.offset += 2; }
    writeInt(v) { this.ensure(4); this.view.setInt32(this.offset, v, false); this.offset += 4; }
    writeFloat(v) { this.ensure(4); this.view.setFloat32(this.offset, v, false); this.offset += 4; }

    writeLong(v) {
        this.ensure(8);
        const big = typeof v === 'bigint' ? v : BigInt(v);
        this.view.setInt32(this.offset, Number((big >> 32n) & 0xFFFFFFFFn), false);
        this.view.setUint32(this.offset + 4, Number(big & 0xFFFFFFFFn), false);
        this.offset += 8;
    }

    writeString(s) {
        if (!s || s.length === 0) { this.writeInt(0); return; }
        const encoded = new TextEncoder().encode(s);
        this.writeInt(encoded.length);
        this.ensure(encoded.length);
        new Uint8Array(this.buffer, this.offset, encoded.length).set(encoded);
        this.offset += encoded.length;
    }

    writeArray(arr, writeFn) {
        this.writeInt(arr ? arr.length : 0);
        if (arr) arr.forEach(item => writeFn(this, item));
    }

    toArray() { return new Uint8Array(this.buffer, 0, this.offset); }
}

// ---- Network Entity Types (hand-coded serialization matching Java) ----

export const NetStats = {
    read(r) {
        return { hp: r.readInt(), mp: r.readShort(), def: r.readShort(), att: r.readShort(),
                 spd: r.readShort(), dex: r.readShort(), vit: r.readShort(), wis: r.readShort() };
    },
    write(w, s) {
        w.writeInt(s.hp); w.writeShort(s.mp); w.writeShort(s.def); w.writeShort(s.att);
        w.writeShort(s.spd); w.writeShort(s.dex); w.writeShort(s.vit); w.writeShort(s.wis);
    }
};

export const NetDamage = {
    read(r) { return { projectileGroupId: r.readInt(), min: r.readShort(), max: r.readShort() }; },
    write(w, d) { w.writeInt(d.projectileGroupId); w.writeShort(d.min); w.writeShort(d.max); }
};

export const NetEffect = {
    read(r) {
        return { self: r.readBoolean(), effectId: r.readShort(), duration: r.readLong(),
                 cooldownDuration: r.readLong(), mpCost: r.readShort() };
    },
    write(w, e) {
        w.writeBoolean(e.self); w.writeShort(e.effectId); w.writeLong(e.duration);
        w.writeLong(e.cooldownDuration); w.writeShort(e.mpCost);
    }
};

export const NetGameItem = {
    read(r) {
        return {
            itemId: r.readInt(), uid: r.readString(), name: r.readString(), description: r.readString(),
            stats: NetStats.read(r), damage: NetDamage.read(r), effect: NetEffect.read(r),
            consumable: r.readBoolean(), tier: r.readByte(), targetSlot: r.readByte(),
            targetClass: r.readByte(), fameBonus: r.readByte()
        };
    },
    write(w, item) {
        w.writeInt(item.itemId); w.writeString(item.uid); w.writeString(item.name); w.writeString(item.description);
        NetStats.write(w, item.stats); NetDamage.write(w, item.damage); NetEffect.write(w, item.effect);
        w.writeBoolean(item.consumable); w.writeByte(item.tier); w.writeByte(item.targetSlot);
        w.writeByte(item.targetClass); w.writeByte(item.fameBonus);
    }
};

export const NetObjectMovement = {
    read(r) {
        const entityId = r.readLong(), entityType = r.readByte();
        const posX = r.readFloat(), posY = r.readFloat();
        const velX = r.readFloat(), velY = r.readFloat();
        const flags = r.readByte();
        return { entityId, entityType, posX, posY, velX, velY, flags, attacking: !!(flags & 0x01) };
    },
    write(w, m) {
        w.writeLong(m.entityId); w.writeByte(m.entityType);
        w.writeFloat(m.posX); w.writeFloat(m.posY); w.writeFloat(m.velX); w.writeFloat(m.velY);
        w.writeByte(m.flags || 0);
    }
};

export const Vector2f = {
    read(r) { return { x: r.readFloat(), y: r.readFloat() }; },
    write(w, v) { w.writeFloat(v.x); w.writeFloat(v.y); }
};

export const NetEnemy = {
    read(r) {
        return {
            id: r.readLong(), enemyId: r.readInt(), weaponId: r.readInt(), size: r.readShort(),
            pos: Vector2f.read(r), dX: r.readFloat(), dY: r.readFloat(),
            difficulty: r.readFloat(), health: r.readInt(), maxHealth: r.readInt(),
            shortId: r.readShort()
        };
    }
};

export const NetPlayer = {
    read(r) {
        return {
            id: r.readLong(), name: r.readString(), accountUuid: r.readString(),
            characterUuid: r.readString(), classId: r.readInt(), size: r.readShort(),
            pos: Vector2f.read(r), dX: r.readFloat(), dY: r.readFloat(),
            shortId: r.readShort(), chatRole: r.readString()
        };
    }
};

export const NetBullet = {
    read(r) {
        return {
            id: r.readLong(), projectileId: r.readInt(), size: r.readShort(),
            pos: Vector2f.read(r), dX: r.readFloat(), dY: r.readFloat(),
            angle: r.readFloat(), magnitude: r.readFloat(), range: r.readFloat(),
            damage: r.readShort(), flags: r.readShortArray(), invert: r.readBoolean(),
            timeStep: r.readLong(), amplitude: r.readShort(), frequency: r.readShort(),
            createdTime: r.readLong(),
            orbitCenterX: r.readFloat(), orbitCenterY: r.readFloat(),
            orbitRadius: r.readFloat(), orbitPhase: r.readFloat()
        };
    }
};

export const NetLootContainer = {
    read(r) {
        return {
            lootContainerId: r.readLong(), uid: r.readString(), isChest: r.readBoolean(),
            tier: r.readByte(), items: r.readArray(rr => NetGameItem.read(rr)),
            pos: Vector2f.read(r), spawnedTime: r.readLong(), contentsChanged: r.readBoolean()
        };
    }
};

export const NetPortal = {
    read(r) {
        return {
            id: r.readLong(), portalId: r.readShort(), fromRealmId: r.readLong(),
            toRealmId: r.readLong(), expires: r.readLong(), pos: Vector2f.read(r)
        };
    }
};

export const NetTile = {
    read(r) { return { tileId: r.readShort(), layer: r.readByte(), xIndex: r.readInt(), yIndex: r.readInt() }; }
};

export const NetGameItemRef = {
    read(r) { return { itemId: r.readInt(), slotIdx: r.readInt(), itemUuid: r.readString() }; }
};

export const NetInventorySelection = {
    read(r) {
        return { playerId: r.readLong(), selection: r.readBooleanArray(),
                 itemRefs: r.readArray(rr => NetGameItemRef.read(rr)) };
    }
};

export const NetTradeSelection = {
    read(r) { return { player0Selection: NetInventorySelection.read(r), player1Selection: NetInventorySelection.read(r) }; }
};

// ---- Packet IDs ----
export const PacketId = {
    PLAYER_MOVE: 1, UPDATE: 2, OBJECT_MOVE: 3, TEXT: 4, HEARTBEAT: 5,
    PLAYER_SHOOT: 6, COMMAND: 7, LOAD_MAP: 8, LOAD: 9, UNLOAD: 10,
    USE_ABILITY: 11, MOVE_ITEM: 12, USE_PORTAL: 13, TEXT_EFFECT: 14,
    PLAYER_DEATH: 15, REQUEST_TRADE: 16, ACCEPT_TRADE: 17,
    UPDATE_TRADE_SELECTION: 18, UPDATE_TRADE: 19, DEATH_ACK: 20,
    CREATE_EFFECT: 21, LOGIN_ACK: 22, GLOBAL_PLAYER_POSITION: 23,
    PLAYER_STATE: 24, COMPACT_MOVE: 25, PLAYER_POS_ACK: 26
};

// ---- Packet Readers (server → client packets read from binary) ----

export const PacketReaders = {
    [PacketId.UPDATE](r) {
        return {
            playerId: r.readLong(), playerName: r.readString(), stats: NetStats.read(r),
            health: r.readInt(), mana: r.readInt(), experience: r.readLong(),
            inventory: r.readArray(rr => NetGameItem.read(rr)),
            hpPotions: r.readByte(), mpPotions: r.readByte()
        };
    },
    [PacketId.PLAYER_STATE](r) {
        return {
            playerId: r.readLong(), health: r.readInt(), mana: r.readInt(),
            effectIds: r.readShortArray(), effectTimes: r.readLongArray()
        };
    },
    [PacketId.OBJECT_MOVE](r) {
        return { movements: r.readArray(rr => NetObjectMovement.read(rr)) };
    },
    [PacketId.TEXT](r) {
        return { from: r.readString(), to: r.readString(), message: r.readString() };
    },
    [PacketId.COMMAND](r) {
        return { playerId: r.readLong(), commandId: r.readByte(), command: r.readString() };
    },
    [PacketId.LOAD_MAP](r) {
        return {
            realmId: r.readLong(), mapId: r.readShort(), mapWidth: r.readShort(),
            mapHeight: r.readShort(), tiles: r.readArray(rr => NetTile.read(rr))
        };
    },
    [PacketId.LOAD](r) {
        return {
            players: r.readArray(rr => NetPlayer.read(rr)),
            enemies: r.readArray(rr => NetEnemy.read(rr)),
            bullets: r.readArray(rr => NetBullet.read(rr)),
            containers: r.readArray(rr => NetLootContainer.read(rr)),
            portals: r.readArray(rr => NetPortal.read(rr)),
            difficulty: r.readByte()
        };
    },
    [PacketId.UNLOAD](r) {
        return {
            players: r.readLongArray(), bullets: r.readLongArray(),
            enemies: r.readLongArray(), containers: r.readLongArray(), portals: r.readLongArray()
        };
    },
    [PacketId.TEXT_EFFECT](r) {
        return { textEffectId: r.readByte(), entityType: r.readByte(),
                 targetEntityId: r.readLong(), text: r.readString() };
    },
    [PacketId.PLAYER_DEATH](r) { return { playerId: r.readLong() }; },
    [PacketId.HEARTBEAT](r) { return { playerId: r.readLong(), timestamp: r.readLong() }; },
    [PacketId.CREATE_EFFECT](r) {
        return {
            effectType: r.readShort(),
            posX: r.readFloat(), posY: r.readFloat(),
            radius: r.readFloat(),
            duration: r.readShort(),
            targetPosX: r.readFloat(), targetPosY: r.readFloat()
        };
    },
    [PacketId.PLAYER_SHOOT](r) {
        return {
            projectileId: r.readLong(), entityId: r.readLong(), projectileGroupId: r.readInt(),
            destX: r.readFloat(), destY: r.readFloat(), srcX: r.readFloat(), srcY: r.readFloat()
        };
    },
    [PacketId.REQUEST_TRADE](r) { return { requestingPlayerName: r.readString() }; },
    [PacketId.ACCEPT_TRADE](r) {
        return {
            accepted: r.readBoolean(), player0: NetPlayer.read(r), player1: NetPlayer.read(r),
            player0Inv: r.readArray(rr => NetGameItem.read(rr)),
            player1Inv: r.readArray(rr => NetGameItem.read(rr))
        };
    },
    [PacketId.UPDATE_TRADE_SELECTION](r) { return { selection: NetInventorySelection.read(r) }; },
    [PacketId.UPDATE_TRADE](r) { return { selections: NetTradeSelection.read(r) }; },
    [PacketId.LOGIN_ACK](r) { return { playerId: r.readLong() }; },
    [PacketId.GLOBAL_PLAYER_POSITION](r) {
        return {
            players: r.readArray(rr => ({
                playerId: rr.readLong(),
                name: rr.readString(),
                x: rr.readFloat(),
                y: rr.readFloat(),
                teleportable: rr.readBoolean()
            }))
        };
    },
    [PacketId.DEATH_ACK](r) { return { playerId: r.readLong() }; },
    [PacketId.MOVE_ITEM](r) {
        return { playerId: r.readLong(), targetSlotIndex: r.readByte(), fromSlotIndex: r.readByte(),
                 drop: r.readBoolean(), consume: r.readBoolean() };
    },
    [PacketId.USE_ABILITY](r) {
        return { playerId: r.readLong(), posX: r.readFloat(), posY: r.readFloat() };
    },
    [PacketId.USE_PORTAL](r) {
        return { portalId: r.readLong(), fromRealmId: r.readLong(), playerId: r.readLong(),
                 toVault: r.readByte(), toNexus: r.readByte() };
    },
    [PacketId.PLAYER_MOVE](r) {
        return { entityId: r.readLong(), seq: r.readInt(), dirFlags: r.readByte() };
    },
    [PacketId.PLAYER_POS_ACK](r) {
        return { seq: r.readInt(), posX: r.readFloat(), posY: r.readFloat() };
    }
};

// ---- Packet Writers (client → server packets serialized to binary) ----

function buildPacket(packetId, writerFn) {
    const w = new BinaryWriter(256);
    w.writeByte(packetId);     // packet id
    w.writeInt(0);             // placeholder for length
    writerFn(w);
    // Write actual length (total frame size including header)
    const totalLen = w.offset;
    w.view.setInt32(1, totalLen, false);
    return w.toArray();
}

export const PacketWriters = {
    playerMove(entityId, seq, dirFlags) {
        return buildPacket(PacketId.PLAYER_MOVE, w => {
            w.writeLong(entityId); w.writeInt(seq); w.writeByte(dirFlags);
        });
    },

    heartbeat(playerId, timestamp) {
        return buildPacket(PacketId.HEARTBEAT, w => {
            w.writeLong(playerId); w.writeLong(timestamp);
        });
    },

    command(playerId, commandId, jsonStr) {
        return buildPacket(PacketId.COMMAND, w => {
            w.writeLong(playerId); w.writeByte(commandId); w.writeString(jsonStr);
        });
    },

    loginAck(playerId) {
        return buildPacket(PacketId.LOGIN_ACK, w => { w.writeLong(playerId); });
    },

    playerShoot(projectileId, entityId, projectileGroupId, destX, destY, srcX, srcY) {
        return buildPacket(PacketId.PLAYER_SHOOT, w => {
            w.writeLong(projectileId); w.writeLong(entityId); w.writeInt(projectileGroupId);
            w.writeFloat(destX); w.writeFloat(destY); w.writeFloat(srcX); w.writeFloat(srcY);
        });
    },

    useAbility(playerId, posX, posY) {
        return buildPacket(PacketId.USE_ABILITY, w => {
            w.writeLong(playerId); w.writeFloat(posX); w.writeFloat(posY);
        });
    },

    moveItem(playerId, targetSlot, fromSlot, drop, consume) {
        return buildPacket(PacketId.MOVE_ITEM, w => {
            w.writeLong(playerId); w.writeByte(targetSlot); w.writeByte(fromSlot);
            w.writeBoolean(drop); w.writeBoolean(consume);
        });
    },

    usePortal(portalId, fromRealmId, playerId, toVault, toNexus) {
        return buildPacket(PacketId.USE_PORTAL, w => {
            w.writeLong(portalId); w.writeLong(fromRealmId); w.writeLong(playerId);
            w.writeByte(toVault); w.writeByte(toNexus);
        });
    },

    text(from, to, message) {
        return buildPacket(PacketId.TEXT, w => {
            w.writeString(from); w.writeString(to); w.writeString(message);
        });
    },

    tradeSelection(playerId, selected) {
        // UpdatePlayerTradeSelectionPacket (id=18)
        // Contains NetInventorySelection: playerId + Boolean[] selection + NetGameItemRef[]
        return buildPacket(PacketId.UPDATE_TRADE_SELECTION, w => {
            w.writeLong(playerId);
            // Boolean[] selection (8 elements for slots 4-11)
            w.writeInt(selected.length);
            for (const s of selected) w.writeBoolean(!!s);
            // NetGameItemRef[] itemRefs — send empty array (server has authoritative items)
            w.writeInt(0);
        });
    },

    deathAck(playerId) {
        return buildPacket(PacketId.DEATH_ACK, w => { w.writeLong(playerId); });
    }
};

// ---- Frame Parsing (handles compression) ----

// Packet ID to name for debug logging
const PACKET_NAMES = {
    1:'PLAYER_MOVE', 2:'UPDATE', 3:'OBJECT_MOVE', 4:'TEXT', 5:'HEARTBEAT',
    6:'PLAYER_SHOOT', 7:'COMMAND', 8:'LOAD_MAP', 9:'LOAD', 10:'UNLOAD',
    11:'USE_ABILITY', 12:'MOVE_ITEM', 13:'USE_PORTAL', 14:'TEXT_EFFECT',
    15:'PLAYER_DEATH', 16:'REQUEST_TRADE', 17:'ACCEPT_TRADE',
    18:'UPDATE_TRADE_SELECTION', 19:'UPDATE_TRADE', 20:'DEATH_ACK',
    21:'CREATE_EFFECT', 22:'LOGIN_ACK', 23:'GLOBAL_PLAYER_POSITION',
    24:'PLAYER_STATE'
};

export function parseFrame(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < HEADER_SIZE) return null;

    let packetId = bytes[0];
    const compressed = (packetId & 0x80) !== 0;
    if (compressed) packetId = packetId & 0x7F;

    let payload;
    if (compressed) {
        // Compressed frame: [packetId|0x80][4B length][4B originalSize][deflated data]
        const compressedData = bytes.slice(HEADER_SIZE + 4);
        try {
            payload = pako.inflate(compressedData);
        } catch (e) {
            console.error(`[CODEC] Decompression failed for packet ${packetId} (${PACKET_NAMES[packetId]}), ` +
                `frameLen=${bytes.length}, compressedPayload=${compressedData.length}`, e);
            return null;
        }
    } else {
        payload = bytes.slice(HEADER_SIZE);
    }

    const reader = PacketReaders[packetId];
    if (!reader) {
        console.warn(`[CODEC] No reader for packet ${packetId}, skipping`);
        return { id: packetId, data: null };
    }

    try {
        const r = new BinaryReader(payload);
        const data = reader(r);
        return { id: packetId, data };
    } catch (e) {
        console.error(`[CODEC] Error parsing packet ${packetId} (${PACKET_NAMES[packetId]}), ` +
            `compressed=${compressed}, payloadLen=${payload.length}:`, e);
        return { id: packetId, data: null };
    }
}
