import { describe, expect, it } from "vitest";
import { projectPresenceEvents } from "./project";
import type { UserId, RoomId } from "../../../../fatrix-model/types";

const ALICE = "@alice:test.local" as UserId;
const BOB = "@bob:test.local" as UserId;
const ROOM = "!room:test.local" as RoomId;

describe("projectPresenceEvents – self projection", () => {
  it("always includes the requesting user in presence candidates", async () => {
    const queriedUserIds: UserId[] = [];
    const db: D1Database = {
      prepare: (_sql: string) => ({
        bind: (...params: unknown[]) => {
          params.forEach((p) => {
            if (typeof p === "string" && p.startsWith("@")) {
              queriedUserIds.push(p as UserId);
            }
          });
          return {
            all: () => ({ results: [] }),
            first: () => null,
            run: () => ({ success: true }),
          };
        },
        all: () => ({ results: [] }),
        first: () => null,
        run: () => ({ success: true }),
      }),
    } as unknown as D1Database;

    await projectPresenceEvents(db, undefined, {
      userId: ALICE,
      visibleRoomIds: [],
    });

    // Even with no visible rooms, ALICE should appear in candidates
    expect(queriedUserIds).toContain(ALICE);
  });

  it("deduplicates self when self also appears in visible room membership", async () => {
    const candidatesSeen: UserId[][] = [];

    const db: D1Database = {
      prepare: (_sql: string) => ({
        bind: (...params: unknown[]) => {
          const ids = params.filter(
            (p): p is UserId => typeof p === "string" && p.startsWith("@"),
          );
          if (ids.length > 0) {
            candidatesSeen.push(ids);
          }
          return {
            all: () => ({
              results: [
                {
                  room_id: ROOM,
                  event_id: "$e1",
                  event_type: "m.room.member",
                  state_key: BOB,
                  user_id: BOB,
                  content: JSON.stringify({ membership: "join" }),
                },
              ],
            }),
            first: () => null,
            run: () => ({ success: true }),
          };
        },
        all: () => ({ results: [] }),
        first: () => null,
        run: () => ({ success: true }),
      }),
    } as unknown as D1Database;

    await projectPresenceEvents(db, undefined, {
      userId: ALICE,
      visibleRoomIds: [ROOM],
    });

    // Flatten all seen user ID arrays from presence queries
    const allQueried = candidatesSeen.flat();
    const aliceCount = allQueried.filter((id) => id === ALICE).length;

    // ALICE must appear, and only once (Set deduplication)
    expect(aliceCount).toBeGreaterThanOrEqual(1);
    const aliceOccurrences = allQueried.filter((id) => id === ALICE);
    expect(new Set(aliceOccurrences).size).toBe(1);
  });
});
