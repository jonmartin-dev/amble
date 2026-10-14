import { expect, it } from 'vitest';
import { GROUP_ICONS } from '../../../server/domain/household.ts';
import { GROUP_ICON_NAMES } from './icons.tsx';

it('draws every icon the server lets a group have', () => {
  expect([...GROUP_ICON_NAMES].sort()).toEqual([...GROUP_ICONS].sort());
});
