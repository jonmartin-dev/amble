# Amble

**A simple planner for you and your household.** Amble knows how full each day already is, from your tasks and your phone's calendar, so it can tell you what fits today and which day has room for the rest. It never nags.

**Free, for you, forever.** Every feature, with no account, no ads and no subscription. There's no paid tier waiting down the road and nothing to sign up for. Your tasks stay on your phone.

<p align="center">
  <img src="docs/screenshots/briefing.png" width="200" alt="Here's today: the day's load, a task worth doing today, and Start my day">
  <img src="docs/screenshots/today.png" width="200" alt="Today: the day's tasks by morning, afternoon, evening and anytime">
  <img src="docs/screenshots/calendar.png" width="200" alt="Calendar: a week of load bars, with tasks due soon and the day that has room for each">
  <img src="docs/screenshots/groceries.png" width="200" alt="Groceries in dark mode, sorted by aisle with quantities">
</p>
<p align="center">
  <img src="docs/screenshots/quick-add.png" width="200" alt="Quick add: what's typed in large type, with a row of chips for the day, group and person">
  <img src="docs/screenshots/lists.png" width="200" alt="A new list: eleven templates, from groceries and packing to gift ideas and a meal plan">
  <img src="docs/screenshots/task.png" width="200" alt="A task's page: group, notes and steps">
  <img src="docs/screenshots/appearance.png" width="200" alt="Appearance: Material You colors and styles, light, dark or automatic">
</p>

## Why it's different

Most planners show you everything you haven't done yet. Amble starts from a different question: how much room does today actually have?

- **It knows when you're busy.** Amble reads the phone calendars you pick and learns how much you usually get done, so a busy day gets fewer tasks. Only how many minutes of each day are busy ever leaves your phone.
- **Today stays light.** Your day is split into morning, afternoon and evening with a meter for how full it is. Each morning asks how the day is looking and shows what's on your calendar, what someone handed you and a few backlog tasks worth pulling in. Nothing moves until you tap Add.
- **Things due later land on a good day.** A task with a deadline shows the day with the most room before it, and Plan my week lays out the next seven days around your calendar.
- **No guilt.** No red overdue counts, no badges, no streaks to keep up, and no notifications except the reminders you ask for. Anything you didn't get to comes back quietly as a suggestion.

## Lists that do some of the work

- Groceries sort themselves by aisle as you type, and the whole list plans as one grocery run on the day with room.
- A meal plan sends each dinner's ingredients to Groceries in one tap.
- Packing lists and routines start from a kit, and Start over unchecks everything for next time.
- Gift ideas go under who they're for and start out private, so nobody sees their own.
- Errands group by place and plan as one run.
- There are also lists for shopping with links and prices, the hardware store, things to watch and read, places to try, and plain checklists.

Each of the 11 templates is one small file in an [open format](templates/README.md), so anyone can write a new one or use them in another app.

## AI when you want it

Amble works fully without AI. Add a model and it takes on the fiddly parts:

- **Smart add.** Type "call mom tomorrow evening, out of milk and eggs, Alex mows every Saturday" and it becomes tasks, grocery items and a repeating chore, each one for you to check before anything is saved.
- **Plan my week** listens to what you tell it ("keep Saturday free"), and **Tidy up** suggests merging duplicates and splitting tasks that are really several.
- Tasks you didn't size get a guess, so the day's meter stays honest.

Bring your own key for Claude, OpenAI, Gemini, GLM or anything on OpenRouter (Gemini and GLM have free tiers), or run a model on your own computer through Ollama or LM Studio. You set a monthly cap, and the key stays on your device. A household with its own server can share one model, and connect Claude or ChatGPT to add, plan and finish tasks from a chat ([docs/assistants.md](docs/assistants.md)).

## Made to feel good

Amble is built on Google's Material 3 Expressive, springs and all. A task grows out of the row you tapped and shrinks back into it when you pull it down, and sheets ride up with the keyboard. Pick any color or your wallpaper's own and Amble builds a full palette from it, in five styles, light or dark. Today's tasks can sit on your home screen in a widget, and on a foldable or tablet a task opens beside its list.

## Everything else

- A household: hand a task to someone with a note, or leave it open to anyone. Any group or list can be private.
- Repeating tasks on a schedule (every Sunday, the 2nd Thursday, only in some months) or a set time after the last one was done.
- Reminders only when you ask for one. They show at their time even with Amble closed, with Done and Snooze on them.
- Photos, receipts and manuals on tasks.
- Works offline from the first open, since everything is on your phone.
- Sync your devices and your household through a file in your own Google Drive. Copies merge field by field when they meet again.
- Save everything to one file whenever you like, and start a new phone from it.

## Get it

- **Android:** coming to Google Play. Until then you can [build it yourself](docs/android.md).
- **iPhone and computers:** the web app, served by your household's own server ([docs/self-hosting.md](docs/self-hosting.md)). A native iPhone app is [wanted](CONTRIBUTING.md#help-wanted).

## Your data stays yours

Amble has no account and no servers of its own, so its developer never receives your data. Sync goes only to your own Google Drive or a server your household runs, and AI features talk only to the provider you set up. The [privacy policy](docs/privacy-policy.md) has the details.

## Your own server, if you want one

Most households never need one. A server adds one AI model for everyone, photos and files shared between phones, Claude and ChatGPT, the web app at your own address, and syncing without Google. It's one Docker container on a computer you keep, and a script sets it up on Linux, a Mac or Windows. [docs/self-hosting.md](docs/self-hosting.md) walks through it, and it's written so an AI assistant can take you through it.

## Help make it better

Amble is made in the open, and help of any size is welcome.

- **Ideas and bug reports:** [open an issue](https://github.com/jonmartin-dev/amble/issues/new/choose).
- **A new list template:** one JSON file, and a good first pull request ([templates/README.md](templates/README.md)).
- **Code:** [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the layout and the checks to run. A native iPhone app tops the [help wanted](CONTRIBUTING.md#help-wanted) list.

## Docs

- [Running your own server](docs/self-hosting.md)
- [Sign-in providers](docs/sign-in.md)
- [Google Drive sync](docs/google-drive.md)
- [The Android app](docs/android.md)
- [Claude and ChatGPT](docs/assistants.md)
- [List templates](templates/README.md)
- [Privacy policy](docs/privacy-policy.md)

## License

[AGPL-3.0](LICENSE), except the list templates in `templates/`, which are [CC0](templates/LICENSE) so any app can use them.
