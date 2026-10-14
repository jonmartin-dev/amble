CREATE TABLE `calendar_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`subject` text NOT NULL,
	`email` text NOT NULL,
	`refresh_token` text NOT NULL,
	`scope` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`error` text,
	`synced_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_accounts_member_subject_idx` ON `calendar_accounts` (`member_id`,`subject`);--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`member_id` text NOT NULL,
	`event_id` text NOT NULL,
	`uid` text,
	`title` text,
	`all_day` integer DEFAULT false NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`start_date` text,
	`end_date` text,
	`busy` integer DEFAULT true NOT NULL,
	`url` text,
	FOREIGN KEY (`source_id`) REFERENCES `calendar_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_source_event_idx` ON `calendar_events` (`source_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `calendar_events_member_start_idx` ON `calendar_events` (`member_id`,`start_at`);--> statement-breakpoint
CREATE TABLE `calendar_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`member_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`primary` integer DEFAULT false NOT NULL,
	`counts` integer DEFAULT false NOT NULL,
	`sync_token` text,
	`full_sync_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `calendar_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_sources_account_calendar_idx` ON `calendar_sources` (`account_id`,`calendar_id`);--> statement-breakpoint
CREATE TABLE `day_records` (
	`member_id` text NOT NULL,
	`date` text NOT NULL,
	`briefing_seen_at` integer,
	`suggestions` text,
	`reasons_by` text,
	`dismissed` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`member_id`, `date`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `ai_estimate_minutes` integer;