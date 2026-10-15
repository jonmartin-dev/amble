import { useQueryClient } from '@tanstack/react-query';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import Folder from '~icons/material-symbols/folder-outline-rounded';
import CalendarMonth from '~icons/material-symbols/calendar-month-outline-rounded';
import Forum from '~icons/material-symbols/forum-outline-rounded';
import Group from '~icons/material-symbols/group-outline-rounded';
import History from '~icons/material-symbols/history-rounded';
import Logout from '~icons/material-symbols/logout-rounded';
import Neurology from '~icons/material-symbols/neurology-outline-rounded';
import Bell from '~icons/material-symbols/notifications-outline-rounded';
import CloudSync from '~icons/material-symbols/cloud-sync-outline-rounded';
import Palette from '~icons/material-symbols/palette-outline-rounded';
import Policy from '~icons/material-symbols/policy-outline-rounded';
import Timer from '~icons/material-symbols/timer-outline-rounded';
import Trophy from '~icons/material-symbols/trophy-outline-rounded';
import Widgets from '~icons/material-symbols/widgets-outline-rounded';
import { ListGroup, SectionTitle, SubpageHeader, Switch, minutesLabel } from '../components/ui.tsx';
import { type Member } from '../lib/api.ts';
import { onDevice } from '../lib/device.ts';
import { native, pinTodayWidget } from '../lib/native.ts';
import { useDriveSync } from '../lib/drive-sync.ts';
import { useSaveMe } from '../lib/mutations.ts';
import { signOut } from '../lib/persist.ts';
import { usePushState } from '../lib/push.ts';
import { notificationSummary } from './Notifications.tsx';
import { useAi, useCalendars, useGroups, useMe, useMembers } from '../lib/queries.ts';

export function capacitySummary(me: Member | null) {
  const pinned = Object.keys(me?.capacity ?? {}).length;
  if (!pinned) return 'Learned from what you finish';
  return pinned === 7 ? 'Pinned by you, every day' : `Learned, with ${pinned} ${pinned === 1 ? 'day' : 'days'} pinned`;
}

