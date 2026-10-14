import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type DayLoad, type Group, type HouseholdMember, type ListItem, type Session, type Task, type Today } from './api.ts';

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

export function useLoad(start: string, end: string, enabled = true) {
  return useQuery({
    queryKey: ['load', start, end],
    queryFn: () => api<{ days: DayLoad[] }>(`/load?start=${start}&end=${end}`),
    select: (d) => d.days,
    enabled,
  });
}

export function useTasks(params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return useQuery({
    queryKey: ['tasks', params],
    queryFn: () => api<{ tasks: Task[] }>(`/tasks${query ? `?${query}` : ''}`),
    select: (d) => d.tasks,
    placeholderData: keepPreviousData,
  });
}

export function useTask(id: string) {
  return useQuery({ queryKey: ['task', id], queryFn: () => api<{ task: Task }>(`/tasks/${id}`), select: (d) => d.task });
}

export function useList(groupId: string) {
  return useQuery({
    queryKey: ['list', groupId],
    queryFn: () => api<{ group: Group; open: ListItem[]; checked: ListItem[] }>(`/lists/${groupId}`),
  });
}
