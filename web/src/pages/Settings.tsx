import { useQueryClient } from '@tanstack/react-query';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import Folder from '~icons/material-symbols/folder-outline-rounded';
import Bolt from '~icons/material-symbols/bolt-outline-rounded';
import Group from '~icons/material-symbols/group-outline-rounded';
import History from '~icons/material-symbols/history-rounded';
import Logout from '~icons/material-symbols/logout-rounded';
import Palette from '~icons/material-symbols/palette-outline-rounded';
import Policy from '~icons/material-symbols/policy-outline-rounded';
import Timer from '~icons/material-symbols/timer-outline-rounded';
import Trophy from '~icons/material-symbols/trophy-outline-rounded';
import { ListGroup, SectionTitle, SubpageHeader, Switch, minutesLabel } from '../components/ui.tsx';
import { type Member } from '../lib/api.ts';
import { useSaveMe } from '../lib/mutations.ts';
import { signOut } from '../lib/persist.ts';
import { useAi, useGroups, useMe, useMembers } from '../lib/queries.ts';

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
  const smartOn = me?.smartAdd ?? true;

  return (
    <>
      <SubpageHeader title="Settings" back="/" />

      <SectionTitle>You</SectionTitle>
      <ListGroup
        rows={[
          { icon: <Palette className="size-6" />, title: 'Appearance', subtitle: 'Color, style, light and dark', to: '/appearance' },
          { icon: <Timer className="size-6" />, title: 'Daily capacity', subtitle: capacitySummary(me), to: '/settings/capacity' },
          ai?.available
            ? {
                icon: <Sparkle className="size-6" />,
                title: 'Smart add',
                subtitle: 'Haiku turns what you type into tasks and list items for you to check',
                trailing: <Switch checked={smartOn} onChange={(v) => saveMe({ smartAdd: v }, `Turn smart add ${v ? 'on' : 'off'}`)} label="Smart add" />,
              }
            : {
                icon: <Sparkle className="size-6" />,
                title: 'Smart add',
                subtitle: 'Off: the server has no Anthropic API key',
              },
          {
            icon: <Trophy className="size-6" />,
            title: 'Streaks and records',
            subtitle: 'Shown on your Stats page',
            trailing: <Switch checked={showStreaks} onChange={(v) => saveMe({ showStreaks: v }, `${v ? 'Show' : 'Hide'} streaks`)} label="Show streaks and records" />,
          },
        ]}
      />

      <SectionTitle>Household</SectionTitle>
      <ListGroup
        rows={[
          {
            icon: <Group className="size-6" />,
            title: 'Household',
            subtitle: household ? `${household.members.length} ${household.members.length === 1 ? 'person' : 'people'}` : undefined,
            to: '/household',
          },
          {
            icon: <Folder className="size-6" />,
            title: 'Groups and lists',
            subtitle: groups ? `${taskGroups} ${taskGroups === 1 ? 'group' : 'groups'}, ${lists} ${lists === 1 ? 'list' : 'lists'}` : undefined,
            to: '/settings/groups',
          },
          { icon: <Sparkle className="size-6" />, title: 'Connect Claude', subtitle: 'Plan from any Claude chat', to: '/connections' },
          { icon: <History className="size-6" />, title: 'Activity', subtitle: 'What changed, and who changed it', to: '/activity' },
          ...(ai?.available
            ? [
                {
                  icon: <Bolt className="size-6" />,
                  title: 'AI this month',
                  subtitle: `$${ai.monthSpendUsd.toFixed(2)} of the $${ai.monthlyCapUsd} cap. Smart add pauses past it until next month.`,
                },
              ]
            : []),
        ]}
      />

      <SectionTitle>About</SectionTitle>
      <ListGroup
        rows={[
          { icon: <Policy className="size-6" />, title: 'Privacy', subtitle: 'What Almanac keeps and why', to: '/privacy' },
          { icon: <Logout className="size-6" />, title: 'Sign out', onClick: () => void signOut(qc) },
        ]}
      />
    </>
  );
}
