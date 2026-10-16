-- The phone's own calendars, read on the phone, and how busy each day is, which syncs to the household.
CREATE TABLE `calendars` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`account` text,
	`name` text NOT NULL,
	`color` text,
	`primary` integer DEFAULT false NOT NULL,
	`counts` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendars_member_calendar_idx` ON `calendars` (`member_id`,`calendar_id`);
--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`calendar_id` text NOT NULL,
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
	FOREIGN KEY (`calendar_id`) REFERENCES `calendars`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_calendar_event_idx` ON `calendar_events` (`calendar_id`,`event_id`);
--> statement-breakpoint
CREATE INDEX `calendar_events_member_start_idx` ON `calendar_events` (`member_id`,`start_at`);
--> statement-breakpoint
CREATE TABLE `busy_days` (
	`member_id` text NOT NULL,
	`date` text NOT NULL,
	`minutes` integer NOT NULL,
	`events` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`member_id`, `date`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);