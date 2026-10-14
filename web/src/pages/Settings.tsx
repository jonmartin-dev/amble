import { useMutation, useQueryClient } from '@tanstack/react-query';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import Folder from '~icons/material-symbols/folder-outline-rounded';
import Group from '~icons/material-symbols/group-outline-rounded';
import History from '~icons/material-symbols/history-rounded';
import Logout from '~icons/material-symbols/logout-rounded';
import Palette from '~icons/material-symbols/palette-outline-rounded';
import Policy from '~icons/material-symbols/policy-outline-rounded';
import Timer from '~icons/material-symbols/timer-outline-rounded';
import Trophy from '~icons/material-symbols/trophy-outline-rounded';
import { ListGroup, SectionTitle, SubpageHeader, Switch, minutesLabel } from '../components/ui.tsx';
import { api, signOut, type Member } from '../lib/api.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { useGroups, useMe, useMembers } from '../lib/queries.ts';

export function capacitySummary(me: Member | null) {
  const custom = Object.keys(me?.capacity ?? {}).length > 0;
  return custom ? 'Set by you, day by day' : `About ${minutesLabel(180)} on weekdays and ${minutesLabel(240)} on weekends`;
}

export function Settings() {
  const me = useMe();
  const qc = useQueryClient();
  const snack = useSnackbar();
  const { data: household } = useMembers();
  const { data: groups } = useGroups();
  const lists = groups?.filter((g) => g.kind === 'list').length ?? 0;
  const taskGroups = (groups?.length ?? 0) - lists;

  const streaks = useMutation({
    mutationFn: (showStreaks: boolean) => api('/me', { method: 'PATCH', body: JSON.stringify({ showStreaks }) }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['session'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (e: Error) => snack({ message: e.message }),
  });
  const showStreaks = streaks.isPending ? streaks.variables : (me?.showStreaks ?? true);

  return (
    <>
      <SubpageHeader title="Settings" back="/" />

      <SectionTitle>You</SectionTitle>
      <ListGroup
        rows={[
          { icon: <Palette className="size-6" />, title: 'Appearance', subtitle: 'Color, style, light and dark', to: '/appearance' },
          { icon: <Timer className="size-6" />, title: 'Daily capacity', subtitle: capacitySummary(me), to: '/settings/capacity' },
          {
            icon: <Trophy className="size-6" />,
            title: 'Streaks and records',
            subtitle: 'Shown on your Stats page',
            trailing: <Switch checked={showStreaks} onChange={(v) => streaks.mutate(v)} label="Show streaks and records" />,
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
        ]}
      />

      <SectionTitle>About</SectionTitle>
      <ListGroup
        rows={[
          { icon: <Policy className="size-6" />, title: 'Privacy', subtitle: 'What Almanac keeps and why', to: '/privacy' },
          { icon: <Logout className="size-6" />, title: 'Sign out', onClick: () => void signOut() },
        ]}
      />
    </>
  );
}
