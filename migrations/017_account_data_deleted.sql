-- Migration: Add deleted flag to account_data for MSC3391 support
-- MSC3391 allows deleting account data via DELETE endpoint or PUT with empty content.
-- Deleted items appear in incremental sync with {} content, but not in initial sync.

ALTER TABLE account_data ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
