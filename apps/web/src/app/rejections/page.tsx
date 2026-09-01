import { rejectionSample } from '@/lib/data';

export const dynamic = 'force-dynamic';

/**
 * Why listings were dropped.
 *
 * Rejections are stored rather than deleted specifically so an over-aggressive
 * filter can be diagnosed, and until this page existed nothing ever read them.
 * If the pipeline goes quiet, this is the page that says whether it went quiet
 * because there are no jobs or because a keyword edit started excluding them.
 */
export default async function RejectionsPage() {
  const sample = await rejectionSample();
  const worst = sample.reasons[0]?.count ?? 1;

  return (
    <>
      <h1>Rejections</h1>
      <p className="sub">
        {sample.totalRejected} listings were dropped by the pre-filter and kept for diagnosis.
      </p>

      {/* Only warn when the tally really is a sample. PostgREST caps a response
          at 1000 rows, so past that the breakdown stops describing everything —
          but saying "the most recent 834, not all 834" is just noise. */}
      {sample.sampleSize < sample.totalRejected && (
        <div className="note">
          The breakdown below covers the most recent {sample.sampleSize} of {sample.totalRejected}{' '}
          rejections — PostgREST will not return more than 1000 rows in one response. The total is
          exact; the proportions are a sample.
        </div>
      )}

      <h2>Why they were dropped</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Reason</th>
              <th className="num">Count</th>
              <th style={{ width: '40%' }}>Share of sample</th>
            </tr>
          </thead>
          <tbody>
            {sample.reasons.map((row) => (
              <tr key={row.reason}>
                <td>{row.reason}</td>
                <td className="num">{row.count}</td>
                <td>
                  <div className="bar">
                    <span style={{ width: `${Math.round((row.count / worst) * 100)}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Most recent</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Listing</th>
              <th>Where</th>
              <th>Reasons</th>
            </tr>
          </thead>
          <tbody>
            {sample.recent.map((row, index) => (
              <tr key={`${row.url}-${index}`}>
                <td>
                  <a href={row.url} target="_blank" rel="noopener noreferrer">
                    {row.title}
                  </a>
                  {row.company && <div className="meta">{row.company}</div>}
                </td>
                <td className="meta">
                  {[
                    row.locationSuburb,
                    row.distanceKm !== null ? `${Math.round(row.distanceKm)} km` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </td>
                <td className="meta">{row.reasons.join(' | ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