export function Settings() {
  const me = useMe();
  const qc = useQueryClient();
  const saveMe = useSaveMe();
  const { data: household } = useMembers();
  const { data: groups } = useGroups();
  const lists = groups?.filter((g) => g.kind === 'list').length ?? 0;
  const taskGroups = (groups?.length ?? 0) - lists;

  const showStreaks = me?.showStreaks ?? true;
  const { data: ai } = useAi();
  const { data: calendars } = useCalendars();
  const push = usePushState();
  const drive = useDriveSync().status;
  const syncSummary = !drive?.on
    ? 'Off: everything stays on this device'
    : drive.target?.kind === 'household'
      ? `Household, through ${drive.account?.email ?? 'Google Drive'}`
      : `Backed up to ${drive.account?.email ?? 'Google Drive'}`;
  const smartOn = me?.smartAdd ?? true;
  const counted = calendars?.accounts.flatMap((a) => a.calendars.filter((c) => c.counts)).length ?? 0;
  const calendarSummary = !calendars
    ? undefined
    : !calendars.enabled
      ? 'Not set up on this server'
      : calendars.accounts.some((a) => a.status === 'reconnect')
        ? 'Needs connecting again'
        : calendars.accounts.length === 0
          ? 'Connect Google Calendar so busy days have less room'
          : `${counted} ${counted === 1 ? 'calendar counts' : 'calendars count'} toward your days`;

  return (
    <>
      <SubpageHeader title="Settings" back="/" />

      <SectionTitle>You</SectionTitle>
      <ListGroup
        rows={[
          { icon: <Palette className="size-6" />, title: 'Appearance', subtitle: 'Color, style, light and dark', to: '/appearance' },
          { icon: <Timer className="size-6" />, title: 'Daily capacity', subtitle: capacitySummary(me), to: '/settings/capacity' },
          { icon: <CalendarMonth className="size-6" />, title: 'Calendars', subtitle: calendarSummary, to: '/settings/calendars' },
          { icon: <Bell className="size-6" />, title: 'Notifications', subtitle: notificationSummary(push.state), to: '/settings/notifications' },
          {
            icon: <Trophy className="size-6" />,
            title: 'Streaks and records',
            subtitle: 'Shown on your Stats page',
            trailing: <Switch checked={showStreaks} onChange={(v) => saveMe({ showStreaks: v }, `${v ? 'Show' : 'Hide'} streaks`)} label="Show streaks and records" />,
          },
        ]}
      />

      {onDevice ? (
        <>
          <SectionTitle>This device</SectionTitle>
          <ListGroup
            rows={[
              { icon: <CloudSync className="size-6" />, title: 'Sync and backup', subtitle: syncSummary, to: '/settings/sync' },
              ...(native
                ? [{ icon: <Widgets className="size-6" />, title: 'Today on your home screen', subtitle: "A widget with today's tasks", onClick: () => void pinTodayWidget() }]
                : []),
            ]}
          />
        </>
      ) : (
        me?.role === 'admin' && (
          <>
            <SectionTitle>Server</SectionTitle>
            <ListGroup
              rows={[{ icon: <CloudSync className="size-6" />, title: 'Sync with Google Drive', subtitle: 'Keep this server in step with your devices', to: '/settings/sync' }]}
            />
          </>
        )
      )}

      <SectionTitle>Household</SectionTitle>
      <ListGroup
        rows={[
          {
            icon: <Group className="size-6" />,
            title: 'People',
            subtitle: household ? `${household.members.length} ${household.members.length === 1 ? 'person' : 'people'}` : undefined,
            to: '/household',
          },
          {
            icon: <Folder className="size-6" />,
            title: 'Groups and lists',
            subtitle: groups ? `${taskGroups} ${taskGroups === 1 ? 'group' : 'groups'}, ${lists} ${lists === 1 ? 'list' : 'lists'}` : undefined,
            to: '/settings/groups',
          },
          { icon: <History className="size-6" />, title: 'Activity', subtitle: 'What changed, and who changed it', to: '/activity' },
        ]}
      />

      <SectionTitle>AI</SectionTitle>
      <ListGroup
        rows={[
          {
            icon: <Neurology className="size-6" />,
            title: 'AI model',
            subtitle: !ai
              ? undefined
              : ai.available
                ? `${ai.modelName}${ai.priced ? `, $${ai.monthSpendUsd.toFixed(2)} of $${ai.monthlyCapUsd} this month` : ''}`
                : 'None yet, so quick add takes text as typed',
            to: '/settings/ai',
          },
          // Smart add is each person's own choice, once there's a model to do it.
          ...(ai?.available
            ? [
                {
                  icon: <Sparkle className="size-6" />,
                  title: 'Smart add',
                  subtitle: 'Turns what you type into tasks and list items for you to check',
                  trailing: <Switch checked={smartOn} onChange={(v) => saveMe({ smartAdd: v }, `Turn smart add ${v ? 'on' : 'off'}`)} label="Smart add" />,
                },
              ]
            : []),
          {
            icon: <Forum className="size-6" />,
            title: 'Connect an assistant',
            subtitle: onDevice ? 'Plan from Claude or ChatGPT, with your own Amble server' : 'Plan from a Claude or ChatGPT chat',
            to: '/connections',
          },
        ]}
      />

      <SectionTitle>About</SectionTitle>
      <ListGroup
        rows={[
          { icon: <Policy className="size-6" />, title: 'Privacy', subtitle: 'What Amble keeps and why', to: '/privacy' },
          // On a device there's nobody to sign out; the data is this device's.
          ...(onDevice ? [] : [{ icon: <Logout className="size-6" />, title: 'Sign out', onClick: () => void signOut(qc) }]),
        ]}
      />
    </>
  );
}
