// Browser and runtime share the wire format. The Worker only sees the encrypted frames.
export const RELAY_PROTOCOL = "human-use-v1";
export const FRAME_CHUNK_BYTES = 48 * 1024;
export const MAX_WIRE_BYTES = 12 * 1024 * 1024;
const NONCE_BYTES = 12;
const HEADER_BYTES = 20;
const TAG_BYTES = 16;
export const MAX_FRAME_BYTES = NONCE_BYTES + HEADER_BYTES + FRAME_CHUNK_BYTES + TAG_BYTES;
export const CHANNEL_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const text = new TextEncoder();

export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomId() {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

async function material(channel, secret) {
  if (!CHANNEL_PATTERN.test(channel) || !SECRET_PATTERN.test(secret)) throw new Error("Invalid relay pairing identity");
  const decoded = Uint8Array.from(atob(secret.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", decoded, "HKDF", false, ["deriveKey", "deriveBits"]);
  const params = label => ({ name: "HKDF", hash: "SHA-256", salt: text.encode(channel), info: text.encode(`${RELAY_PROTOCOL}/${label}`) });
  return {
    token: async role => base64url(new Uint8Array(await crypto.subtle.deriveBits(params(`auth/${role}`), key, 256))),
    cipher: role => crypto.subtle.deriveKey(params(`frames/${role}`), key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
  };
}

export async function tokenHash(token) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(token))));
}

export async function relayKeys(channel, secret, role, runtimeSecret) {
  const keys = await material(channel, secret);
  const isRuntime = role === "runtime";
  const peer = isRuntime ? "phone" : "runtime";
  const phoneToken = await keys.token("phone");
  const [token, sendKey, receiveKey] = await Promise.all([
    isRuntime ? material(channel, runtimeSecret).then(privateKeys => privateKeys.token("runtime")) : phoneToken,
    keys.cipher(role),
    keys.cipher(peer)
  ]);
  return { token, ...(isRuntime ? { phoneTokenHash: await tokenHash(phoneToken) } : {}), sendKey, receiveKey };
}

/** Chunks are ordered within a socket. All message coordinates are authenticated and encrypted. */
export function relayWire({ sendKey, receiveKey }) {
  let receive = null;
  return {
    async *pack(value) {
      const payload = text.encode(JSON.stringify(value));
      if (payload.length > MAX_WIRE_BYTES) throw new Error("Relay message is too large");
      const id = crypto.getRandomValues(new Uint8Array(16));
      const count = Math.max(1, Math.ceil(payload.length / FRAME_CHUNK_BYTES));
      for (let index = 0; index < count; index++) {
        const chunk = payload.subarray(index * FRAME_CHUNK_BYTES, (index + 1) * FRAME_CHUNK_BYTES);
        const plain = new Uint8Array(HEADER_BYTES + chunk.byteLength);
        plain.set(id);
        const header = new DataView(plain.buffer);
        header.setUint16(16, index);
        header.setUint16(18, count);
        plain.set(chunk, HEADER_BYTES);
        const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
        const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sendKey, plain);
        const frame = new Uint8Array(NONCE_BYTES + encrypted.byteLength);
        frame.set(iv);
        frame.set(new Uint8Array(encrypted), NONCE_BYTES);
        yield frame.buffer;
      }
    },
    async unpack(frame) {
      if (!(frame instanceof ArrayBuffer) || frame.byteLength <= NONCE_BYTES + HEADER_BYTES + TAG_BYTES || frame.byteLength > MAX_FRAME_BYTES) {
        throw new Error("Invalid relay frame size");
      }
      const bytes = new Uint8Array(frame);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, NONCE_BYTES) }, receiveKey, bytes.subarray(NONCE_BYTES));
      const header = new DataView(plain);
      const id = base64url(new Uint8Array(plain, 0, 16));
      const index = header.getUint16(16);
      const count = header.getUint16(18);
      if (!count || count > Math.ceil(MAX_WIRE_BYTES / FRAME_CHUNK_BYTES) || index >= count) throw new Error("Invalid relay chunk count");
      // A reconnected peer may have lost its previous packet partway through.
      if (index === 0) receive = { id, count, chunks: [], size: 0 };
      if (!receive || id !== receive.id || count !== receive.count || index !== receive.chunks.length) throw new Error("Out-of-order relay chunk");
      const chunk = new Uint8Array(plain, HEADER_BYTES);
      receive.size += chunk.byteLength;
      if (receive.size > MAX_WIRE_BYTES) throw new Error("Relay message is too large");
      receive.chunks.push(chunk);
      if (receive.chunks.length !== count) return null;
      const payload = new Uint8Array(receive.size);
      let offset = 0;
      for (const part of receive.chunks) { payload.set(part, offset); offset += part.byteLength; }
      receive = null;
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    }
  };
}

export function relayUrl(base, channel, role) {
  const url = new URL(`/channel/${channel}/${role}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

/** Keep outgoing packets and asynchronous decryptions ordered even while requests are concurrent. */
export function useRelaySocket(socket, keys, onPacket) {
  const wire = relayWire(keys);
  let sending = Promise.resolve();
  let receiving = Promise.resolve();
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", event => {
    receiving = receiving.then(async () => {
      const packet = await wire.unpack(event.data);
      if (packet !== null) onPacket(packet);
    }).catch(() => socket.close(4002, "invalid frame"));
  });
  return value => {
    const sendingPacket = sending.then(async () => {
      for await (const frame of wire.pack(value)) {
        if (socket.readyState !== 1) throw new Error("Relay socket is closed");
        socket.send(frame);
      }
    });
    sending = sendingPacket.catch(() => {});
    return sendingPacket;
  };
}
