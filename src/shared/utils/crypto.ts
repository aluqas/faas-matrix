// Cryptographic utilities for Matrix homeserver

import { getDefaultRoomVersion } from "../../infra/db/room-versions";
import { base64UrlEncode, base64UrlDecode } from "./ids";

// Re-export for convenience
export { base64UrlEncode, base64UrlDecode };

// Hash a password using PBKDF2 (Web Crypto compatible alternative to Argon2)
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );

  // Format: $pbkdf2-sha256$iterations$salt$hash
  const saltB64 = btoa(String.fromCodePoint(...salt));
  const hashB64 = btoa(String.fromCodePoint(...new Uint8Array(hash)));
  return `$pbkdf2-sha256$100000$${saltB64}$${hashB64}`;
}

// Verify a password against a hash
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (
    parts.length !== 5 ||
    parts[1] !== "pbkdf2-sha256" ||
    parts[2] === undefined ||
    parts[3] === undefined ||
    parts[4] === undefined
  ) {
    return false;
  }

  const iterations = parseInt(parts[2], 10);
  const salt = Uint8Array.from(atob(parts[3]), (c) => c.codePointAt(0) ?? 0);
  const expectedHash = parts[4];

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );

  const hashB64 = btoa(String.fromCodePoint(...new Uint8Array(hash)));
  return hashB64 === expectedHash;
}

