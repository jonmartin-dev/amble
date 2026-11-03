-- The household's own settings, synced with it (its AI model, for a household on Google Drive), and what each device spent with that model.
CREATE TABLE `household_ai_spend` (
	`site` text NOT NULL,
	`month` text NOT NULL,
	`micros` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site`, `month`)
);
--> statement-breakpoint
CREATE TABLE `household_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
