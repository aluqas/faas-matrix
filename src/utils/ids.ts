// Matrix ID generation utilities

import type {
  AccessToken,
  DeviceId,
  EventId,
  LoginToken,
  RefreshToken,
  RoomAlias,
  RoomId,
  ServerName,
  TransactionId,
  UserId,
} from "../types";
import { getRoomVersion, type EventIdFormat } from "../services/room-versions";

// Generate a random opaque ID using Web Crypto API
export function generateOpaqueId(length: number = 18): Promise<string> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

// Base64 URL-safe encoding
export function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCodePoint(...bytes));
  return base64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// Base64 URL-safe decoding
export function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return new Uint8Array([...binary].map((c) => c.codePointAt(0)));
}

// Generate a user ID
export function formatUserId(localpart: string, serverName: ServerName | string): UserId {
  return `@${localpart}:${serverName}` as UserId;
}

// Parse a user ID into components
export function parseUserId(userId: UserId): { localpart: string; serverName: ServerName } | null {
  const match = userId.match(/^@([^:]+):(.+)$/);
  if (!match) return null;
  return { localpart: match[1], serverName: match[2] as ServerName };
}

// Generate a room ID
export async function generateRoomId(serverName: ServerName | string): Promise<RoomId> {
  const opaque = await generateOpaqueId(18);
  return `!${opaque}:${serverName}` as RoomId;
}

// Parse a room ID
export function parseRoomId(roomId: RoomId): { opaque: string; serverName: ServerName } | null {
  const match = roomId.match(/^!([^:]+):(.+)$/);
  if (!match) return null;
  return { opaque: match[1], serverName: match[2] as ServerName };
}

// Generate an event ID appropriate for the given room version
export async function generateEventId(
  serverName: ServerName | string,
  roomVersion?: string,
): Promise<EventId> {
  const format = getEventIdFormat(roomVersion);
  if (format === "v1") {
    // Room versions 1-2: $opaque:domain
    const opaque = await generateOpaqueId(18);
    return `$${opaque}:${serverName}` as EventId;
  }
  // Room versions 3+: $base64url (no domain)
  const opaque = await generateOpaqueId(32);
  return `$${opaque}` as EventId;
}

// Generate a legacy event ID (room version 1-2)
export async function generateLegacyEventId(serverName: ServerName | string): Promise<EventId> {
  const opaque = await generateOpaqueId(18);
  return `$${opaque}:${serverName}` as EventId;
}

// Get the event ID format for a room version
function getEventIdFormat(roomVersion?: string): EventIdFormat {
  if (!roomVersion) return "v4";
  const version = getRoomVersion(roomVersion);
  return version?.eventIdFormat ?? "v4";
}

// Format a room alias
export function formatRoomAlias(localpart: string, serverName: ServerName | string): RoomAlias {
  return `#${localpart}:${serverName}` as RoomAlias;
}

// Parse a room alias
export function parseRoomAlias(
  alias: RoomAlias,
): { localpart: string; serverName: ServerName } | null {
  const match = alias.match(/^#([^:]+):(.+)$/);
  if (!match) return null;
  return { localpart: match[1], serverName: match[2] as ServerName };
}

// Generate a device ID
export async function generateDeviceId(): Promise<DeviceId> {
  const opaque = await generateOpaqueId(10);
  return opaque.toUpperCase() as DeviceId;
}

// Generate an access token
export function generateAccessToken(): Promise<AccessToken> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `syt_${base64UrlEncode(bytes)}` as AccessToken;
}

// Generate a transaction ID
export async function generateTransactionId(): Promise<TransactionId> {
  const timestamp = Date.now().toString(36);
  const random = await generateOpaqueId(8);
  return `${timestamp}_${random}` as TransactionId;
}

// Generate a login token (for QR code authentication)
export function generateLoginToken(): Promise<LoginToken> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `mlt_${base64UrlEncode(bytes)}` as LoginToken;
}

// Generate a refresh token (for token refresh flow)
export function generateRefreshToken(): Promise<RefreshToken> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `syr_${base64UrlEncode(bytes)}` as RefreshToken;
}

// Validate localpart (username)
export function isValidLocalpart(localpart: string): boolean {
  // Matrix spec: lowercase letters, digits, and the characters .-_=/
  // Must not be empty and should be reasonable length
  if (!localpart || localpart.length > 255) return false;
  return /^[a-z0-9._=/-]+$/.test(localpart);
}

// Validate server name
export function isValidServerName(serverName: string): serverName is ServerName {
  // Can be domain or domain:port or IPv4 or [IPv6]:port
  if (!serverName || serverName.length > 255) return false;

  // Simple validation - domain with optional port
  const domainWithPort =
    /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(:\d+)?$/;
  const ipv4WithPort = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/;
  const ipv6WithPort = /^\[[\da-fA-F:]+\](:\d+)?$/;

  return (
    domainWithPort.test(serverName) ||
    ipv4WithPort.test(serverName) ||
    ipv6WithPort.test(serverName)
  );
}

// Check if server name is local
export function isLocalServerName(serverName: string, localServer: ServerName | string): boolean {
  return serverName.toLowerCase() === localServer.toLowerCase();
}

// Extract server name from Matrix ID
export function getServerName(id: string): ServerName | null {
  const match = id.match(/:([^:]+)$/);
  return match ? (match[1] as ServerName) : null;
}