// SHA-256 hash
export async function sha256(data: string | Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return btoa(String.fromCodePoint(...new Uint8Array(hash)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function encodeUnpaddedBase64(bytes: Uint8Array): string {
  return btoa(String.fromCodePoint(...bytes)).replaceAll("=", "");
}

export function decodeUnpaddedBase64(str: string): Uint8Array {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
}

export function decodeMatrixBase64(str: string): Uint8Array {
  try {
    return decodeUnpaddedBase64(str);
  } catch {
    return base64UrlDecode(str);
  }
}

export function normalizeMatrixBase64(str: string): string {
  return encodeUnpaddedBase64(decodeMatrixBase64(str));
}

async function sha256UnpaddedBase64(data: string | Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return encodeUnpaddedBase64(new Uint8Array(hash));
}

// Hash an access token for storage
export function hashToken(token: string): Promise<string> {
  return sha256(token);
}

// Ed25519 algorithm parameters for Cloudflare Workers
// Note: NODE-ED25519 is Cloudflare Workers' proprietary Ed25519 implementation
interface Ed25519Params {
  name: "NODE-ED25519";
  namedCurve: "NODE-ED25519";
}

interface Ed25519KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

// Generate Ed25519 key pair for signing using Cloudflare Workers' NODE-ED25519 algorithm
export async function generateSigningKeyPair(): Promise<{
  publicKey: string;
  privateKeyJwk: JsonWebKey;
  keyId: string;
}> {
  // Generate Ed25519 key pair using Cloudflare Workers' native support
  const keyPair = (await crypto.subtle.generateKey(
    { name: "NODE-ED25519", namedCurve: "NODE-ED25519" } as Ed25519Params,
    true, // extractable
    ["sign", "verify"],
  )) as Ed25519KeyPair;

  // Export the public key as JWK to get the raw key bytes
  const publicKeyJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  const privateKeyJwk = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as JsonWebKey;

  // Get raw public key bytes from the JWK 'x' parameter
  const publicKeyBytes = base64UrlDecode(publicKeyJwk.x!);

  // Generate key ID from first 4 bytes of public key hash (for uniqueness)
  const keyIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKeyBytes)).slice(
    0,
    4,
  );
  const keyId = `ed25519:${Array.from(keyIdHash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  return {
    publicKey: encodeUnpaddedBase64(publicKeyBytes),
    privateKeyJwk,
    keyId,
  };
}

// Legacy function for backwards compatibility during migration
// Returns the old format but with a proper key
export async function generateSigningKeyPairLegacy(): Promise<{
  publicKey: string;
  privateKey: string;
  keyId: string;
}> {
  const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
  return {
    publicKey,
    privateKey: JSON.stringify(privateKeyJwk),
    keyId,
  };
}

// Sign a JSON object with Ed25519 per Matrix spec
export async function signJson(
  obj: Record<string, unknown>,
  serverName: string,
  keyId: string,
  privateKeyJwk: JsonWebKey | string,
): Promise<Record<string, unknown>> {
  // Parse JWK if passed as string (for backwards compatibility)
  const jwk: JsonWebKey =
    typeof privateKeyJwk === "string" ? JSON.parse(privateKeyJwk) : privateKeyJwk;

  // Remove signatures and unsigned before signing (per Matrix spec)
  const toSign = { ...obj };
  delete toSign["signatures"];
  delete toSign["unsigned"];

  // Import the private key
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "NODE-ED25519", namedCurve: "NODE-ED25519" } as Ed25519Params,
    false,
    ["sign"],
  );

  // Get canonical JSON representation
  const canonical = canonicalJson(toSign);

  // Sign the canonical JSON
  const signatureBytes = await crypto.subtle.sign(
    { name: "NODE-ED25519" },
    privateKey,
    new TextEncoder().encode(canonical),
  );

  // Encode signature as unpadded base64
  const signatureB64 = encodeUnpaddedBase64(new Uint8Array(signatureBytes));

  // Merge with existing signatures if present
  const existingSignatures = (obj.signatures as Record<string, Record<string, string>>) ?? {};
  const serverSignatures = existingSignatures[serverName];
  const normalizedServerSignatures = serverSignatures || {};

  return {
    ...obj,
    signatures: {
      ...existingSignatures,
      [serverName]: {
        ...normalizedServerSignatures,
        [keyId]: signatureB64,
      },
    },
  };
}

// Verify an Ed25519 signature on a JSON object
export async function verifySignature(
  obj: Record<string, unknown>,
  serverName: string,
  keyId: string,
  publicKeyB64: string,
): Promise<boolean> {
  try {
    // Get the signature
    const signatures = obj.signatures as Record<string, Record<string, string>> | undefined;
    const signature = signatures?.[serverName]?.[keyId];
    if (!signature) {
      return false;
    }

    // Remove signatures and unsigned before verifying
    const toVerify = { ...obj };
    delete toVerify["signatures"];
    delete toVerify["unsigned"];

    // Decode the public key
    const publicKeyBytes = decodeMatrixBase64(publicKeyB64);

    // Import the public key
    const publicKey = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "NODE-ED25519", namedCurve: "NODE-ED25519" } as Ed25519Params,
      false,
      ["verify"],
    );

    // Decode the signature
    const signatureBytes = decodeMatrixBase64(signature);

    // Get canonical JSON
    const canonical = canonicalJson(toVerify);

    // Verify the signature
    return await crypto.subtle.verify(
      { name: "NODE-ED25519" },
      publicKey,
      signatureBytes,
      new TextEncoder().encode(canonical),
    );
  } catch (error) {
    console.error("Signature verification failed:", error);
    return false;
  }
}

// Canonical JSON for signing
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return "null";
  }

  if (typeof obj === "boolean" || typeof obj === "number") {
    return JSON.stringify(obj);
  }

  if (typeof obj === "string") {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    const items = obj.map((item) => canonicalJson(item));
    return `[${items.join(",")}]`;
  }

  if (typeof obj === "object") {
    const keys = Object.keys(obj).toSorted((left: string, right: string) =>
      left.localeCompare(right),
    );
    const pairs = keys
      .filter((key) => (obj as Record<string, unknown>)[key] !== undefined)
      .map((key) => {
        const value = canonicalJson((obj as Record<string, unknown>)[key]);
        return `${JSON.stringify(key)}:${value}`;
      });
    return `{${pairs.join(",")}}`;
  }

  return "null";
}

type ReferenceHashRedactionVariant = "v1" | "v2" | "v3" | "v4" | "v5";

function getReferenceHashRedactionVariant(roomVersion?: string): ReferenceHashRedactionVariant {
  const version = roomVersion ?? getDefaultRoomVersion();
  switch (version) {
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
      return "v1";
    case "6":
    case "7":
      return "v2";
    case "8":
      return "v3";
    case "9":
    case "10":
      return "v4";
    default:
      return "v5";
  }
}

function getReferenceHashTopLevelKeys(roomVersion?: string): string[] {
  const variant = getReferenceHashRedactionVariant(roomVersion);
  if (variant === "v5") {
    return [
      "type",
      "room_id",
      "sender",
      "state_key",
      "content",
      "hashes",
      "signatures",
      "depth",
      "prev_events",
      "auth_events",
      "origin_server_ts",
    ];
  }

  return [
    "event_id",
    "type",
    "room_id",
    "sender",
    "state_key",
    "content",
    "hashes",
    "signatures",
    "depth",
    "prev_events",
    "auth_events",
    "origin_server_ts",
    "prev_state",
    "origin",
    "membership",
  ];
}

function getReferenceHashContentKeys(eventType: string, roomVersion?: string): string[] | "all" {
  switch (getReferenceHashRedactionVariant(roomVersion)) {
    case "v1":
      switch (eventType) {
        case "m.room.member":
          return ["membership"];
        case "m.room.create":
          return ["creator"];
        case "m.room.join_rules":
          return ["join_rule"];
        case "m.room.power_levels":
          return [
            "ban",
            "events",
            "events_default",
            "kick",
            "redact",
            "state_default",
            "users",
            "users_default",
          ];
        case "m.room.aliases":
          return ["aliases"];
        case "m.room.history_visibility":
          return ["history_visibility"];
        default:
          return [];
      }
    case "v2":
      switch (eventType) {
        case "m.room.member":
          return ["membership"];
        case "m.room.create":
          return ["creator"];
        case "m.room.join_rules":
          return ["join_rule"];
        case "m.room.power_levels":
          return [
            "ban",
            "events",
            "events_default",
            "kick",
            "redact",
            "state_default",
            "users",
            "users_default",
          ];
        case "m.room.history_visibility":
          return ["history_visibility"];
        default:
          return [];
      }
    case "v3":
      switch (eventType) {
        case "m.room.member":
          return ["membership"];
        case "m.room.create":
          return ["creator"];
        case "m.room.join_rules":
          return ["join_rule", "allow"];
        case "m.room.power_levels":
          return [
            "ban",
            "events",
            "events_default",
            "kick",
            "redact",
            "state_default",
            "users",
            "users_default",
          ];
        case "m.room.history_visibility":
          return ["history_visibility"];
        default:
          return [];
      }
    case "v4":
      switch (eventType) {
        case "m.room.member":
          return ["membership", "join_authorised_via_users_server"];
        case "m.room.create":
          return ["creator"];
        case "m.room.join_rules":
          return ["join_rule", "allow"];
        case "m.room.power_levels":
          return [
            "ban",
            "events",
            "events_default",
            "kick",
            "redact",
            "state_default",
            "users",
            "users_default",
          ];
        case "m.room.history_visibility":
          return ["history_visibility"];
        default:
          return [];
      }
    case "v5":
      switch (eventType) {
        case "m.room.member":
          return ["membership", "join_authorised_via_users_server"];
        case "m.room.create":
          return "all";
        case "m.room.join_rules":
          return ["join_rule", "allow"];
        case "m.room.power_levels":
          return [
            "ban",
            "events",
            "events_default",
            "invite",
            "kick",
            "redact",
            "state_default",
            "users",
            "users_default",
          ];
        case "m.room.history_visibility":
          return ["history_visibility"];
        case "m.room.redaction":
          return ["redacts"];
        default:
          return [];
      }
  }
}

function redactEventForReferenceHash(
  event: Record<string, unknown>,
  roomVersion?: string,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  const topLevelKeys = getReferenceHashTopLevelKeys(roomVersion);

  for (const key of topLevelKeys) {
    if (event[key] !== undefined) {
      redacted[key] = event[key];
    }
  }

  if ("content" in event) {
    const content =
      event.content && typeof event.content === "object" && !Array.isArray(event.content)
        ? (event.content as Record<string, unknown>)
        : {};
    const allowedContentKeys = getReferenceHashContentKeys(
      typeof event.type === "string" ? event.type : "",
      roomVersion,
    );
    redacted.content =
      allowedContentKeys === "all"
        ? { ...content }
        : Object.fromEntries(
            allowedContentKeys
              .filter((key) => content[key] !== undefined)
              .map((key) => [key, content[key]]),
          );
  }

  return redacted;
}

export function calculateReferenceHash(
  event: Record<string, unknown>,
  roomVersion?: string,
): Promise<string> {
  return calculateReferenceHashWithEncoding(event, roomVersion, "urlsafe");
}

export function calculateReferenceHashStandard(
  event: Record<string, unknown>,
  roomVersion?: string,
): Promise<string> {
  return calculateReferenceHashWithEncoding(event, roomVersion, "standard");
}

function calculateReferenceHashWithEncoding(
  event: Record<string, unknown>,
  roomVersion: string | undefined,
  encoding: "urlsafe" | "standard",
): Promise<string> {
  const toHash = redactEventForReferenceHash(event, roomVersion);
  delete toHash["signatures"];
  delete toHash["unsigned"];
  delete toHash["event_id"];

  const canonical = canonicalJson(toHash);
  return encoding === "standard" ? sha256UnpaddedBase64(canonical) : sha256(canonical);
}

export async function calculateReferenceHashEventId(
  event: Record<string, unknown>,
  roomVersion?: string,
): Promise<string> {
  return `$${await calculateReferenceHash(event, roomVersion)}`;
}

export async function calculateReferenceHashEventIdStandard(
  event: Record<string, unknown>,
  roomVersion?: string,
): Promise<string> {
  return `$${await calculateReferenceHashStandard(event, roomVersion)}`;
}

// Calculate content hash for PDU
export function calculateContentHash(content: Record<string, unknown>): Promise<string> {
  // Remove signatures and unsigned before hashing
  const toHash = { ...content };
  delete toHash["signatures"];
  delete toHash["unsigned"];
  delete toHash["hashes"];

  const canonical = canonicalJson(toHash);
  return sha256UnpaddedBase64(canonical);
}

// Verify content hash
export async function verifyContentHash(
  content: Record<string, unknown>,
  expectedHash: string,
): Promise<boolean> {
  const actualHash = await calculateContentHash(content);
  try {
    const actualBytes = decodeUnpaddedBase64(actualHash);
    const expectedBytes = decodeUnpaddedBase64(
      expectedHash.replaceAll("-", "+").replaceAll("_", "/"),
    );
    if (actualBytes.length !== expectedBytes.length) {
      return false;
    }
    return actualBytes.every((value, index) => value === expectedBytes[index]);
  } catch {
    return false;
  }
}

// Generate a random string for CSRF tokens, etc.
export function generateRandomString(length: number = 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const charsLen = chars.length; // 62 characters
  // Use rejection sampling to avoid modulo bias
  // 256 % 62 = 8, so we reject values >= 248 to ensure uniform distribution
  const maxValid = 256 - (256 % charsLen); // 248
  const result: string[] = [];

  while (result.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length - result.length));
    for (const b of bytes) {
      if (b < maxValid && result.length < length) {
        result.push(chars[b % charsLen]);
      }
    }
  }

  return result.join("");
}
