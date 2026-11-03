-- Codes that let phones and browsers into a server without a sign-in provider.
CREATE TABLE `pair_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`kind` text NOT NULL,
	`member_id` text,
	`role` text DEFAULT 'member' NOT NULL,
	`uses_left` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pair_codes_code_hash_unique` ON `pair_codes` (`code_hash`);