// The website's pages, which scripts/site.ts renders once to plain HTML: the front page and the
// privacy policy. They're built from the app's own parts (its styles, theme engine and icons), so
// the site looks and moves like Amble does.
import type { ComponentType, CSSProperties, ReactNode, SVGProps } from 'react';
import Android from '~icons/material-symbols/android';
import ArrowBack from '~icons/material-symbols/arrow-back-rounded';
import Attach from '~icons/material-symbols/attach-file-rounded';
import Spark from '~icons/material-symbols/auto-awesome-outline-rounded';
import Bug from '~icons/material-symbols/bug-report-outline-rounded';
import Call from '~icons/material-symbols/call-outline-rounded';
import Check from '~icons/material-symbols/check-rounded';
import Checklist from '~icons/material-symbols/checklist-rounded';
import Offline from '~icons/material-symbols/cloud-off-outline-rounded';
import Code from '~icons/material-symbols/code-rounded';
import CalendarMonth from '~icons/material-symbols/date-range-outline-rounded';
import EventAvailable from '~icons/material-symbols/event-available-outline-rounded';
import Favorite from '~icons/material-symbols/favorite-outline-rounded';
import Group from '~icons/material-symbols/group-outline-rounded';
import Hub from '~icons/material-symbols/hub-outline-rounded';
import Lightbulb from '~icons/material-symbols/lightbulb-outline-rounded';
import Lock from '~icons/material-symbols/lock-outline-rounded';
import Bell from '~icons/material-symbols/notifications-outline-rounded';
import Palette from '~icons/material-symbols/palette-outline-rounded';
import Repeat from '~icons/material-symbols/repeat-rounded';
import Save from '~icons/material-symbols/save-outline-rounded';
import Cart from '~icons/material-symbols/shopping-cart-outline-rounded';
import Spa from '~icons/material-symbols/spa-outline-rounded';
import Sunny from '~icons/material-symbols/sunny-outline-rounded';
import Sync from '~icons/material-symbols/sync-rounded';
import Terminal from '~icons/material-symbols/terminal-rounded';
import Widgets from '~icons/material-symbols/widgets-outline-rounded';
import { GroupIcon, tone } from '../web/src/components/icons.tsx';
import { PROJECT_URL } from '../web/src/lib/project.ts';
import { palettes } from '../web/src/lib/palettes.ts';
import { defaultTheme, previewColors, themeVariables } from '../web/src/lib/theme.ts';
import { Markdown } from './markdown.tsx';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export const SITE = 'https://amble-planner.vercel.app';
// Until Amble is on Google Play for everyone, people join the closed test by asking.
const JOIN_TEST = 'mailto:jonmartin721@gmail.com?subject=Amble%20Android%20test';

export interface Template {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
}

export interface SiteData {
  /** The stylesheet's address, from the build. */
  css: string;
  policy: string;
  templates: Template[];
}

const vars = (v: Record<string, string>) =>
  Object.entries(v)
    .map(([k, x]) => `${k}:${x};`)
    .join('');

/** The app's default theme (Grove), light and dark, as applyTheme() sets it in the app. */
function themeCss() {
  const prefs = { ...defaultTheme, phone: false };
  const dark = vars(themeVariables(prefs, true));
  return (
    `:root{${vars(themeVariables(prefs, false))}color-scheme:light}` +
    `@media (prefers-color-scheme: dark){:root{${dark}color-scheme:dark}}`
  );
}

/** One of Material 3 Expressive's shapes, the cookie: a circle with soft scallops, in a 2x2 box around 0. */
function cookie(lobes: number, depth = 0.07) {
  const points = Array.from({ length: 360 }, (_, i) => {
    const a = (i / 360) * Math.PI * 2;
    const r = 1 - depth + depth * Math.cos(lobes * a);
    return `${(Math.cos(a) * r).toFixed(4)} ${(Math.sin(a) * r).toFixed(4)}`;
  });
  return `M${points.join('L')}Z`;
}

function Page({ title, description, path, data, children }: { title: string; description: string; path: string; data: SiteData; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={`${SITE}${path}`} />
        <link rel="icon" href="/icon.svg" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content={themeVariables({ ...defaultTheme, phone: false }, false)['--md-surface']} />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={themeVariables({ ...defaultTheme, phone: false }, true)['--md-surface']} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={`${SITE}${path}`} />
        <meta property="og:image" content={`${SITE}/og.png`} />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="stylesheet" href={data.css} />
        <style dangerouslySetInnerHTML={{ __html: themeCss() }} />
      </head>
      <body>
        <TopBar />
        {children}
        <Footer />
      </body>
    </html>
  );
}

