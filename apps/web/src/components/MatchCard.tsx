import { scoreExplanation, formatPostedDate, label } from '@intern-finder/core';
import { setMatchStatus } from '@/app/actions';
import type { MatchListItem } from '@/lib/data';

/**
 * One scored match.
 *
 * The score breakdown comes from core's `scoreExplanation`, the same function
 * the Telegram card uses, so a listing cannot read 100 here and "= 105, capped
 * at 100" on the phone. Duplicating that arithmetic in two places is exactly
 * how the two surfaces would start disagreeing.
 */

const DECISIONS = [
  { status: 'applied', text: 'Applied' },
  { status: 'saved', text: 'Save' },
  { status: 'dismissed', text: 'Dismiss' },
] as const;

function facts(match: MatchListItem): string {
  const parts = [match.category, match.compensation, match.workMode, match.commitment]
    .filter((value) => value && value !== 'unknown')
    .map(label);
  if (match.durationWeeks !== null) parts.push(`~${match.durationWeeks} weeks`);
  return parts.join(' · ');
}

function scoreColour(score: number): string {
  if (score >= 85) return 'var(--good)';
  if (score >= 70) return 'var(--accent)';
  if (score >= 50) return 'var(--muted)';
  return 'var(--muted)';
}

export function MatchCard({ match }: { match: MatchListItem }) {
  const place = [
    match.locationSuburb,
    match.distanceKm !== null ? `${Math.round(match.distanceKm)} km` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const explanation = scoreExplanation({
    matchId: match.id,
    fitScore: match.fitScore,
    baseScore: match.baseScore,
    preferenceMultiplier: match.preferenceMultiplier,
    category: match.category,
    compensation: match.compensation,
    workMode: match.workMode,
    commitment: match.commitment,
    durationWeeks: match.durationWeeks,
    reasoning: match.reasoning,
    title: match.title,
    company: match.company,
    locationSuburb: match.locationSuburb,
    distanceKm: match.distanceKm,
    url: match.url,
    postedDate: match.postedDate,
  });

  return (
    <article className="match">
      <div className="head">
        <span className="score" style={{ color: scoreColour(match.fitScore) }}>
          {match.fitScore}
        </span>
        <span className="title">
          <a href={match.url} target="_blank" rel="noopener noreferrer">
            {match.title}
          </a>
        </span>
        {match.status !== 'new' && (
          <span className={`pill ${match.status}`}>{match.status}</span>
        )}
      </div>

      <div className="meta">
        {[match.company, place, match.source].filter(Boolean).join(' · ')}
        {match.postedDate ? ` · posted ${formatPostedDate(match.postedDate)}` : ''}
      </div>

      {facts(match) && <div className="meta">{facts(match)}</div>}

      <p className="reason">{match.reasoning}</p>

      <div className="calc">{explanation}</div>

      <div className="actions">
        {DECISIONS.map((decision) => (
          <form key={decision.status} action={setMatchStatus} className="inline">
            <input type="hidden" name="matchId" value={match.id} />
            <input type="hidden" name="status" value={decision.status} />
            <button
              type="submit"
              className={match.status === decision.status ? 'on' : undefined}
            >
              {decision.text}
            </button>
          </form>
        ))}
        {match.status !== 'new' && match.status !== 'notified' && (
          <form action={setMatchStatus} className="inline">
            <input type="hidden" name="matchId" value={match.id} />
            <input type="hidden" name="status" value="new" />
            <button type="submit" title="Put it back in the undecided pile">
              Undo
            </button>
          </form>
        )}
      </div>
    </article>
  );
}
