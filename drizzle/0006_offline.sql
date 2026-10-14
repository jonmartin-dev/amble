CREATE TABLE `applied_requests` (
	`member_id` text NOT NULL,
	`key` text NOT NULL,
	`status` integer,
	`body` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`member_id`, `key`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `applied_requests_created_idx` ON `applied_requests` (`created_at`);