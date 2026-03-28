-- Stripped state events received with federation invites.
-- Used to populate invite_state.events in /sync responses for invited rooms.
-- Stored separately because these are incomplete PDUs (no event_id, auth_events, etc.)
-- and cannot be stored in the events/room_state tables.
CREATE TABLE IF NOT EXISTS invite_stripped_state (
    room_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    state_key TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    sender TEXT NOT NULL,
    PRIMARY KEY (room_id, event_type, state_key)
);
