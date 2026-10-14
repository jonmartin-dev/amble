import { motion } from 'motion/react';
import ErrorIcon from '~icons/material-symbols/error-outline-rounded';
import { appUrl } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';
import { useSession } from '../lib/queries.ts';

const errors: Record<string, string> = {
  'not-allowed': "That account isn't on this household's list. Ask whoever runs Almanac to add it.",
  expired: 'That sign-in took too long. Try again.',
  failed: "Sign-in didn't go through. Try again.",
};

export function SignIn() {
  const { data } = useSession();
  const error = new URLSearchParams(window.location.search).get('error');
  const auth = data?.auth;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <motion.img
        src={appUrl('/icon.svg')}
        alt=""
        initial={{ scale: 0.6, rotate: -12, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={expressive.slowSpatial}
        className="size-24"
      />
      <h1 className="display mt-8 text-[3.5rem] leading-none font-medium">Almanac</h1>
      <p className="mt-3 text-lg text-on-surface-variant">A calm planner for your household that knows how full your days are.</p>

      {error && errors[error] && (
        <div role="alert" className="mt-8 flex gap-3 rounded-3xl bg-warm-container p-4 text-on-warm-container">
          <ErrorIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>{errors[error]}</p>
        </div>
      )}

      <div className="mt-10 flex flex-col gap-3">
        {auth?.oidc && (
          <a
            href={appUrl('/auth/login')}
            className="rounded-full bg-primary px-6 py-4 text-center text-lg font-medium text-on-primary transition-transform active:scale-[0.97]"
          >
            Continue with {auth.provider}
          </a>
        )}
        {auth?.devEmails.map((email) => (
          <a
            key={email}
            href={appUrl(`/auth/dev?email=${encodeURIComponent(email)}`)}
            className="rounded-full bg-surface-high px-6 py-4 text-center transition-transform active:scale-[0.97]"
          >
            Dev sign-in as {email}
          </a>
        ))}
        {auth && !auth.oidc && auth.devEmails.length === 0 && (
          <p className="text-on-surface-variant">Sign-in isn't set up yet. The admin needs to add OIDC settings.</p>
        )}
      </div>
    </main>
  );
}
