import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  executeKyselyRun,
  type CompiledQuery,
} from "../../infra/db/kysely";
import type { Generated } from "kysely";
import type { RoomId, UserId } from "../../shared/types";
import type {
  AccountDataSyncEvent,
  StoredAccountDataRecord,
} from "../../shared/types/account-data";
import { parseStoredAccountDataContent } from "../../shared/types/account-data";

interface AccountDataRow {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
  deleted: number;
}

interface AccountDataChangeRow {
  id: Generated<number>;
  user_id: string;
  room_id: string;
  event_type: string;
  stream_position: number;
  created_at: Generated<number>;
}

interface EventStreamRow {
  stream_ordering: number;
}

interface StreamPositionRow {
  stream_name: string;
  position: number;
}

interface AccountDataDatabase {
  account_data: AccountDataRow;
  account_data_changes: AccountDataChangeRow;
  events: EventStreamRow;
  stream_positions: StreamPositionRow;
}

const qb = createKyselyBuilder<AccountDataDatabase>();

function toStoredAccountDataRecord(row: AccountDataRow): StoredAccountDataRecord {
  return {
    userId: row.user_id as StoredAccountDataRecord["userId"],
    roomId: row.room_id as StoredAccountDataRecord["roomId"],
    eventType: row.event_type,
    content: parseStoredAccountDataContent(row.content),
    deleted: row.deleted === 1,
  };
}

function toAccountDataSyncEvent(
  row: Pick<AccountDataRow, "event_type" | "content">,
): AccountDataSyncEvent {
  return {
    type: row.event_type,
    content: parseStoredAccountDataContent(row.content),
  };
}

export async function getNextAccountDataStreamPosition(db: D1Database): Promise<number> {
  const eventMax = await executeKyselyQueryFirst<{ max_pos: number | null }>(
    db,
    qb.selectFrom("events").select((eb) => eb.fn.max("stream_ordering").as("max_pos")),
  );
  const accountDataMax = await executeKyselyQueryFirst<{ max_pos: number | null }>(
    db,
    qb
      .selectFrom("account_data_changes")
      .select((eb) => eb.fn.max("stream_position").as("max_pos")),
  );

  return Math.max(eventMax?.max_pos ?? 0, accountDataMax?.max_pos ?? 0) + 1;
}

export function buildRecordAccountDataChangeQuery(
  userId: UserId,
  roomId: RoomId | "",
  eventType: string,
  streamPosition: number,
): CompiledQuery {
  return qb.insertInto("account_data_changes").values({
    user_id: userId,
    room_id: roomId,
    event_type: eventType,
    stream_position: streamPosition,
  });
}

export function buildUpsertAccountDataRecordQuery(
  userId: UserId,
  roomId: RoomId | "",
  eventType: string,
  content: string,
): CompiledQuery {
  return qb
    .insertInto("account_data")
    .values({
      user_id: userId,
      room_id: roomId,
      event_type: eventType,
      content,
      deleted: 0,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "room_id", "event_type"]).doUpdateSet({
        content: (eb) => eb.ref("excluded.content"),
        deleted: 0,
      }),
    );
}

export function buildMarkAccountDataDeletedQuery(
  userId: UserId,
  roomId: RoomId | "",
  eventType: string,
): CompiledQuery {
  return qb
    .insertInto("account_data")
    .values({
      user_id: userId,
      room_id: roomId,
      event_type: eventType,
      content: "{}",
      deleted: 1,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "room_id", "event_type"]).doUpdateSet({
        content: "{}",
        deleted: 1,
      }),
    );
}

export async function recordAccountDataChange(
  db: D1Database,
  userId: UserId,
  roomId: RoomId | "",
  eventType: string,
): Promise<void> {
  const streamPosition = await getNextAccountDataStreamPosition(db);
  await executeKyselyRun(
    db,
    buildRecordAccountDataChangeQuery(userId, roomId, eventType, streamPosition),
  );
}

export async function upsertAccountDataRecord(
  db: D1Database,
  userId: UserId,
  roomId: RoomId | "",
  eventType: string,
  content: string,
): Promise<void> {
  await executeKyselyRun(db, buildUpsertAccountDataRecordQuery(userId, roomId, eventType, content));
}

export async function markAccountDataDeleted(
  db: D1Database,
  userId: UserId,
  roomId: RoomId | "",
  eventType: string,
): Promise<void> {
  await executeKyselyRun(db, buildMarkAccountDataDeletedQuery(userId, roomId, eventType));
}

export async function findAccountDataRecord(
  db: D1Database,
  userId: UserId,
  roomId: RoomId | "",
  eventType: string,
): Promise<StoredAccountDataRecord | null> {
  const row = await executeKyselyQueryFirst<AccountDataRow>(
    db,
    qb
      .selectFrom("account_data")
      .selectAll()
      .where("user_id", "=", userId)
      .where("room_id", "=", roomId)
      .where("event_type", "=", eventType),
  );
  return row ? toStoredAccountDataRecord(row) : null;
}

