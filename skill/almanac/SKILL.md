---
name: almanac
description: Manage household tasks, chores, errands, calls, shopping and grocery lists, and day plans in Almanac through its connector. Use when someone mentions something they need to do, asks what's on today or this week, wants a day planned or time found for something, hands a task to someone, or adds to or checks off a list.
---

<!-- Source: skill/almanac/ in the Almanac repo. Edit it there, then copy it out with scripts/sync-skill.ts. -->

# Almanac

Almanac is a calm, shared household planner. The connector's tools do the work; this skill is how to use them the way the household wants. If the Almanac tools aren't available, say so and point to Connect Claude in the Almanac app instead of keeping the task in the chat.

## How Almanac thinks

- **Calm by default.** No guilt about overdue things, no pressure, no reminders unless someone asks for one. Carried-over tasks are just tasks that moved, not failures.
- **Backlog, planned, due.** A task with no planned date sits in the backlog. "Planned" puts it on a day's list. "Due" is a real deadline. Don't plan or date things nobody asked to plan or date.
- **Light days.** Almanac learns how much task time fits each person's weekdays from what they actually finish (starting around 3 hours on weekdays and 4 on weekends), anyone can pin their own number in Settings, and `get_load` reports it. Once someone connects Google Calendar, a day with more on it than usual has less room for tasks. A day pinned to 0 is a day off. A good day list has a handful of things, not everything that could be done.
- **The day turns over at 4am**, so a late-night "today" still means the day that's ending. Use the date the tools report.
- **Shared, with private corners.** Everything is visible to the household except private groups. New tasks belong to the person you're acting for; "anyone" makes a task shared.
- **Delegation lands quietly.** Assigning a task to someone puts it on their backlog with no notification. Only assign to someone else when asked.

## Common requests

**"Add these" or a brain dump.** One `add_tasks` call with everything. Pick each group from the names `get_household` lists, and leave the group off when none fits rather than guessing wildly. Add dates, times of day and must-do only when the person said them. Split items that are really several tasks, and keep each title short and actionable ("Call the dentist about the crown").

**"What's on today?"** `get_today`. Answer in a few lines: what's on the calendar, what's planned, roughly by time of day, then anything carried over or due, mentioned gently. Skip empty sections.

**"What should I do today?"** `suggest_day` gives the planner's few picks that fit today's room, each with a reason. Offer them in plain words and plan the ones the person wants with `move_tasks`.

**"Plan my week."** `plan_week` drafts one: leftovers and the most pressing backlog tasks on the days with the most room, never past a deadline. Show it as a short list by day, adjust it to what the person says ("keep Saturday free"), and apply what they agree to with `move_tasks`, or right away if they said to just do it. For a single day, read `get_today` and `get_load` (with `include_events` for the calendar) and propose a short plan that leaves room.

**"When should I do X?"** `find_gap` with the due date and a sensible estimate, then offer that day in plain words. Plan it only if they say yes.

**Shopping and groceries.** "We're out of milk" or "add eggs" goes to `add_to_list`, never `add_tasks`. "Got the milk" goes to `check_off_list_items`. Quantities go in `quantity`, not the name.

**Done, undone, gone.** `complete_tasks` when something's finished (`undo` if it wasn't). `archive_tasks` removes mistakes and dropped ideas, and it can be restored. Confirm before archiving more than a few at once.

**Handing off.** `assign_task` to the person named, with a short note when there's context worth passing on or when handing something back.

**"Remind me..."** Only when they ask. `set_reminder` on the task with their local time ("2026-10-16T18:00"), or `remind_at` on `add_tasks` when the task is new. It's one notification on their own phone, with Done and Snooze on it. A day with no time means 9am; "tonight" means 6pm. If the result says they haven't turned notifications on, tell them it's in Settings, under Notifications. Never add a reminder they didn't ask for.

**Files.** People add photos, receipts and manuals to tasks in the app. `get_task` lists them; `read_file` shows you a photo or reads a text file when they ask what's in one. PDFs and documents can't be opened through the connector.

## Replies

- Short and plain. Use weekday names ("Thursday") rather than ISO dates unless that's ambiguous.
- Never show task ids, raw JSON or tool names.
- After a change, confirm it in one line ("Added three things to Home, and the dentist call is on Thursday").
- Don't offer reminders or follow-ups. When someone asks for a reminder, set it and say when it'll come.

## Not built yet

Almanac reads calendars to see how busy a day is but never adds anything to them, by design. Claude can't attach files through the connector; people add them in the app. If someone asks for one of these, say so and offer the closest thing (a planned date, a reminder, or a note on the task).
