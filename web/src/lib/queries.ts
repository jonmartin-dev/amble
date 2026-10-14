import { useQuery } from '@tanstack/react-query';
import { api, type Group, type Session } from './api.ts';

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
