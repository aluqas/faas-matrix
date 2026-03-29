import { Hono } from 'hono';
import type { AppEnv, PDU, RoomMemberContent } from '../../types';
import { Errors } from '../../utils/errors';
import { requireAuth } from '../../middleware/auth';
import { generateEventId } from '../../utils/ids';
import {
  applyMembershipTransitionToDatabase,
  loadMembershipTransitionContext,
} from '../../matrix/application/member-transition-service';
import {
  getMembership,
  getRoom,
  getRoomByAlias,
  getRoomEvents,
  getStateEvent,
  storeEvent,
} from '../../services/database';

const app = new Hono<AppEnv>();

async function handleKnock(
  c: import('hono').Context<AppEnv>,
  roomId: string,
  reason?: string
) {
  const userId = c.get('userId');
  const db = c.env.DB;

  const room = await getRoom(db, roomId);
  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  const currentMembership = await getMembership(db, roomId, userId);
  if (currentMembership?.membership === 'join') {
    return c.json({ room_id: roomId });
  }
  if (currentMembership?.membership === 'ban') {
    return Errors.forbidden('User is banned from this room').toResponse();
  }

  const joinRulesEvent = await getStateEvent(db, roomId, 'm.room.join_rules');
  const joinRule = (joinRulesEvent?.content as { join_rule?: string } | null)?.join_rule || 'invite';
  if (!['knock', 'knock_restricted'].includes(joinRule)) {
    return Errors.forbidden('Room does not allow knocking').toResponse();
  }

  const eventId = await generateEventId(c.env.SERVER_NAME);
  const createEvent = await getStateEvent(db, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(db, roomId, 'm.room.power_levels');

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (currentMembership) authEvents.push(currentMembership.eventId);

  const { events: latestEvents } = await getRoomEvents(db, roomId, undefined, 1);
  const prevEvents = latestEvents.map((event) => event.event_id);

  const memberContent: RoomMemberContent = {
    membership: 'knock',
    reason,
  };

  const event: PDU = {
    event_id: eventId,
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: userId,
    content: memberContent,
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  const transitionContext = await loadMembershipTransitionContext(db, roomId, userId);
  await storeEvent(db, event);
  await applyMembershipTransitionToDatabase(db, {
    roomId,
    event,
    source: 'client',
    context: transitionContext,
  });

  return c.json({ room_id: roomId });
}

app.post('/_matrix/client/v3/rooms/:roomId/knock', requireAuth(), async (c) => {
  let body: { reason?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  return handleKnock(c, c.req.param('roomId'), body.reason);
});

app.post('/_matrix/client/v3/knock/:roomIdOrAlias', requireAuth(), async (c) => {
  let body: { reason?: string; server_name?: string[] };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  let roomId = c.req.param('roomIdOrAlias');
  if (roomId.startsWith('#')) {
    const resolved = await getRoomByAlias(c.env.DB, roomId);
    if (!resolved) {
      return Errors.notFound('Room alias not found').toResponse();
    }
    roomId = resolved;
  }

  return handleKnock(c, roomId, body.reason);
});

export default app;
