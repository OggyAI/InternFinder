import Link from 'next/link';
import { collectPipelineStats } from '@intern-finder/core';
import { MatchCard } from '@/components/MatchCard';
import { listMatches, loadSourceStatus } from '@/lib/data';
import { setPaused } from './actions';

export const dynamic = 'force-dynamic';

function Stat({ k, v, n }: { k: string; v: string | number; n?: string }) {
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {n && <div className="n">{n}</div>}
    </div>
  );
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function OverviewPage() {
  const [stats, top, sources] = await Promise.all([
    collectPipelineStats(),
    listMatches({ status: 'undecided', perPage: 8 }),
    loadSourceStatus(),
  ]);

  const decided =
    (stats.byStatus.applied ?? 0) + (stats.byStatus.saved ?? 0) + (stats.byStatus.dismissed ?? 0);

  return (
    <>
      <h1>Overview</h1>
      <div className="sub" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {stats.paused ? (
          <span className="pill paused">paused — not polling, scoring or notifying</span>
        ) : (
          <span>Polling, scoring and notifying normally.</span>
        )}
        <form action={setPaused} className="inline">
          <input type="hidden" name="paused" value={stats.paused ? 'false' : 'true'} />
          <button type="submit">{stats.paused ? 'Resume' : 'Pause'}</button>
        </form>
      </div>

      <div className="grid">
        <Stat k="Listings" v={stats.listingsTotal} n={`${stats.listingsPassed} passed the filter`} />
        <Stat k="Scored" v={stats.scored} n={`${stats.awaitingScore} awaiting`} />
        <Stat k={`At or above ${stats.threshold}`} v={stats.aboveThreshold} n="notify threshold" />
        <Stat k="Decided" v={decided} n={`${stats.byStatus.new ?? 0} still new`} />
        <Stat
          k="Spend today"
          v={`$${stats.spentToday.toFixed(2)}`}
          n={`cap $${stats.spendCapPerDay.toFixed(2)}`}
        />
        <Stat
          k="Notified today"
          v={stats.notifiedToday}
          n={`cap ${stats.notifyCapPerDay}`}
        />
      </div>

      {stats.duplicates > 0 && (
        <div className="note">
          {stats.duplicates} listings are marked as near-duplicates of another and are hidden
          from every list here. They keep their row and their score — nothing is deleted — so an
          over-eager rule stays diagnosable.
        </div>
      )}

      <h2>Sources</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>State</th>
              <th className="num">Calls today</th>
              <th>Every</th>
              <th>Last poll</th>
              <th>Health</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.name}>
                <td>{source.name}</td>
                <td>{source.enabled ? 'enabled' : 'disabled'}</td>
                <td className="num">
                  {source.callsToday} / {source.maxCallsPerDay}
                </td>
                <td>
                  {source.pollIntervalMinutes >= 60
                    ? `${Math.round(source.pollIntervalMinutes / 60)}h`
                    : `${source.pollIntervalMinutes}m`}
                </td>
                <td>{ago(source.lastPolledAt)}</td>
                <td>
                  {source.consecutiveFailures === 0 ? (
                    <span style={{ color: 'var(--good)' }}>ok</span>
                  ) : (
                    <span style={{ color: 'var(--bad)' }} title={source.lastError ?? undefined}>
                      {source.consecutiveFailures} consecutive failures
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Best undecided</h2>
      {top.items.length === 0 ? (
        <p className="empty">Nothing undecided. Everything scored has been actioned.</p>
      ) : (
        <>
          {top.items.map((match) => (
            <MatchCard key={match.id} match={match} />
          ))}
          <p>
            <Link href="/matches">All {top.total} undecided matches →</Link>
          </p>
        </>
      )}
    </>
  );
}
