import { appUrl } from '../lib/api.ts';
import { useSession } from '../lib/queries.ts';

// What each provider says it does with what's sent through its API. Others link to their own terms.
const AI_TRAINING: Record<string, string> = {
  anthropic: 'Anthropic does not use API data to train its models.',
  openai: 'OpenAI does not use API data to train its models unless the account owner opts in.',
  gemini:
    "On Gemini's paid tier Google does not use what's sent to improve its products; on the free tier it may, and people may review it.",
  openrouter: 'OpenRouter passes it on to the company behind the model, under that company’s terms.',
};

export function Privacy() {
  const auth = useSession().data?.auth;
  const provider = auth?.provider ?? 'Google';
  const aiName = auth?.ai?.provider === 'custom' ? 'the service the household admin chose' : (auth?.ai?.name ?? '');
  return (
    <main className="mx-auto max-w-xl px-6 py-12 leading-relaxed">
      <a href={appUrl('/')} className="text-sm font-medium text-primary">
        Almanac
      </a>
      <h1 className="display mt-4 text-4xl font-medium">Privacy</h1>
      <p className="mt-2 text-on-surface-variant">Last updated October 14, 2026</p>

      <div className="mt-8 flex flex-col gap-5 [&_h2]:display [&_h2]:text-xl [&_h2]:font-medium">
        <p>
          Almanac is a self-hosted planner. This copy runs on the household's own server, and only people the household admin has
          added can sign in.
        </p>
        <h2>What Almanac stores</h2>
        <p>
          Your name, email address and profile picture from your {provider} account, so you can sign in and so the household can see who
          a task belongs to. Everything you put into Almanac (tasks, lists, notes, links and files) is stored on the household's own
          server. Files on a task are visible to everyone who can see that task.
        </p>
        <h2>Reminders</h2>
        <p>
          Almanac only sends a notification for a reminder you set yourself. It goes to the devices where you turned notifications on,
          through your browser's push service (Google's for Chrome and Android, Apple's for iPhone). The task's title and a line of its
          notes travel encrypted for your device, so the push service passes them along without being able to read them. Signing out
          or turning notifications off in Settings stops them on that device.
        </p>
        <h2>Google Calendar</h2>
        <p>
          If you connect Google Calendar, Almanac reads the calendars you choose, to work out how busy your days are and plan around them.
          It keeps a copy of their events from twelve weeks back to six months ahead on the household's server, refreshed every few
          minutes. Only you see your events; everyone else in the household only sees that a day is busier. Almanac only reads: it never
          adds, edits or deletes events. Disconnecting a calendar in Settings deletes the copy and tells Google to end Almanac's access.
        </p>
        <h2>AI features</h2>
        {auth?.ai ? (
          <p>
            This copy uses an AI model from {aiName}. Task titles and related details are sent to {aiName}'s API to turn what you type
            into tasks, estimate how long tasks take, word the morning's suggestions, plan your week and suggest tidying the backlog. For
            the morning suggestions and planning your week, the titles and times of your own calendar events that day or week are sent
            too. {AI_TRAINING[auth.ai.provider] ?? `${aiName}'s own terms say what it keeps and whether it learns from it.`}
          </p>
        ) : (
          <p>
            This copy has no AI model set up, so nothing is sent to an AI service. If the household admin sets one up, task titles and
            related details go to that provider to turn what you type into tasks, estimate how long tasks take and help with planning,
            and this page will name it.
          </p>
        )}
        <h2>Claude connector</h2>
        <p>
          If you connect Claude to Almanac, Claude can read and change your tasks, lists and plans when you ask it to, acting as you,
          and look at photos and text files on tasks.
          What it reads becomes part of your Claude conversation and is handled under your Claude account's privacy settings. You can
          disconnect it at any time from Connect Claude in Almanac.
        </p>
        <h2>Sharing</h2>
        <p>Almanac never sells your data or shares it with anyone besides the services named above. There are no ads or trackers.</p>
        <h2>Removing your data</h2>
        <p>
          Ask the household admin to remove your account
          {provider === 'Google' ? ', or disconnect Almanac from your Google account at myaccount.google.com/connections' : ''}.
          {auth?.privacyContact ? ` Questions: ${auth.privacyContact}.` : ''}
        </p>
      </div>
    </main>
  );
}
