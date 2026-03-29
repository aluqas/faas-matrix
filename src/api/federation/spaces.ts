import { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { Errors } from '../../utils/errors';
import {
  EventQueryService,
  normalizeOffsetToken,
  selectSpaceChildren,
} from '../../matrix/application/event-query-service';

const app = new Hono<AppEnv>();
const queries = new EventQueryService();

app.get('/_matrix/federation/v1/hierarchy/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const suggestedOnly = c.req.query('suggested_only') === 'true';
  const limit = Math.min(Number.parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = normalizeOffsetToken(c.req.query('from'));

  if (!(await queries.roomExists(c.env.DB, roomId))) {
    return Errors.notFound('Room not found').toResponse();
  }

  const childEdges = await queries.getSpaceChildEdges(c.env.DB, roomId);
  const { children, hasMore } = selectSpaceChildren(childEdges, {
    suggestedOnly,
    limit,
    offset,
  });

  const rootInfo = await queries.getRoomPublicInfo(c.env.DB, roomId);
  const rootChildrenState = childEdges.map((edge) => ({
    type: 'm.space.child',
    state_key: edge.roomId,
    content: edge.content,
  }));

  const childRooms = [];
  for (const edge of children) {
    const room = await queries.getRoomPublicInfo(c.env.DB, edge.roomId);
    if (room) {
      childRooms.push({
        ...room,
        children_state: [],
      });
    }
  }

  const response: Record<string, unknown> = {
    room: offset === 0 && rootInfo
      ? {
          ...rootInfo,
          children_state: rootChildrenState,
        }
      : null,
    children: childRooms,
    inaccessible_children: [],
  };

  if (hasMore) {
    response.next_batch = `offset_${offset + limit}`;
  }

  return c.json(response);
});

export default app;
