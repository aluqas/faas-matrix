-- Migration: Rebuild event search FTS index as a contentless table
-- The original external-content definition expected an events.body column,
-- but event bodies live inside events.content JSON.

DROP TRIGGER IF EXISTS events_fts_insert;
DROP TRIGGER IF EXISTS events_fts_delete;
DROP TABLE IF EXISTS events_fts;

CREATE VIRTUAL TABLE events_fts USING fts5(
    event_id UNINDEXED,
    room_id UNINDEXED,
    sender UNINDEXED,
    body
);

INSERT INTO events_fts(rowid, event_id, room_id, sender, body)
SELECT
    rowid,
    event_id,
    room_id,
    sender,
    json_extract(content, '$.body')
FROM events
WHERE event_type = 'm.room.message';

CREATE TRIGGER events_fts_insert AFTER INSERT ON events
WHEN NEW.event_type = 'm.room.message'
BEGIN
    INSERT INTO events_fts(rowid, event_id, room_id, sender, body)
    VALUES (
        NEW.rowid,
        NEW.event_id,
        NEW.room_id,
        NEW.sender,
        json_extract(NEW.content, '$.body')
    );
END;

CREATE TRIGGER events_fts_delete AFTER DELETE ON events
WHEN OLD.event_type = 'm.room.message'
BEGIN
    INSERT INTO events_fts(events_fts, rowid, event_id, room_id, sender, body)
    VALUES (
        'delete',
        OLD.rowid,
        OLD.event_id,
        OLD.room_id,
        OLD.sender,
        json_extract(OLD.content, '$.body')
    );
END;
