// Matrix ID generation utilities

import { getRoomVersion, type EventIdFormat } from "../services/room-versions";
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

function isString(value: unknown): value is string {
  return typeof value === "string";
}

// Generate a random opaque ID using Web Crypto API
export function generateOpaqueId(length: number = 18): Promise<string> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Promise.resolve(base64UrlEncode(bytes));
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
  return new Uint8Array(Array.from(binary, (c) => c.codePointAt(0) ?? 0));
}

// Generate a user ID
export function formatUserId(localpart: string, serverName: ServerName): UserId {
  return `@${localpart}:${serverName}`;
}

// Parse a user ID into components
export function parseUserId(
  userId: string | null | undefined,
): { localpart: string; serverName: ServerName } | null {
  if (!isString(userId)) {
    return null;
  }

  const match = userId.match(/^@([^:]+):(.+)$/);
  if (!match) return null;
  return { localpart: match[1], serverName: match[2] };
}

// Generate a room ID
export async function generateRoomId(serverName: ServerName): Promise<RoomId> {
  const opaque = await generateOpaqueId(18);
  return `!${opaque}:${serverName}`;
}

// Parse a room ID
export function parseRoomId(
  roomId: string | null | undefined,
): { opaque: string; serverName: ServerName } | null {
  if (!isString(roomId)) {
    return null;
  }

  const match = roomId.match(/^!([^:]+):(.+)$/);
  if (!match) return null;
  return { opaque: match[1], serverName: match[2] };
}

// Generate an event ID appropriate for the given room version
export async function generateEventId(
  serverName: ServerName,
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
  return `$${opaque}`;
}

// Generate a legacy event ID (room version 1-2)
export async function generateLegacyEventId(serverName: ServerName): Promise<EventId> {
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
export function formatRoomAlias(localpart: string, serverName: ServerName): RoomAlias {
  return `#${localpart}:${serverName}`;
}

// Parse a room alias
export function parseRoomAlias(
  alias: string | null | undefined,
): { localpart: string; serverName: ServerName } | null {
  if (!isString(alias)) {
    return null;
  }

  const match = alias.match(/^#([^:]+):(.+)$/);
  if (!match) return null;
  return { localpart: match[1], serverName: match[2] };
}

// Generate a device ID
export async function generateDeviceId(): Promise<DeviceId> {
  const opaque = await generateOpaqueId(10);
  return opaque.toUpperCase();
}

// Generate an access token
export function generateAccessToken(): Promise<AccessToken> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Promise.resolve(`syt_${base64UrlEncode(bytes)}` as AccessToken);
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
  return Promise.resolve(`mlt_${base64UrlEncode(bytes)}` as LoginToken);
}

// Generate a refresh token (for token refresh flow)
export function generateRefreshToken(): Promise<RefreshToken> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Promise.resolve(`syr_${base64UrlEncode(bytes)}` as RefreshToken);
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
export function isLocalServerName(serverName: string, localServer: ServerName): boolean {
  return serverName.toLowerCase() === localServer.toLowerCase();
}

// Extract server name from Matrix ID
export function getServerName(id: string | null | undefined): ServerName | null {
  if (!isString(id)) {
    return null;
  }

  const match = id.match(/:([^:]+)$/);
  return match ? match[1] : null;
}

// Type guards for Matrix IDs

/**
 * Check if a value is a valid EventId.
 * Supports both v1-2 format ($opaque:domain) and v3+ format ($opaque).
 */
export function isEventId(value: unknown): value is EventId {
  if (!isString(value)) return false;
  return /^\$[^\s]+$/.test(value);
}

/**
 * Check if a value is a valid RoomId.
 * Format: !opaque:domain
 */
export function isRoomId(value: unknown): value is RoomId {
  if (typeof value !== "string") return false;
  return /^![^:]+:.+$/.test(value);
}

/**
 * Check if a value is a valid UserId.
 * Format: @localpart:domain
 */
export function isUserId(value: unknown): value is UserId {
  if (typeof value !== "string") return false;
  return /^@[^:]+:.+$/.test(value);
}

/**
 * Check if a value is a valid RoomAlias.
 * Format: #localpart:domain
 */
export function isRoomAlias(value: unknown): value is RoomAlias {
  if (typeof value !== "string") return false;
  return /^#[^:]+:.+$/.test(value);
}

// Validation castings - for safely converting database strings to typed IDs
// These functions perform runtime validation and return typed IDs or null

/**
 * Validate and cast a string to UserId.
 * Used when converting untrusted data from database to typed IDs.
 * @returns The typed UserId or null if validation fails
 */
export function toUserId(value: unknown): UserId | null {
  return isUserId(value) ? value : null;
}

/**
 * Validate and cast a string to RoomId.
 * Used when converting untrusted data from database to typed IDs.
 * @returns The typed RoomId or null if validation fails
 */
export function toRoomId(value: unknown): RoomId | null {
  return isRoomId(value) ? value : null;
}

/**
 * Validate and cast a string to EventId.
 * Used when converting untrusted data from database to typed IDs.
 * @returns The typed EventId or null if validation fails
 */
export function toEventId(value: unknown): EventId | null {
  return isEventId(value) ? value : null;
}

/**
 * Validate and cast a string to RoomAlias.
 * Used when converting untrusted data from database to typed IDs.
 * @returns The typed RoomAlias or null if validation fails
 */
export function toRoomAlias(value: unknown): RoomAlias | null {
  return isRoomAlias(value) ? value : null;
}
