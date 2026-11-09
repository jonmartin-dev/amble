# Amble

Amble is a free planner for you and your household. It knows how full each day already is from your tasks and your phone's calendar, so it shows what fits today and finds a day with room for the rest. It never nags and it's free, with no account or ads or subscription.

[Website](https://amble-planner.vercel.app) · [Get it](#get-it) · [Set it up with an AI agent](#set-it-up-with-an-ai-agent) · [Privacy policy](docs/privacy-policy.md)

<p align="center">
  <img src="docs/screenshots/briefing.png" width="200" alt="Here's today: the day's load, a task worth doing today, and Start my day">
  <img src="docs/screenshots/today.png" width="200" alt="Today: the day's tasks by morning, afternoon, evening and anytime">
  <img src="docs/screenshots/calendar.png" width="200" alt="Calendar: a week of load bars, with tasks due soon and the day that has room for each">
  <img src="docs/screenshots/groceries.png" width="200" alt="Groceries in dark mode, sorted by aisle with quantities">
</p>

I got really tired of paying for planners and of figuring out which flaky app connectors would actually work. So I made my own, and I made it free for everyone.

Jon

## What it does

- It plans around your real day. Amble reads the phone calendars you pick and learns how much you usually get done, so a busy day gets fewer tasks. Only how many minutes of each day are busy ever leaves your phone.
- Each morning it shows what's on your calendar, what someone handed you and a few tasks worth pulling in. Nothing moves until you tap Add.
- A task with a deadline shows the day with the most room before it, and Plan my week lays out the next 7 days around your calendar.
- No red overdue counts, no badges, no streaks, and no notifications except the reminders you ask for. Anything you didn't get to comes back quietly as a suggestion.
- Lists do some of the work. Groceries sort themselves by aisle as you type, a meal plan sends each dinner's ingredients to Groceries in one tap, and Start over resets a packing list for next time. All 11 list templates are small files in an [open format](templates/README.md).
- It's built for a household. Hand a task to someone with a note or leave it open to anyone, and keep any group or list private.
- AI is optional. Add a model and smart add turns "call mom tomorrow evening, out of milk and eggs" into a task and grocery items for you to check before anything is saved. It works with Claude, OpenAI, Gemini, GLM, anything on OpenRouter, or a model on your own computer through Ollama or LM Studio. Gemini and GLM have free tiers.

## Your data stays yours

Amble has no account and no servers of its own, so its developer never receives your data. Your tasks stay on your phone and work offline. Sync goes only to your own Google Drive or a server your household runs, and AI features talk only to the provider you set up. The [privacy policy](docs/privacy-policy.md) has the details.

## Get it

Start with the app. Most households never need more.

On Android, Amble is in a closed test on Google Play before it opens to everyone. [Email to join](mailto:jonmartin721@gmail.com?subject=Amble%20Android%20test) and you'll get the link, or [build it yourself](docs/android.md). To sync your other devices and your household, sign in with Google and Amble keeps one file in your own Drive.

iPhones and computers use the web app from a household server for now. A native iPhone app is [wanted](CONTRIBUTING.md#help-wanted).

A household server is optional. It's one Docker container on a computer that stays on. A script sets it all up on Linux, a Mac or Windows, Tailscale included. It adds what only a server can do:

- Claude adding, planning and finishing your tasks from a chat ([docs/assistants.md](docs/assistants.md)). ChatGPT should work the same way, but nobody has tried it with a real account yet.
- Photos and files on tasks, shared between phones
- The web app for iPhones and computers
- Syncing without Google, with the AI key kept on the server

[docs/self-hosting.md](docs/self-hosting.md) walks through it.

## Set it up with an AI agent

The setup is written so an AI agent can do it for you. Open Claude Code, Codex or Gemini CLI in a terminal on the computer that will run the server, and paste this:

```text
Set up an Amble household server on this computer. Clone https://github.com/jonmartin-dev/amble if it isn't here yet, then follow AGENTS.md in it.
```

[AGENTS.md](AGENTS.md) tells the agent what to ask you, what to run and how to check each step. It asks one question at a time, and it has you save any key to a file yourself instead of pasting it into the chat.

## Work on the code

You need Node 26 or newer and pnpm.

```sh
pnpm install
cp .env.example .env
pnpm dev
```

That opens the app on http://127.0.0.1:5174. For something to look at, `pnpm demo` runs the built app on a made-up household at http://localhost:8787 (choose Use my own server and sign in as Sam). [CONTRIBUTING.md](CONTRIBUTING.md) has the layout, the checks to run before a pull request and how the code is written.

## Help make it better

- [Open an issue](https://github.com/jonmartin-dev/amble/issues/new/choose) for ideas and bug reports.
- A new list template is one JSON file and a good first pull request ([templates/README.md](templates/README.md)).
- A native iPhone app tops the [help wanted](CONTRIBUTING.md#help-wanted) list.
- Report security problems privately, as [SECURITY.md](SECURITY.md) says.

## Docs

- [Running your own server](docs/self-hosting.md)
- [The Android app](docs/android.md)
- [Google Drive sync](docs/google-drive.md)
- [Getting in, and sign-in providers](docs/sign-in.md)
- [Claude and ChatGPT](docs/assistants.md)
- [List templates](templates/README.md)
- [Privacy policy](docs/privacy-policy.md)

## License

[AGPL-3.0](LICENSE), except the list templates in `templates/`, which are [CC0](templates/LICENSE) so any app can use them.
