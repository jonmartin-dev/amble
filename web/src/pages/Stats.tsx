import { PageHeader } from '../components/PageHeader.tsx';

export function Stats() {
  return (
    <>
      <PageHeader title="Stats" />
      <div className="rounded-[2rem] bg-surface-low p-6">
        <p className="display text-xl font-medium">Your patterns live here</p>
        <p className="mt-2 text-on-surface-variant">
          Weekly totals, your busiest days, how good Almanac's estimates are getting, and a few records worth bragging about.
          They start filling in after a week of use.
        </p>
      </div>
    </>
  );
}
