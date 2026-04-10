import {
  countPublicRooms,
  getPublicRoomInfo,
  listPublicRoomIds,
} from "../../infra/repositories/federation-public-rooms-repository";

export async function queryFederationPublicRooms(input: {
  db: D1Database;
  limit: number;
  offset: number;
  searchTerm?: string;
}): Promise<{
  chunk: Awaited<ReturnType<typeof getPublicRoomInfo>>[];
  totalRoomCountEstimate: number;
  nextBatch?: string;
  prevBatch?: string;
}> {
  const roomIds = await listPublicRoomIds(
    input.db,
    input.limit + 1,
    input.offset,
    input.searchTerm,
  );
  const hasMore = roomIds.length > input.limit;
  const chunk = await Promise.all(
    roomIds.slice(0, input.limit).map((roomId) => getPublicRoomInfo(input.db, roomId)),
  );
  const totalRoomCountEstimate = await countPublicRooms(input.db);

  return {
    chunk,
    totalRoomCountEstimate,
    ...(hasMore ? { nextBatch: `offset_${input.offset + input.limit}` } : {}),
    ...(input.offset > 0 ? { prevBatch: `offset_${Math.max(0, input.offset - input.limit)}` } : {}),
  };
}
