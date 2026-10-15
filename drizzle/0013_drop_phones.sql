-- 0012 added phones for reminders pushed through Firebase; that was taken out again the same day.
-- A phone picks up reminders set elsewhere by checking the household in the background instead.
DROP TABLE `phones`;--> statement-breakpoint
DELETE FROM `sync_cells` WHERE `tbl` = 'phones';--> statement-breakpoint
DELETE FROM `sync_tombstones` WHERE `tbl` = 'phones';
