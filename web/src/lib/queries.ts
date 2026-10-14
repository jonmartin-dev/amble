import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  api,
  type ActivityPage,
  type DayLoad,
  type Group,
  type HouseholdMember,
  type ListItem,
  type Session,
  type Stats,
  type Task,
  type Today,
} from './api.ts';
import { weekStartDay } from './dates.ts';

export function useSession() {
  return useQuery({ queryKey: ['session'], queryFn: () => api<Session>('/session'), staleTime: 60_000 });
}

export function useMe() {
  const { data } = useSession();
  return data?.member ?? null;
}

export function useGroups() {
  return useQuery({ queryKey: ['groups'], queryFn: () => api<{ groups: Group[] }>('/groups'), select: (d) => d.groups });
}

export function useArchivedGroups() {
  return useQuery({
    queryKey: ['groups', 'archived'],
    queryFn: () => api<{ groups: Group[] }>('/groups?archived=1'),
    select: (d) => d.groups,
  });
}

export function useMembers() {
  return useQuery({
    queryKey: ['members'],
    queryFn: () => api<{ members: HouseholdMember[]; pending: string[] }>('/members'),
    staleTime: 5 * 60_000,
  });
}

/** `who` is "me", "everyone", or a member id. */
export function useToday(who = 'me') {
  return useQuery({
    queryKey: ['today', who],
    queryFn: () => api<Today>(`/today?who=${encodeURIComponent(who)}`),
    placeholderData: keepPreviousData,
  });
}

export function useLoad(start: string, end: string, enabled = true, who = 'me') {
  return useQuery({
    queryKey: ['load', start, end, who],
    queryFn: () => api<{ days: DayLoad[] }>(`/load?start=${start}&end=${end}&who=${encodeURIComponent(who)}`),
    select: (d) => d.days,
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useTasks(params: Record<string, string> = {}, enabled = true) {
  const query = new URLSearchParams(params).toString();
  return useQuery({
    queryKey: ['tasks', params],
    queryFn: () => api<{ tasks: Task[] }>(`/tasks${query ? `?${query}` : ''}`),
    select: (d) => d.tasks,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useTask(id: string) {
  return useQuery({ queryKey: ['task', id], queryFn: () => api<{ task: Task }>(`/tasks/${id}`), select: (d) => d.task });
}

export function useTaskActivity(id: string) {
  return useQuery({
    queryKey: ['activity', 'task', id],
    queryFn: () => api<ActivityPage>(`/tasks/${id}/activity`),
    select: (d) => d.entries,
  });
}

export function useActivity() {
  return useInfiniteQuery({
    queryKey: ['activity', 'feed'],
    queryFn: ({ pageParam }) => api<ActivityPage>(`/activity?limit=40${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

export function useStats() {
  return useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>(`/stats?weeks=12&weekStart=${weekStartDay()}`) });
}

export function useList(groupId: string) {
  return useQuery({
    queryKey: ['list', groupId],
    queryFn: () => api<{ group: Group; open: ListItem[]; checked: ListItem[] }>(`/lists/${groupId}`),
  });
}
