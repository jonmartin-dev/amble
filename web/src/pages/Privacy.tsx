import { appUrl } from '../lib/api.ts';

export function Privacy() {
  return (
    <main className="mx-auto max-w-xl px-6 py-12 leading-relaxed">
      <a href={appUrl('/')} className="text-sm font-medium text-primary">
        Almanac
      </a>
      <h1 className="display mt-4 text-4xl font-medium">Privacy</h1>
      <p className="mt-2 text-on-surface-variant">Last updated October 13, 2026</p>

      <div className="mt-8 flex flex-col gap-5 [&_h2]:display [&_h2]:text-xl [&_h2]:font-medium">
        <p>
          Almanac is a self-hosted planner. This copy runs on a private home server for one household, and only people the household
          admin has added can sign in.
        </p>
        <h2>What Almanac stores</h2>
        <p>
          Your name, email address and profile picture from your Google account, so you can sign in and so the household can see who
          a task belongs to. Everything you put into Almanac (tasks, lists, notes, links and files) is stored on the household's own
          server.
        </p>
        <h2>Google Calendar</h2>
        <p>
          If you connect Google Calendar, Almanac reads the calendars you choose to work out how busy your days are. It only writes to a
          calendar named "Almanac" that it creates in your account. It never edits or deletes your other events.
        </p>
        <h2>AI features</h2>
        <p>
          When the household turns AI features on, task titles and related details are sent to Anthropic's API to estimate effort and
          suggest plans. Anthropic does not use API data to train its models.
        </p>
        <h2>Claude connector</h2>
        <p>
          If you connect Claude to Almanac, Claude can read and change your tasks, lists and plans when you ask it to, acting as you.
          What it reads becomes part of your Claude conversation and is handled under your Claude account's privacy settings. You can
          disconnect it at any time from Connect Claude in Almanac.
        </p>
        <h2>Sharing</h2>
        <p>Almanac never sells your data or shares it with anyone besides the services named above. There are no ads or trackers.</p>
        <h2>Removing your data</h2>
        <p>
          Ask the household admin to remove your account, or disconnect Almanac from your Google account at
          myaccount.google.com/connections. Questions: jonmartin721@gmail.com.
        </p>
      </div>
    </main>
  );
}
