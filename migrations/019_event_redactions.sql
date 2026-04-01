-- Migration: Add redaction marker to events
-- Stores the redaction event ID for events that have been redacted so
-- search/results queries can exclude them without reparsing event content.

ALTER TABLE events ADD COLUMN redacted_because TEXT;
