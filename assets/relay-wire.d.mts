export const RELAY_PROTOCOL: string;
export const FRAME_CHUNK_BYTES: number;
export const MAX_WIRE_BYTES: number;
export const MAX_FRAME_BYTES: number;
export const CHANNEL_PATTERN: RegExp;
export const SECRET_PATTERN: RegExp;
export type RelayRole = "phone" | "runtime";
export interface RelayKeys {
  token: string;
  sendKey: CryptoKey;
  receiveKey: CryptoKey;
}
export function base64url(bytes: Uint8Array): string;
export function randomId(): string;
export function tokenHash(token: string): Promise<string>;
export function relayKeys(channel: string, secret: string, role: "phone"): Promise<RelayKeys>;
export function relayKeys(channel: string, secret: string, role: "runtime", runtimeSecret: string): Promise<RelayKeys & { phoneTokenHash: string }>;
export function relayWire(keys: RelayKeys): {
  pack(value: unknown): AsyncGenerator<ArrayBuffer>;
  unpack(frame: ArrayBuffer): Promise<unknown>;
};
export function relayUrl(base: string | URL, channel: string, role: RelayRole): URL;
export function useRelaySocket(socket: WebSocket, keys: RelayKeys, onPacket: (packet: unknown) => void): (packet: unknown) => Promise<void>;
