CREATE TABLE `sync_aliases` (
	`tbl` text NOT NULL,
	`from_pk` text NOT NULL,
	`to_pk` text NOT NULL,
	PRIMARY KEY(`tbl`, `from_pk`)
);
