import { loadSettings, loadSourceStatus } from '@/lib/data';
import { setSourceEnabled, updateSettings } from '../actions';
import { logout } from '../login/actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const [settings, sources] = await Promise.all([loadSettings(), loadSourceStatus()]);

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Every value here is a database row, applied on the next cycle.</p>

      <h2>Notifications and scoring</h2>
      <form action={updateSettings} className="actions" style={{ alignItems: 'flex-end' }}>
        <label>
          Notify at fit ≥
          <br />
          <input
            type="number"
            name="notify_score_threshold"
            min={0}
            max={100}
            defaultValue={settings.notify_score_threshold}
            style={{ width: 100 }}
          />
        </label>
        <label>
          Max notifications/day
          <br />
          <input
            type="number"
            name="max_notifications_per_day"
            min={0}
            max={200}
            defaultValue={settings.max_notifications_per_day}
            style={{ width: 100 }}
          />
        </label>
        <label>
          Scoring
          <br />
          <select name="scoring_enabled" defaultValue={settings.scoring_enabled ? 'on' : 'off'}>
            <option value="on">enabled</option>
            <option value="off">disabled</option>
          </select>
        </label>
        <label>
          Spend cap $/day
          <br />
          <input
            type="number"
            name="max_scoring_spend_usd_per_day"
            step="0.25"
            min={0}
            max={50}
            defaultValue={Number(settings.max_scoring_spend_usd_per_day).toFixed(2)}
            style={{ width: 100 }}
          />
        </label>
        <label>
          Spend cap $/cycle
          <br />
          <input
            type="number"
            name="max_scoring_spend_usd_per_cycle"
            step="0.25"
            min={0}
            max={50}
            defaultValue={Number(settings.max_scoring_spend_usd_per_cycle).toFixed(2)}
            style={{ width: 100 }}
          />
        </label>
        <button type="submit">Save</button>
      </form>

      <div className="note">
        Turning scoring off does not lose anything. The queue is derived from listings that have
        no match row, so it simply builds up and drains when scoring is turned back on. Spent so
        far today: ${Number(settings.scoring_spend_today).toFixed(4)}.
      </div>

      <h2>Sources</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Every</th>
              <th className="num">Calls today</th>
              <th>Last error</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.name} style={source.enabled ? undefined : { opacity: 0.5 }}>
                <td>{source.name}</td>
                <td className="meta">
                  {source.pollIntervalMinutes >= 60
                    ? `${Math.round(source.pollIntervalMinutes / 60)}h`
                    : `${source.pollIntervalMinutes}m`}
                </td>
                <td className="num">
                  {source.callsToday} / {source.maxCallsPerDay}
                </td>
                <td className="meta" style={{ maxWidth: 380 }}>
                  {source.lastError ? source.lastError.slice(0, 160) : '—'}
                </td>
                <td>
                  <form action={setSourceEnabled} className="inline">
                    <input type="hidden" name="name" value={source.name} />
                    <input type="hidden" name="enabled" value={source.enabled ? 'false' : 'true'} />
                    <button type="submit">{source.enabled ? 'Disable' : 'Enable'}</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Session</h2>
      <form action={logout}>
        <button type="submit">Sign out</button>
      </form>
    </>
  );
}
