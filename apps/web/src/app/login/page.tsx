import { authConfig } from '@/lib/auth';
import { login } from './actions';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const configured = authConfig() !== null;

  return (
    <div className="login">
      <h1>intern finder</h1>
      <p className="sub">Sign in to see the pipeline.</p>

      {!configured && (
        <div className="note">
          <strong>DASHBOARD_PASSWORD is not set.</strong> Until it is, every page
          refuses to load — an unconfigured deployment stays shut rather than
          serving the database to whoever finds the URL.
        </div>
      )}

      <form action={login}>
        <input type="hidden" name="next" value={params.next ?? '/'} />
        <p>
          <label htmlFor="password">Password</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            style={{ width: '100%', marginTop: 4 }}
          />
        </p>
        {params.error && (
          <p style={{ color: 'var(--bad)', fontSize: 14 }}>That password is not right.</p>
        )}
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
