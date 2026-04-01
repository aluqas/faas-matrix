-- Preserve federation-only top-level event fields needed for exact reference-hash replay.
ALTER TABLE events ADD COLUMN event_origin TEXT;
ALTER TABLE events ADD COLUMN event_membership TEXT;
ALTER TABLE events ADD COLUMN prev_state TEXT;
