import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type ActivityPage,
  type AiStatus,
  type CapacityDay,
  type DayLoad,
  type Group,
  type HouseholdMember,
  type ListHistoryItem,
  type ListItem,
  type Session,
  type Stats,
  type Task,
  type Today,
} from './api.ts';
import { weekStartDay } from './dates.ts';
import { findTask } from './local.ts';
import { syncIdle } from './sync.ts';

/** Reads wait for changes still on their way, so a refresh never shows the server's copy from before them. */
export async function get<T>(path: string): Promise<T> {
  await syncIdle();
  return api<T>(path);
}

export function useSession() {
  return useQuery({ queryKey: ['session'], queryFn: () => get<Session>('/session'), staleTime: 60_000 });
}

export function useMe() {
  const { data } = useSession();
  return data?.member ?? null;
}

export function useGroups() {
  return useQuery({ queryKey: ['groups'], queryFn: () => get<{ groups: Group[] }>('/groups'), select: (d) => d.groups });
}

export function useArchivedGroups() {
  return useQuery({
    queryKey: ['groups', 'archived'],
    queryFn: () => get<{ groups: Group[] }>('/groups?archived=1'),
    select: (d) => d.groups,
  });
}

export function useMembers() {
  return useQuery({
    queryKey: ['members'],
    queryFn: () => get<{ members: HouseholdMember[]; pending: string[] }>('/members'),
    staleTime: 5 * 60_000,
  });
}

/** `who` is "me", "everyone", or a member id. */
export function useToday(who = 'me') {
  return useQuery({
    queryKey: ['today', who],
    queryFn: () => get<Today>(`/today?who=${encodeURIComponent(who)}`),
    placeholderData: keepPreviousData,
  });
}

export function useLoad(start: string, end: string, enabled = true, who = 'me') {
  return useQuery({
    queryKey: ['load', start, end, who],
    queryFn: () => get<{ days: DayLoad[] }>(`/load?start=${start}&end=${end}&who=${encodeURIComponent(who)}`),
    select: (d) => d.days,
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useTasks(params: Record<string, string> = {}, enabled = true) {
  const query = new URLSearchParams(params).toString();
  return useQuery({
    queryKey: ['tasks', params],
    queryFn: () => get<{ tasks: Task[] }>(`/tasks${query ? `?${query}` : ''}`),
    select: (d) => d.tasks,
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** One task. Any task already showing in a list opens straight away, offline too, from that copy. */
export function useTask(id: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['task', id],
    queryFn: () => get<{ task: Task }>(`/tasks/${id}`),
    select: (d) => d.task,
    initialData: () => {
      const task = findTask(qc, id);
      return task && { task };
    },
    initialDataUpdatedAt: 0,
  });
}

export function useTaskActivity(id: string) {
  return useQuery({
    queryKey: ['activity', 'task', id],
    queryFn: () => get<ActivityPage>(`/tasks/${id}/activity`),
    select: (d) => d.entries,
  });
}

export function useActivity() {
  return useInfiniteQuery({
    queryKey: ['activity', 'feed'],
    queryFn: ({ pageParam }) => get<ActivityPage>(`/activity?limit=40${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

export function useStats() {
  return useQuery({ queryKey: ['stats'], queryFn: () => get<Stats>(`/stats?weeks=12&weekStart=${weekStartDay()}`) });
}

export function useList(groupId: string) {
  return useQuery({
    queryKey: ['list', groupId],
    queryFn: () => get<{ group: Group; open: ListItem[]; checked: ListItem[] }>(`/lists/${groupId}`),
  });
}

export function useListHistory(groupId: string | null) {
  return useQuery({
    queryKey: ['list', groupId, 'history'],
    queryFn: () => get<{ items: ListHistoryItem[] }>(`/lists/${groupId}/history`),
    select: (d) => d.items,
    enabled: !!groupId,
    staleTime: 60_000,
  });
}

export function useAi() {
  return useQuery({ queryKey: ['ai'], queryFn: () => get<AiStatus>('/ai'), staleTime: 60_000 });
}

export function useCapacity() {
  return useQuery({ queryKey: ['capacity'], queryFn: () => get<{ days: CapacityDay[] }>('/capacity'), select: (d) => d.days });
}
