import type { EventId, RoomId, ServerName, UserId } from "./matrix";

export interface PartialStateJoinMarker {
  roomId: RoomId;
  userId: UserId;
  eventId: EventId;
  remoteServer?: ServerName;
  serversInRoom?: ServerName[];
  encrypted?: boolean;
  startedAt: number;
}

export interface PartialStateStatus extends PartialStateJoinMarker {
  phase: "partial" | "catchup_published" | "complete";
  catchupPublishedAt?: number;
  completedAt?: number;
}
