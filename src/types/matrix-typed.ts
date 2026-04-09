import type { JsonObject } from "./common";
import type {
  AccountDataEvent,
  ClientEvent,
  EphemeralEvent,
  EventType,
  PDU,
  StateKey,
  ToDeviceEvent,
} from "./matrix";

export type MatrixEventOf<
  TContent extends JsonObject = JsonObject,
  TType extends EventType = EventType,
> = Omit<ClientEvent, "type" | "content"> & {
  type: TType;
  content: TContent;
};

export type StateEventOf<
  TContent extends JsonObject = JsonObject,
  TType extends EventType = EventType,
  TStateKey extends StateKey = StateKey,
> = MatrixEventOf<TContent, TType> & {
  state_key: TStateKey;
};

export type PduOf<
  TContent extends JsonObject = JsonObject,
  TType extends EventType = EventType,
> = Omit<PDU, "type" | "content"> & {
  type: TType;
  content: TContent;
};

export type EphemeralEventOf<
  TContent extends JsonObject = JsonObject,
  TType extends EventType = EventType,
> = Omit<EphemeralEvent, "type" | "content"> & {
  type: TType;
  content: TContent;
};

export type AccountDataEventOf<
  TContent extends JsonObject = JsonObject,
  TType extends EventType = EventType,
> = Omit<AccountDataEvent, "type" | "content"> & {
  type: TType;
  content: TContent;
};

export type ToDeviceEventOf<
  TContent extends JsonObject = JsonObject,
  TType extends EventType = EventType,
> = Omit<ToDeviceEvent, "type" | "content"> & {
  type: TType;
  content: TContent;
};
