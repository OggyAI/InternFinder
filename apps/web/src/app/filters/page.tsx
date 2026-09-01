import { loadFilters } from '@/lib/data';
import { addKeyword, setKeywordActive, setPreferenceWeight, updateFilter } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * The search criteria, editable in place.
 *
 * These are database rows read fresh on every poll, so anything changed here
 * takes effect on the next cycle with no redeploy and no restart. That is a
 * hard constraint of the project rather than a convenience — if a change here
 * needed a deploy, the design would be wrong.
 */
export default async function FiltersPage() {
  const { filter, keywords, preferences } = await loadFilters();

  const include = keywords.filter((k) => k.kind === 'include');
  const exclude = keywords.filter((k) => k.kind !== 'include');

  return (
    <>
      <h1>Filters</h1>
      <p className="sub">
        {filter.name} — read fresh on every poll, so edits apply next cycle without a restart.
      </p>

      <h2>Search area</h2>
      <form action={updateFilter} className="actions">
        <input type="hidden" name="filterId" value={filter.id} />
        <label>
          Radius km around {filter.center_label}
          <br />
          <input type="number" name="radius_km" min={1} max={500} defaultValue={filter.radius_km} />
        </label>
        <label>
          Min duration (weeks)
          <br />
          <input
            type="number"
            name="min_duration_weeks"
            min={0}
            max={104}
            defaultValue={filter.min_duration_weeks}
          />
        </label>
        <label>
          Max listing age (days)
          <br />
          <input
            type="number"
            name="max_listing_age_days"
            min={1}
            max={365}
            defaultValue={filter.max_listing_age_days}
          />
        </label>
        <button type="submit">Save</button>
      </form>

      <div className="note">
        The radius is measured from {filter.center_label}, not from &ldquo;Melbourne&rdquo;. Which
        suburbs it reaches depends entirely on that centre point — from the CBD, 50 km covers
        Lilydale but not Geelong; from the west it inverts.
      </div>

      <h2>Preference weights</h2>
      <p className="sub">
        These rank, they never exclude. A paid, full-time, remote role still appears and can still
        win on an exceptional resume match — the combined multiplier is clamped to [0.75, 1.35]
        precisely so weighting cannot silently bury a category.
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Axis</th>
              <th>Value</th>
              <th className="num">Weight</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {preferences.map((preference) => (
              <tr key={preference.id}>
                <td>{preference.dimension}</td>
                <td>{preference.value}</td>
                <td className="num">{Number(preference.weight).toFixed(2)}</td>
                <td>
                  <form action={setPreferenceWeight} className="actions">
                    <input type="hidden" name="preferenceId" value={preference.id} />
                    <input
                      type="number"
                      name="weight"
                      step="0.05"
                      min={0.5}
                      max={2}
                      defaultValue={Number(preference.weight).toFixed(2)}
                      style={{ width: 90 }}
                      aria-label={`Weight for ${preference.dimension} ${preference.value}`}
                    />
                    <button type="submit">Set</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Add a keyword</h2>
      <form action={addKeyword} className="actions" style={{ alignItems: 'flex-end' }}>
        <input type="hidden" name="filterId" value={filter.id} />
        <label>
          Term
          <br />
          <input type="text" name="term" required maxLength={80} placeholder="e.g. Cloud Security" />
        </label>
        <label>
          Kind
          <br />
          <select name="kind" defaultValue="include">
            <option value="include">include</option>
            <option value="exclude">exclude (anywhere)</option>
            <option value="exclude_title">exclude (title only)</option>
          </select>
        </label>
        <label>
          Category
          <br />
          <select name="category" defaultValue="domain">
            <option value="domain">domain</option>
            <option value="structural">structural</option>
          </select>
        </label>
        <label>
          <input type="checkbox" name="whole_word" defaultChecked /> whole word
        </label>
        <label>
          <input type="checkbox" name="case_sensitive" /> case sensitive
        </label>
        <button type="submit">Add</button>
      </form>
      <div className="note">
        Short acronyms need both boxes. Without a word boundary, <code>IT</code> matches
        &ldquo;security&rdquo;, &ldquo;monitor&rdquo; and &ldquo;editing&rdquo;; with a boundary but
        case-insensitive it matches the pronoun &ldquo;it&rdquo;, which is in every job ad ever
        written and once returned a cocktail bartender.
      </div>

      <h2>Include ({include.filter((k) => k.is_active).length} active)</h2>
      <KeywordTable rows={include} />

      <h2>Exclude ({exclude.filter((k) => k.is_active).length} active)</h2>
      <KeywordTable rows={exclude} />
    </>
  );
}

function KeywordTable({
  rows,
}: {
  rows: {
    id: string;
    term: string;
    kind: string;
    category: string;
    match_scope: string;
    whole_word: boolean;
    case_sensitive: boolean;
    is_active: boolean;
  }[];
}) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Term</th>
            <th>Kind</th>
            <th>Category</th>
            <th>Scope</th>
            <th>Guards</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={row.is_active ? undefined : { opacity: 0.45 }}>
              <td>{row.term}</td>
              <td className="meta">{row.kind}</td>
              <td className="meta">{row.category}</td>
              <td className="meta">{row.match_scope}</td>
              <td className="meta">
                {[row.whole_word ? 'whole word' : null, row.case_sensitive ? 'case' : null]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </td>
              <td>
                <form action={setKeywordActive} className="inline">
                  <input type="hidden" name="keywordId" value={row.id} />
                  <input type="hidden" name="active" value={row.is_active ? 'false' : 'true'} />
                  <button type="submit">{row.is_active ? 'Disable' : 'Enable'}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
