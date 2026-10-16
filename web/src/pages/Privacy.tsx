import { appUrl, servedBy } from '../lib/api.ts';
import { tokenEndpointHost } from '../lib/google.ts';
import { native } from '../lib/native.ts';
import { useSession } from '../lib/queries.ts';

// What each provider says it does with what's sent through its API. Others link to their own terms.
const AI_TRAINING: Record<string, string> = {
  anthropic: 'Anthropic does not use API data to train its models.',
  openai: 'OpenAI does not use API data to train its models unless the account owner opts in.',
  gemini:
    "On Gemini's paid tier Google does not use what's sent to improve its products; on the free tier it may, and people may review it.",
  openrouter: 'OpenRouter passes it on to the company behind the model, under that company’s terms.',
};

/**
 * What stays on the device, and what goes to Google Drive, the household's own server or an AI
 * provider when someone sets that up. Served by a server, it says what that server keeps too.
 */
export function Privacy() {
  const auth = useSession().data?.auth;
  const aiName = auth?.ai?.provider === 'custom' ? 'the service you chose' : (auth?.ai?.name ?? '');
  const server = servedBy;
  return (
    <main className="mx-auto max-w-xl px-6 py-12 leading-relaxed">
      <a href={appUrl('/')} className="text-sm font-medium text-primary">
        Amble
      </a>
      <h1 className="display mt-4 text-4xl font-medium">Privacy</h1>
      <p className="mt-2 text-on-surface-variant">Last updated October 15, 2026</p>

      <div className="mt-8 flex flex-col gap-5 [&_h2]:display [&_h2]:text-xl [&_h2]:font-medium">
        <p>
          Amble runs on your device. Everything you put in it (tasks, lists, notes, links and files) is kept in its own storage on
          this device, and nothing goes anywhere unless you set up one of the things below. There's no account to make, no ads and
          no analytics.
        </p>
        <h2>Sync with Google Drive</h2>
        <p>
          If you turn on sync, Amble keeps a copy in your Google Drive and brings your other devices in step with it. Just for you, the
          copy is in Amble's own hidden folder in your Drive, which only Amble can open. For a household, it's a file in the Drive of
          whoever made the household, shared with the people they add; everyone in it has the whole file, including lists marked as
          only theirs, which Amble keeps out of others' view but doesn't keep out of the file. Amble asks Google only for its own
          files: the hidden folder, and files it made or that you picked for it. It can't see anything else in your Drive. Photos and
          files on tasks stay on the devices of whoever added them, unless your household syncs with its own server.
        </p>
        <p>
          {native
            ? 'Android gives the app a key to your Drive that lasts about an hour, and a fresh one while you allow Amble.'
            : tokenEndpointHost
              ? `Google gives the app a key to your Drive that lasts about an hour, kept only in this tab, and a longer-lasting one this browser keeps for getting the next. Getting it goes through ${tokenEndpointHost}, which adds Amble's Google sign-in secret on the way and keeps nothing.`
              : "Google gives the app a key to your Drive that lasts about an hour and is kept only in this tab. When it runs out, Google gives it a new one, asking you only if you've signed out of Google."}{' '}
          If someone in the household runs their own Amble server and connects it, the server is one more copy of the household's file,
          and notes its address on the file so your devices can move to it.
        </p>
        <h2>Reminders</h2>
        <p>
          {native
            ? 'A reminder you set is handed to your phone, which shows it at its time. With sync on, the phone also checks your household’s file in Drive about every 15 minutes for reminders you set elsewhere. Nothing goes through a push service.'
            : 'A reminder you set shows as a notification from this browser while Amble is open. Nothing goes through a push service.'}
        </p>
        <h2>Calendars</h2>
        <p>
          If you turn on Calendars in the Android app, Amble reads the calendars on your phone that you choose, through Android's own
          calendar permission, to work out how busy your days are and plan around them. Their events stay on the phone, from twelve
          weeks back to six months ahead, read again whenever Amble opens. Only how many minutes of each day are busy goes into the
          household's copy, so everyone else, and any Amble server, sees that a day is busier but never what's on it. Amble only reads:
          it never adds, edits or deletes events. Turning Calendars off removes the events from Amble.
        </p>
        <h2>AI features</h2>
        {auth?.ai ? (
          <p>
            This copy uses an AI model from {aiName}, with a key you entered that stays on this device. Task titles and related details
            go straight from this device to {aiName}'s API to turn what you type into tasks, estimate how long tasks take, word the
            morning's suggestions, plan your week and suggest tidying the backlog. With Calendars on, the titles and times of your
            own events that day or week go along for the morning's suggestions and planning your week.{' '}
            {AI_TRAINING[auth.ai.provider] ?? `${aiName}'s own terms say what it keeps and whether it learns from it.`}
          </p>
        ) : (
          <p>No AI model is set up, so nothing is sent to an AI service. If you set one up, this page will name it.</p>
        )}
        <h2>Your household's own server</h2>
        <p>
          If your household runs an Amble server and you sync with it, it keeps a copy of the household's tasks and lists on that
          computer, as a household file in Google Drive would, and the photos and files added to tasks, so everyone's devices have them. You sign in to it {server ? `with ${server.signIn}` : 'the way it lets you'}, and it keeps your
          name, email address and when you last signed in. It's a computer someone in your household keeps, not Amble's: Amble has no
          servers of its own.
          {server?.ai
            ? ` It has an AI model from ${server.ai.name}, which your device uses if it has none of its own. Then what you type for smart add and planning goes through the server to ${server.ai.name}.`
            : ''}
        </p>
        <h2>Claude and ChatGPT</h2>
        <p>
          With a server, you can connect Claude or ChatGPT to Amble. Then it can read and change your tasks, lists and plans when you
          ask it to, acting as you, and look at photos and text files the server has. What it reads becomes part of that conversation
          and is handled under your Anthropic or OpenAI account's privacy settings. Changes it makes show in Activity as made through
          it. You can disconnect it any time on the server's page.
        </p>
        <h2>Sharing</h2>
        <p>Amble never sells your data or shares it with anyone besides the services named above. There are no ads or trackers.</p>
        <h2>Removing your data</h2>
        <p>
          Stop syncing in Settings, then clear this site's data in your browser to remove everything from this device. A household file
          in Google Drive is removed like any other file there; Amble's hidden copy goes when you disconnect Amble at
          myaccount.google.com/connections. Whoever runs your household's server can remove your account and its copy there.
          {server?.privacyContact ? ` Questions: ${server.privacyContact}.` : ''}
        </p>
      </div>
    </main>
  );
}