function TopBar() {
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 medium:px-5">
      <a href="/" className="flex items-center gap-2.5 rounded-full py-1.5 pr-4 pl-1.5">
        <img src="/icon.svg" alt="" width={36} height={36} className="size-9" />
        <span className="display text-xl font-medium">Amble</span>
      </a>
      <nav className="flex items-center gap-1">
        <a href="/privacy" className="rounded-full px-4 py-2.5 text-sm font-medium text-on-surface-variant">
          Privacy
        </a>
        <a href={PROJECT_URL} className="flex items-center gap-1.5 rounded-full px-4 py-2.5 text-sm font-medium text-primary">
          <Code className="size-5" aria-hidden />
          Source
        </a>
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer className="mx-auto mt-10 max-w-6xl px-6 pt-10 pb-[max(2.5rem,env(safe-area-inset-bottom))] text-sm text-on-surface-variant">
      <div className="flex flex-col gap-4 border-t border-outline-variant pt-8 medium:flex-row medium:items-center medium:justify-between">
        <p className="max-w-md">Made by a busy dad who got tired of paying for planners that weren't any good. Free software under the AGPL-3.0.</p>
        <nav className="-ml-3 flex flex-wrap gap-1">
          <a href="/privacy" className="rounded-full px-3 py-2 font-medium">
            Privacy policy
          </a>
          <a href={PROJECT_URL} className="rounded-full px-3 py-2 font-medium">
            Source code
          </a>
          <a href={`${PROJECT_URL}/issues/new/choose`} className="rounded-full px-3 py-2 font-medium">
            Report a bug
          </a>
        </nav>
      </div>
    </footer>
  );
}

function Section({ id, eyebrow, title, children }: { id?: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto max-w-6xl scroll-mt-6 px-6 py-14 medium:py-20">
      <p className="px-0.5 text-sm font-medium text-primary">{eyebrow}</p>
      <h2 className="display mt-2 max-w-3xl text-[2rem] leading-tight font-medium text-balance medium:text-[2.75rem]">{title}</h2>
      {children}
    </section>
  );
}

/** An icon in a round tonal container, as the app's own lists and first screen show them. */
function Badge({ icon: I, className = 'bg-secondary-container text-on-secondary-container' }: { icon: Icon; className?: string }) {
  return (
    <span className={`grid size-12 shrink-0 place-items-center rounded-full ${className}`}>
      <I className="size-6" aria-hidden />
    </span>
  );
}

/** The rows of a grouped list: round at the ends of the group, nearly square between (segment() in the app). */
function segment(i: number, n: number) {
  if (n === 1) return 'rounded-3xl';
  if (i === 0) return 'rounded-t-3xl rounded-b-md';
  if (i === n - 1) return 'rounded-t-md rounded-b-3xl';
  return 'rounded-md';
}

const shots = [
  { file: 'briefing', caption: 'Each morning: how full the day is, and a few things worth doing today.' },
  { file: 'today', caption: 'Today, by morning, afternoon and evening, with a meter for how full it is.' },
  { file: 'calendar', caption: 'The week at a glance, and the day with room for each thing due.' },
  { file: 'quick-add', caption: 'Quick add picks up the day, the group and who it’s for as you type.' },
  { file: 'groceries', caption: 'Groceries sort themselves by aisle, here in dark mode.' },
  { file: 'lists', caption: 'Eleven list templates, from packing to a meal plan.' },
  { file: 'task', caption: 'A task with its group, notes and steps.' },
  { file: 'appearance', caption: 'Nine calm palettes, each with its own name, or your wallpaper’s colors.' },
];

function Shot({ file, alt, className, style, lazy }: { file: string; alt: string; className?: string; style?: CSSProperties; lazy?: boolean }) {
  return (
    <img
      src={`/screenshots/${file}.png`}
      alt={alt}
      width={780}
      height={1688}
      loading={lazy ? 'lazy' : undefined}
      style={style}
      className={`rounded-[1.75rem] ring-1 ring-outline-variant/60 ${className ?? ''}`}
    />
  );
}

