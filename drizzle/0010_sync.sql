CREATE TABLE `sync_capture` (
	`id` integer PRIMARY KEY NOT NULL,
	`on` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_cells` (
	`tbl` text NOT NULL,
	`pk` text NOT NULL,
	`col` text NOT NULL,
	`hlc` text,
	PRIMARY KEY(`tbl`, `pk`, `col`)
);
--> statement-breakpoint
CREATE INDEX `sync_cells_hlc_idx` ON `sync_cells` (`hlc`);--> statement-breakpoint
CREATE TABLE `sync_tombstones` (
	`tbl` text NOT NULL,
	`pk` text NOT NULL,
	`hlc` text,
	PRIMARY KEY(`tbl`, `pk`)
);
