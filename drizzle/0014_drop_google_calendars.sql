-- Calendars come from the phone now (the Amble app reads the phone's own calendars), so the
-- server's copy of Google Calendar goes. Children first, so nothing cascades halfway.
DROP TABLE `calendar_events`;--> statement-breakpoint
DROP TABLE `calendar_sources`;--> statement-breakpoint
DROP TABLE `calendar_accounts`;
