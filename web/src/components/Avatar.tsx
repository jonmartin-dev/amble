import { useState } from 'react';
import type { Member } from '../lib/api.ts';
import { tone } from './icons.tsx';

export function Avatar({ member, size = 36 }: { member: Member; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: size * 0.42 };
  if (member.avatarUrl && !broken) {
    return (
      <img
        src={member.avatarUrl}
        alt=""
        style={style}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="rounded-full object-cover"
      />
    );
  }
  return (
    <span style={style} className={`grid place-items-center rounded-full font-medium ${tone(member.color)}`}>
      {member.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
