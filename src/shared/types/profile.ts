import { Schema } from "effect";
import type { JsonObject, JsonValue } from "./common";
import type { UserId } from "./matrix";

export const ProfileFieldSchema = Schema.Literal("displayname", "avatar_url");

export type ProfileField = Schema.Schema.Type<typeof ProfileFieldSchema>;

export interface ProfileResponseBody {
  displayname: string | null;
  avatar_url: string | null;
}

export interface ProfileQueryInput {
  userId: UserId;
  field?: ProfileField;
}

export interface SetDisplayNameRequest {
  displayname: string | null;
}

export interface SetAvatarUrlRequest {
  avatar_url: string | null;
}

export interface UpdateProfileFieldInput {
  authUserId: UserId;
  targetUserId: UserId;
  field: ProfileField;
  value: string | null;
}

export interface GetCustomProfileKeyInput {
  targetUserId: UserId;
  keyName: string;
}

export interface PutCustomProfileKeyInput {
  authUserId: UserId;
  targetUserId: UserId;
  keyName: string;
  value: JsonValue;
}

export interface DeleteCustomProfileKeyInput {
  authUserId: UserId;
  targetUserId: UserId;
  keyName: string;
}

export type ProfileCustomData = JsonObject;
export type ProfileCustomKeyResponseBody = Record<string, JsonValue>;

export const SetDisplayNameRequestSchema = Schema.Struct({
  displayname: Schema.Union(Schema.String, Schema.Null),
});

export const SetAvatarUrlRequestSchema = Schema.Struct({
  avatar_url: Schema.Union(Schema.String, Schema.Null),
});
