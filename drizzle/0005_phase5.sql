CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`ok` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_usage_created_idx` ON `ai_usage` (`created_at`);--> statement-breakpoint
CREATE TABLE `series` (
	`id` text PRIMARY KEY NOT NULL,
	`rule` text NOT NULL,
	`anchor` text NOT NULL,
	`paused_until` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `list_items` ADD `section` text;--> statement-breakpoint
ALTER TABLE `list_items` ADD `url` text;--> statement-breakpoint
ALTER TABLE `list_items` ADD `price` text;--> statement-breakpoint
ALTER TABLE `members` ADD `smart_add` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `series_id` text REFERENCES series(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `tasks_series_idx` ON `tasks` (`series_id`);