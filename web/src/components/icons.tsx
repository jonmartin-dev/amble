import type { ComponentType, SVGProps } from 'react';
import Call from '~icons/material-symbols/call-outline-rounded';
import Checklist from '~icons/material-symbols/checklist-rounded';
import Car from '~icons/material-symbols/directions-car-outline-rounded';
import Folder from '~icons/material-symbols/folder-outline-rounded';
import Home from '~icons/material-symbols/home-outline-rounded';
import Luggage from '~icons/material-symbols/luggage-outline-rounded';
import Palette from '~icons/material-symbols/palette-outline-rounded';
import Rocket from '~icons/material-symbols/rocket-launch-outline-rounded';
import Bag from '~icons/material-symbols/shopping-bag-outline-rounded';
import Cart from '~icons/material-symbols/shopping-cart-outline-rounded';
import Dinner from '~icons/material-symbols/dinner-dining-outline-rounded';
import Hardware from '~icons/material-symbols/hardware-outline-rounded';
import Place from '~icons/material-symbols/location-on-outline-rounded';
import MapIcon from '~icons/material-symbols/map-outline-rounded';
import Movie from '~icons/material-symbols/movie-outline-rounded';
import Gift from '~icons/material-symbols/redeem-rounded';
import Repeat from '~icons/material-symbols/repeat-rounded';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const groupIcons: Record<string, Icon> = {
  home: Home,
  'directions-car': Car,
  'shopping-cart': Cart,
  call: Call,
  'rocket-launch': Rocket,
  palette: Palette,
  folder: Folder,
  checklist: Checklist,
  'shopping-bag': Bag,
  luggage: Luggage,
  redeem: Gift,
  'location-on': Place,
  'dinner-dining': Dinner,
  hardware: Hardware,
  movie: Movie,
  map: MapIcon,
  repeat: Repeat,
};

/** Every icon a group or list can have, in the order the pickers show them. */
export const GROUP_ICON_NAMES = Object.keys(groupIcons);

export function GroupIcon({ name, className }: { name: string; className?: string }) {
  const Component = groupIcons[name] ?? Folder;
  return <Component className={className} aria-hidden />;
}

/** Tonal container pairs for group and member colors. The theme engine harmonizes each hue toward the seed. */
export const tones: Record<string, string> = {
  green: 'bg-(--tone-green) text-(--tone-green-on)',
  teal: 'bg-(--tone-teal) text-(--tone-teal-on)',
  lime: 'bg-(--tone-lime) text-(--tone-lime-on)',
  blue: 'bg-(--tone-blue) text-(--tone-blue-on)',
  violet: 'bg-(--tone-violet) text-(--tone-violet-on)',
  orange: 'bg-(--tone-orange) text-(--tone-orange-on)',
  rose: 'bg-(--tone-rose) text-(--tone-rose-on)',
};

export const tone = (color: string) => tones[color] ?? tones.green!;