export async function getGlobalAccountData(
  db: D1Database,
  userId: UserId,
  since?: number,
): Promise<AccountDataSyncEvent[]> {
  if (since !== undefined) {
    const rows = await executeKyselyQuery<Pick<AccountDataRow, "event_type" | "content">>(
      db,
      qb
        .selectFrom("account_data as ad")
        .innerJoin("account_data_changes as adc", (join) =>
          join
            .onRef("ad.user_id", "=", "adc.user_id")
            .onRef("ad.event_type", "=", "adc.event_type")
            .onRef("ad.room_id", "=", "adc.room_id"),
        )
        .select(["ad.event_type", "ad.content"])
        .where("ad.user_id", "=", userId)
        .where("ad.room_id", "=", "")
        .where("adc.stream_position", ">", since)
        .groupBy(["ad.event_type", "ad.content"]),
    );
    return rows.map((row) => toAccountDataSyncEvent(row));
  }

  const rows = await executeKyselyQuery<Pick<AccountDataRow, "event_type" | "content">>(
    db,
    qb
      .selectFrom("account_data")
      .select(["event_type", "content"])
      .where("user_id", "=", userId)
      .where("room_id", "=", "")
      .where("deleted", "=", 0),
  );
  return rows.map((row) => toAccountDataSyncEvent(row));
}

export async function getRoomAccountData(
  db: D1Database,
  userId: UserId,
  roomId: RoomId,
  since?: number,
): Promise<AccountDataSyncEvent[]> {
  if (since !== undefined) {
    const rows = await executeKyselyQuery<Pick<AccountDataRow, "event_type" | "content">>(
      db,
      qb
        .selectFrom("account_data as ad")
        .innerJoin("account_data_changes as adc", (join) =>
          join
            .onRef("ad.user_id", "=", "adc.user_id")
            .onRef("ad.event_type", "=", "adc.event_type")
            .onRef("ad.room_id", "=", "adc.room_id"),
        )
        .select(["ad.event_type", "ad.content"])
        .where("ad.user_id", "=", userId)
        .where("ad.room_id", "=", roomId)
        .where("adc.stream_position", ">", since)
        .groupBy(["ad.event_type", "ad.content"]),
    );
    return rows.map((row) => toAccountDataSyncEvent(row));
  }

  const rows = await executeKyselyQuery<Pick<AccountDataRow, "event_type" | "content">>(
    db,
    qb
      .selectFrom("account_data")
      .select(["event_type", "content"])
      .where("user_id", "=", userId)
      .where("room_id", "=", roomId)
      .where("deleted", "=", 0),
  );
  return rows.map((row) => toAccountDataSyncEvent(row));
}

export async function getAllRoomAccountData(
  db: D1Database,
  userId: UserId,
  roomIds: RoomId[],
  since?: number,
): Promise<Record<RoomId, AccountDataSyncEvent[]>> {
  if (roomIds.length === 0) {
    return {} as Record<RoomId, AccountDataSyncEvent[]>;
  }

  const rows =
    since !== undefined
      ? await executeKyselyQuery<Pick<AccountDataRow, "room_id" | "event_type" | "content">>(
          db,
          qb
            .selectFrom("account_data as ad")
            .innerJoin("account_data_changes as adc", (join) =>
              join
                .onRef("ad.user_id", "=", "adc.user_id")
                .onRef("ad.event_type", "=", "adc.event_type")
                .onRef("ad.room_id", "=", "adc.room_id"),
            )
            .select(["ad.room_id", "ad.event_type", "ad.content"])
            .where("ad.user_id", "=", userId)
            .where("ad.room_id", "in", roomIds)
            .where("adc.stream_position", ">", since)
            .groupBy(["ad.room_id", "ad.event_type", "ad.content"]),
        )
      : await executeKyselyQuery<Pick<AccountDataRow, "room_id" | "event_type" | "content">>(
          db,
          qb
            .selectFrom("account_data")
            .select(["room_id", "event_type", "content"])
            .where("user_id", "=", userId)
            .where("room_id", "in", roomIds)
            .where("deleted", "=", 0),
        );

  const byRoom = {} as Record<RoomId, AccountDataSyncEvent[]>;
  for (const row of rows) {
    (byRoom[row.room_id as RoomId] ??= []).push(toAccountDataSyncEvent(row));
  }
  return byRoom;
}

export async function getAccountDataStreamPosition(db: D1Database): Promise<number> {
  const row = await executeKyselyQueryFirst<StreamPositionRow>(
    db,
    qb.selectFrom("stream_positions").selectAll().where("stream_name", "=", "account_data"),
  );
  return row?.position ?? 0;
}