function Hero() {
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pt-6 pb-10 expanded:grid-cols-[1.1fr_1fr] expanded:pt-14 expanded:pb-20">
      <div className="page-in">
        <p className="chip chip-on w-fit">
          <Favorite aria-hidden />
          Free, for you, forever
        </p>
        <h1 className="display mt-6 text-[2.75rem] leading-[1.05] font-medium text-balance medium:text-[4rem]">Get it all out of your head. Amble works out when.</h1>
        <p className="mt-6 max-w-xl text-lg text-on-surface-variant medium:text-xl">
          Most to-do apps keep a growing list of what you haven’t done. Amble knows how full each day already is from your tasks and your phone’s calendar, so
          it shows what fits today and finds a day with room for the rest. It’s free and it never nags.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href={JOIN_TEST} className="press flex h-14 items-center gap-2.5 rounded-full bg-primary px-7 text-lg font-medium text-on-primary">
            <Android className="size-6" aria-hidden />
            Join the Android test
          </a>
          <a href="#tour" className="press flex h-14 items-center rounded-full bg-secondary-container px-7 text-lg font-medium text-on-secondary-container">
            See it
          </a>
        </div>
        <p className="mt-4 max-w-md text-sm text-on-surface-variant">
          Amble is being tested on Google Play before it opens to everyone. Email to join, and you’ll get the link.
        </p>
      </div>
      <div className="relative mx-auto aspect-square w-full max-w-[32rem]" aria-hidden>
        <svg viewBox="-1 -1 2 2" className="grow-in absolute inset-0 size-full text-primary-container">
          <path d={cookie(9)} fill="currentColor" />
        </svg>
        <Shot file="today" alt="" className="page-in absolute top-[17%] left-[3%] w-[33%] -rotate-6 shadow-xl" style={{ animationDelay: '140ms' }} />
        <Shot file="calendar" alt="" className="page-in absolute top-[17%] right-[3%] w-[33%] rotate-6 shadow-xl" style={{ animationDelay: '200ms' }} />
        <Shot file="briefing" alt="" className="page-in absolute top-[6%] left-1/2 w-[39%] -translate-x-1/2 shadow-2xl" style={{ animationDelay: '60ms' }} />
      </div>
    </section>
  );
}

const promises: { icon: Icon; title: string; body: string }[] = [
  { icon: Favorite, title: 'Free, all of it', body: 'Every feature is free with no account or ads or subscription.' },
  {
    icon: Hub,
    title: 'Works with what you already use',
    body: 'Amble reads your phone’s calendar and syncs through your own Google Drive. Claude can add and plan your tasks through a household server, and the AI features work with whatever model you pick, from Gemini’s free tier to one on your own computer.',
  },
  {
    icon: Terminal,
    title: 'Easy to set up',
    body: 'On Android you install it and start. A household server is one Docker container, and a setup script does the rest, Tailscale included. Phones join it with a code.',
  },
  {
    icon: Checklist,
    title: 'Keeps track of everything',
    body: 'Tasks, chores, groceries, errands and who’s doing what all go in one place. Anything you didn’t get to comes back quietly as a suggestion.',
  },
];

