export interface PartialStateJoinMarker {
  roomId: string;
  userId: string;
  eventId: string;
  remoteServer?: string;
  serversInRoom?: string[];
  encrypted?: boolean;
  startedAt: number;
}

export interface PartialStateStatus extends PartialStateJoinMarker {
  phase: "partial" | "catchup_published" | "complete";
  catchupPublishedAt?: number;
  completedAt?: number;
}
