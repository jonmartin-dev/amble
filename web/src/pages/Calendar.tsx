import { PageHeader } from '../components/PageHeader.tsx';
import { planningDate } from '../lib/dates.ts';

export function Calendar() {
  const start = planningDate();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });

  return (
    <>
      <PageHeader title="This week" eyebrow="Bar height is how full each day is" />
      <div className="flex h-44 items-end gap-2 rounded-[2rem] bg-surface-low p-4">
        {days.map((d, i) => (
          <div key={d.toISOString()} className="flex flex-1 flex-col items-center gap-2">
            <div className={`h-3 w-full rounded-xl ${i === 0 ? 'bg-primary' : 'bg-primary-container'}`} />
            <span className={`text-xs ${i === 0 ? 'font-medium text-primary' : 'text-on-surface-variant'}`}>
              {d.toLocaleDateString(undefined, { weekday: 'short' })}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-4 px-1 text-sm text-on-surface-variant">
        Load fills in as you plan tasks and once your Google Calendar is connected.
      </p>
    </>
  );
}