/** Why Amble exists, from the person who started it, and what that means for anyone who uses it. */
function WhyAmble() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-6 medium:px-6">
      <div className="grid gap-10 rounded-[2.5rem] bg-surface-container px-6 py-10 medium:px-10 expanded:grid-cols-[1fr_1.5fr] expanded:py-12">
        <div className="flex flex-col">
          <p className="px-0.5 text-sm font-medium text-primary">From one tired dad to all of you</p>
          <p className="display mt-4 text-[1.75rem] leading-snug medium:text-[2rem]">
            I got really tired of paying for planners and of figuring out which flaky app connectors would actually work. So I made my own, and I made it free for
            everyone.
          </p>
          <p className="mt-5 text-on-surface-variant">Jon</p>
        </div>
        <ul data-cascade className="grid gap-x-6 gap-y-8 medium:grid-cols-2">
          {promises.map((p) => (
            <li key={p.title} className="flex flex-col gap-3">
              <Badge icon={p.icon} className="bg-primary-container text-on-primary-container" />
              <h3 className="text-lg font-medium">{p.title}</h3>
              <p className="text-on-surface-variant">{p.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const different: { icon: Icon; title: string; body: string }[] = [
  {
    icon: EventAvailable,
    title: 'It knows when you’re busy',
    body: 'Amble reads the phone calendars you pick and learns how much you usually get done, so a busy day gets fewer tasks. Only how many minutes of each day are busy ever leaves your phone.',
  },
  {
    icon: Sunny,
    title: 'Today stays light',
    body: 'Your day is split into morning, afternoon and evening with a meter for how full it is. Each morning shows what’s on your calendar, what someone handed you and a few tasks worth pulling in. Nothing moves until you tap Add.',
  },
  {
    icon: CalendarMonth,
    title: 'Things due later land on a good day',
    body: 'A task with a deadline shows the day with the most room before it, and Plan my week lays out the next seven days around your calendar.',
  },
  {
    icon: Spa,
    title: 'No guilt',
    body: 'No red overdue counts, no badges, no streaks to keep up, and no notifications except the reminders you ask for. Anything you didn’t get to comes back quietly as a suggestion.',
  },
];

const listPoints = [
  'Groceries sort themselves by aisle as you type, and the whole list plans as one grocery run on the day with room.',
  'A meal plan sends each dinner’s ingredients to Groceries in one tap.',
  'Packing lists and routines start from a kit, and Start over unchecks everything for next time.',
  'Gift ideas go under who they’re for and start out private, so nobody sees their own.',
  'Errands group by place and plan as one run.',
];

const smartAdd: { icon: Icon; title: string; detail: string }[] = [
  { icon: Call, title: 'Call mom', detail: 'Tomorrow, evening' },
  { icon: Cart, title: 'Milk', detail: 'Groceries' },
  { icon: Cart, title: 'Eggs', detail: 'Groceries' },
  { icon: Repeat, title: 'Mow the lawn', detail: 'Alex, every Saturday' },
];

const everything: { icon: Icon; text: string }[] = [
  { icon: Group, text: 'Hand a task to someone in your household with a note, or leave it open to anyone. Any group or list can be private.' },
  { icon: Repeat, text: 'Repeating tasks on a schedule (every Sunday, the 2nd Thursday) or a set time after the last one was done.' },
  { icon: Bell, text: 'Reminders only when you ask for one, with Done and Snooze right on them.' },
  { icon: Attach, text: 'Photos, receipts and manuals on tasks.' },
  { icon: Offline, text: 'Works offline from the first open, since everything is on your phone.' },
  { icon: Sync, text: 'Sync your devices and household through a file in your own Google Drive.' },
  { icon: Save, text: 'Save everything to one file whenever you like, and start a new phone from it.' },
  { icon: Widgets, text: 'Today’s tasks on your home screen, and a task beside its list on a foldable or tablet.' },
];

/** How Amble grows with a household: the app, then a server only for what needs one. What each adds and takes. */
const layers: { title: string; note?: string; body: string; adds: string[]; takes: string; link: string; href: string; primary?: boolean }[] = [
  {
    title: 'The app',
    note: 'Where most people stop',
    body: 'Install it on Android and start. There’s no account to make, and everything stays on your phone and works offline.',
    adds: [
      'Days planned around your calendar, with lists, reminders and the morning check-in',
      'Sync for your devices and your household through one file in your own Google Drive',
      'One AI model for the household, set up once, for smart add, Plan my week and Tidy up',
    ],
    takes: 'An Android phone. A Google account to sync, and an AI key if you want one: Gemini and GLM have free tiers, or use a model on your own computer.',
    link: 'Join the Android test',
    href: JOIN_TEST,
    primary: true,
  },
  {
    title: 'A household server',
    body: 'One Docker container on a computer that stays on, for what only a server can do.',
    adds: [
      'Claude and ChatGPT, adding and planning your tasks from a chat',
      'Photos and files on tasks, shared between phones',
      'The web app for iPhones and computers',
      'Syncing without Google, with the AI key locked on the server',
    ],
    takes:
      'A computer that stays on, and Tailscale, which is free for a household. A script sets it all up on Linux, a Mac or Windows, and phones join with a code, so there’s nothing to set up with Google.',
    link: 'How to run one',
    href: `${PROJECT_URL}/blob/main/docs/self-hosting.md`,
  },
];

function Home({ data }: { data: SiteData }) {
  return (
    <main>
      <Hero />

      <WhyAmble />

      <Section eyebrow="How it plans" title="Amble asks how much room today has, and plans around it">
        <ul data-cascade className="mt-10 grid gap-3 medium:grid-cols-2">
          {different.map((d) => (
            <li key={d.title} className="flex flex-col gap-4 rounded-[1.75rem] bg-surface-container p-6">
              <Badge icon={d.icon} />
              <h3 className="text-xl font-medium">{d.title}</h3>
              <p className="text-on-surface-variant">{d.body}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="tour" eyebrow="A look around" title="Calm on purpose, and quick when you need it">
        <div className="scroll-row -mx-6 mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-2 expanded:mx-0 expanded:grid expanded:grid-cols-4 expanded:gap-x-5 expanded:gap-y-8 expanded:overflow-visible expanded:px-0">
          {shots.map((s) => (
            <figure key={s.file} className="w-[13rem] shrink-0 snap-start expanded:w-auto">
              <Shot file={s.file} alt={s.caption} className="w-full" lazy />
              <figcaption className="mt-3 px-1 text-sm text-on-surface-variant">{s.caption}</figcaption>
            </figure>
          ))}
        </div>
      </Section>

      <Section eyebrow="Lists that do some of the work" title="Lists that know what they’re for">
        <div className="mt-10 grid gap-10 expanded:grid-cols-[1fr_1.15fr]">
          <div className="flex flex-col gap-5">
            <ul className="flex flex-col gap-3 text-lg">
              {listPoints.map((p) => (
                <li key={p} className="flex gap-3">
                  <span className="mt-2.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />
                  {p}
                </li>
              ))}
            </ul>
            <p className="text-on-surface-variant">
              Each of the 11 templates is one small file in an <a href={`${PROJECT_URL}/blob/main/templates/README.md`} className="font-medium text-primary">open format</a>, so
              anyone can write a new one or use them in another app.
            </p>
          </div>
          <ul data-cascade className="flex flex-col gap-0.5">
            {data.templates.map((t, i) => (
              <li key={t.id} className={`flex items-center gap-4 bg-surface-low px-4 py-3 ${segment(i, data.templates.length)}`}>
                <span className={`grid size-10 shrink-0 place-items-center rounded-full ${tone(t.color)}`}>
                  <GroupIcon name={t.icon} className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">{t.name}</span>
                  <span className="block text-sm text-on-surface-variant">{t.description}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section id="ai" eyebrow="AI when you want it" title="Works fully without AI. Add a model and it takes on the fiddly parts.">
        <div className="mt-10 grid items-start gap-10 expanded:grid-cols-2">
          <div className="rounded-[2rem] bg-surface-container p-5 medium:p-6">
            <p className="flex items-center gap-2 text-sm font-medium text-primary">
              <Spark className="size-5" aria-hidden />
              Smart add
            </p>
            <p className="display mt-3 text-2xl leading-snug medium:text-[1.75rem]">call mom tomorrow evening, out of milk and eggs, Alex mows every Saturday</p>
            <ul data-cascade className="mt-5 flex flex-col gap-0.5">
              {smartAdd.map((r, i) => (
                <li key={r.title} className={`flex items-center gap-3.5 bg-surface-lowest px-4 py-3 ${segment(i, smartAdd.length)}`}>
                  <r.icon className="size-6 shrink-0 text-on-surface-variant" aria-hidden />
                  <span className="min-w-0">
                    <span className="block font-medium">{r.title}</span>
                    <span className="block text-sm text-on-surface-variant">{r.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 px-1 text-sm text-on-surface-variant">Each one waits for you to check it before anything is saved.</p>
          </div>
          <div className="flex flex-col gap-5 text-lg">
            <p>
              <strong className="font-medium">Plan my week</strong> listens to what you tell it (“keep Saturday free”), and <strong className="font-medium">Tidy up</strong>{' '}
              suggests merging duplicates and splitting tasks that are really several. Tasks you didn’t size get a guess, so the day’s meter stays honest.
            </p>
            <p className="text-on-surface-variant">
              Bring your own key for Claude, OpenAI, Gemini, GLM or anything on OpenRouter (Gemini and GLM have free tiers), or run a model on your own computer
              through Ollama or LM Studio. One person sets it up for the whole household, with a monthly cap.
            </p>
          </div>
        </div>
      </Section>

      <Section eyebrow="Made to feel good" title="Built on Material 3 Expressive, springs and all">
        <div className="mt-10 grid items-center gap-10 expanded:grid-cols-[1.2fr_1fr]">
          <div className="flex flex-col gap-5 text-lg">
            <p>
              A task grows out of the row you tapped and shrinks back into it when you pull it down, and sheets ride up with the keyboard. Today’s tasks can sit on
              your home screen in a widget, and on a foldable or tablet a task opens beside its list.
            </p>
            <p className="text-on-surface-variant">Pick one of nine calm palettes, each tuned by hand, or your wallpaper’s own colors, light or dark.</p>
          </div>
          <ul className="grid grid-cols-3 gap-3" aria-label="The palettes to pick from">
            {palettes.map((p) => {
              const c = previewColors(p, false);
              return (
                <li key={p.id} className="flex flex-col items-center gap-2">
                  <span className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-full bg-surface-high">
                    <span
                      className="absolute inset-[14%] rounded-full"
                      style={{ background: `conic-gradient(from -90deg, ${c.primary} 0 50%, ${c.tertiaryContainer} 50% 75%, ${c.secondaryContainer} 75% 100%)` }}
                    />
                  </span>
                  <span className="text-sm text-on-surface-variant">{p.name}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </Section>

      <section className="mx-auto max-w-6xl px-4 py-10 medium:px-6">
        <div className="rounded-[2.5rem] bg-primary-container px-6 py-10 text-on-primary-container medium:px-12 medium:py-14">
          <h2 className="display max-w-3xl text-[2rem] leading-tight font-medium text-balance medium:text-[2.75rem]">Free, for you, forever. Your things stay yours.</h2>
          <ul data-cascade className="mt-8 grid gap-6 medium:grid-cols-3">
            <li className="flex flex-col gap-3">
              <Favorite className="size-7" aria-hidden />
              <p className="text-lg">Every feature, with no account, no ads and no subscription. There’s no paid tier waiting down the road.</p>
            </li>
            <li className="flex flex-col gap-3">
              <Lock className="size-7" aria-hidden />
              <p className="text-lg">Amble has no servers of its own, so its developer never receives your data. Your tasks stay on your phone.</p>
            </li>
            <li className="flex flex-col gap-3">
              <Sync className="size-7" aria-hidden />
              <p className="text-lg">Sync goes only to your own Google Drive or a server your household runs, and AI talks only to the provider you set up.</p>
            </li>
          </ul>
          <a href="/privacy" className="press mt-10 inline-flex h-12 items-center rounded-full bg-primary px-6 font-medium text-on-primary">
            Read the privacy policy
          </a>
        </div>
      </section>

      <Section eyebrow="Everything else" title="The rest of what’s in there">
        <ul data-cascade className="mt-10 grid gap-x-8 gap-y-6 medium:grid-cols-2">
          {everything.map((e) => (
            <li key={e.text} className="flex items-start gap-4">
              <Badge icon={e.icon} className="bg-surface-container text-primary" />
              <p className="pt-3">{e.text}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="get" eyebrow="Get it" title="Start with the app. Add a server only if you want one.">
        <p className="mt-5 max-w-2xl text-lg text-on-surface-variant">Most households only ever need the app. A server adds the rest, and Amble is free either way.</p>
        <ol data-cascade className="mt-10 flex flex-col">
          {layers.map((l, i) => (
            <li key={l.title} className={`grid medium:grid-cols-[3rem_1fr] medium:gap-x-6 ${i < layers.length - 1 ? 'pb-3' : ''}`}>
              <div className="hidden flex-col items-center medium:flex" aria-hidden>
                <span className="display grid size-12 place-items-center rounded-full bg-primary text-xl font-medium text-on-primary">{i + 1}</span>
                {i < layers.length - 1 && <span className="mt-3 w-0.5 flex-1 rounded-full bg-outline-variant" />}
              </div>
              {/* On a phone the link comes last; on a wide screen it sits under the step's description. */}
              <div className="grid gap-6 rounded-[1.75rem] bg-surface-container p-6 medium:p-7 expanded:grid-cols-2 expanded:grid-rows-[auto_1fr] expanded:gap-x-10">
                <div className="flex flex-col items-start gap-3">
                  <div className="flex items-center gap-3">
                    <span className="display grid size-9 shrink-0 place-items-center rounded-full bg-primary font-medium text-on-primary medium:hidden" aria-hidden>
                      {i + 1}
                    </span>
                    <h3 className="text-xl font-medium">{l.title}</h3>
                  </div>
                  {l.note && <span className="chip chip-on">{l.note}</span>}
                  <p className="text-on-surface-variant">{l.body}</p>
                </div>
                <div className="flex flex-col gap-5 expanded:col-start-2 expanded:row-span-2 expanded:row-start-1">
                  <div>
                    <h4 className="text-sm font-medium text-primary">What it adds</h4>
                    <ul className="mt-2 flex flex-col gap-1.5">
                      {l.adds.map((a) => (
                        <li key={a} className="flex gap-2.5">
                          <Check className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                          {a}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-primary">What it takes</h4>
                    <p className="mt-2 text-on-surface-variant">{l.takes}</p>
                  </div>
                </div>
                {l.primary ? (
                  <a
                    href={l.href}
                    className="press flex h-12 w-fit items-center gap-2 rounded-full bg-primary px-6 font-medium text-on-primary expanded:col-start-1 expanded:row-start-2 expanded:self-end"
                  >
                    <Android className="size-5" aria-hidden />
                    {l.link}
                  </a>
                ) : (
                  <a href={l.href} className="w-fit rounded-full py-2 font-medium text-primary expanded:col-start-1 expanded:row-start-2 expanded:self-end">
                    {l.link}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-6 max-w-2xl text-on-surface-variant">
          On an iPhone or a computer, Amble is the web app from a household server. A native iPhone app is wanted,{' '}
          <a href={`${PROJECT_URL}/blob/main/CONTRIBUTING.md#help-wanted`} className="font-medium text-primary">
            if you’d like to build it
          </a>
          .
        </p>
      </Section>

      <Section eyebrow="Help make it better" title="Made in the open, and help of any size is welcome">
        <ul data-cascade className="mt-10 flex flex-col gap-0.5 expanded:max-w-3xl">
          {[
            { icon: Lightbulb, title: 'Ideas and bug reports', detail: 'Open an issue', href: `${PROJECT_URL}/issues/new/choose` },
            { icon: Palette, title: 'A new list template', detail: 'One JSON file, and a good first pull request', href: `${PROJECT_URL}/blob/main/templates/README.md` },
            { icon: Code, title: 'Code', detail: 'Setup, the layout and the checks to run', href: `${PROJECT_URL}/blob/main/CONTRIBUTING.md` },
            { icon: Bug, title: 'Security', detail: 'Report a problem privately', href: `${PROJECT_URL}/blob/main/SECURITY.md` },
          ].map((r, i, all) => (
            <li key={r.title}>
              <a href={r.href} className={`press-soft flex items-center gap-4 bg-surface-low px-4 py-3.5 ${segment(i, all.length)}`}>
                <r.icon className="size-6 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0">
                  <span className="block font-medium">{r.title}</span>
                  <span className="block text-sm text-on-surface-variant">{r.detail}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </Section>
    </main>
  );
}

function Privacy({ data }: { data: SiteData }) {
  const updated = /^Last updated (.+)$/m.exec(data.policy)?.[1];
  return (
    <main className="page-in mx-auto max-w-2xl px-6 pt-4 pb-10 text-lg leading-relaxed">
      <a href="/" className="-ml-3 inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-on-surface-variant">
        <ArrowBack className="size-5" aria-hidden />
        Amble
      </a>
      <h1 className="display mt-6 text-[2.75rem] leading-tight font-medium medium:text-[3.5rem]">Privacy policy</h1>
      {updated && <p className="mt-2 text-base text-on-surface-variant">Last updated {updated}</p>}
      <Markdown source={data.policy} />
    </main>
  );
}

/** Each page's address and what's on it. */
export const pages: { path: string; render: (data: SiteData) => ReactNode }[] = [
  {
    path: '/',
    render: (data) => (
      <Page
        path="/"
        title="Amble: a simple planner for you and your household"
        description="A free household planner that knows how full each day is, from your tasks and your phone's calendar. No account, no ads, and it never nags."
        data={data}
      >
        <Home data={data} />
      </Page>
    ),
  },
  {
    path: '/privacy',
    render: (data) => (
      <Page path="/privacy" title="Privacy policy · Amble" description="What the Amble app keeps, where it goes, and how to remove it." data={data}>
        <Privacy data={data} />
      </Page>
    ),
  },
];
