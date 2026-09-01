import Link from 'next/link';
import { MatchCard } from '@/components/MatchCard';
import { listMatches } from '@/lib/data';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'undecided', label: 'Undecided' },
  { key: 'saved', label: 'Saved' },
  { key: 'applied', label: 'Applied' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'all', label: 'All' },
];

interface SearchParams {
  status?: string;
  min?: string;
  q?: string;
  page?: string;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

export default async function MatchesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const status = params.status ?? 'undecided';
  const minScore = params.min ? Number(params.min) : undefined;
  const search = params.q?.trim() || undefined;
  const page = Number(params.page ?? '1') || 1;

  const result = await listMatches({
    status,
    minScore: Number.isFinite(minScore) ? minScore : undefined,
    search,
    page,
    perPage: 25,
  });

  const pageCount = Math.max(1, Math.ceil(result.total / result.perPage));

  return (
    <>
      <h1>Matches</h1>
      <p className="sub">
        {result.total} {status === 'all' ? 'scored' : status} · near-duplicates hidden
      </p>

      <div className="actions" style={{ marginBottom: 14 }}>
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={`/matches${queryString({ status: tab.key, min: params.min, q: search })}`}
            className="btn"
            style={
              tab.key === status
                ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                : undefined
            }
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {/* GET, so the filters live in the URL and a view is linkable and
          refreshable. A Server Action would POST and lose that. */}
      <form method="get" action="/matches" className="actions" style={{ marginBottom: 18 }}>
        <input type="hidden" name="status" value={status} />
        <input
          type="text"
          name="q"
          placeholder="title or company"
          defaultValue={search ?? ''}
          aria-label="Search title or company"
        />
        <input
          type="number"
          name="min"
          placeholder="min score"
          min={0}
          max={100}
          defaultValue={params.min ?? ''}
          aria-label="Minimum fit score"
          style={{ width: 110 }}
        />
        <button type="submit">Filter</button>
        {(search || params.min) && (
          <Link className="btn" href={`/matches${queryString({ status })}`}>
            Clear
          </Link>
        )}
      </form>

      {result.items.length === 0 ? (
        <p className="empty">Nothing here.</p>
      ) : (
        result.items.map((match) => <MatchCard key={match.id} match={match} />)
      )}

      {pageCount > 1 && (
        <div className="actions" style={{ justifyContent: 'center', marginTop: 18 }}>
          {page > 1 && (
            <Link
              className="btn"
              href={`/matches${queryString({ status, min: params.min, q: search, page: page - 1 })}`}
            >
              ← Previous
            </Link>
          )}
          <span style={{ color: 'var(--muted)', fontSize: 13, alignSelf: 'center' }}>
            Page {page} of {pageCount}
          </span>
          {page < pageCount && (
            <Link
              className="btn"
              href={`/matches${queryString({ status, min: params.min, q: search, page: page + 1 })}`}
            >
              Next →
            </Link>
          )}
        </div>
      )}
    </>
  );
}
