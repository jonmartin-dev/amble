CREATE TABLE `phones` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`token` text NOT NULL,
	`site` text,
	`device` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `phones_member_idx` ON `phones` (`member_id`);