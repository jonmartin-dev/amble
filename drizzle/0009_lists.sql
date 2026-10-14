ALTER TABLE `groups` ADD `sections` text;--> statement-breakpoint
ALTER TABLE `list_items` ADD `store` text;--> statement-breakpoint
ALTER TABLE `list_items` ADD `parts` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `list_id` text REFERENCES groups(id);