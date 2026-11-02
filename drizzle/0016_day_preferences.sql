-- How much time someone starts with and how full they like their days, and how each day is looking.
ALTER TABLE `day_records` ADD `outlook` text;--> statement-breakpoint
ALTER TABLE `members` ADD `start_minutes` integer;--> statement-breakpoint
ALTER TABLE `members` ADD `day_fill` text DEFAULT 'balanced' NOT NULL;
