import { z } from 'zod';
import { applyMultiplier } from './preferences';

/**
 * Phase 2 scoring — the prompt, the output contract, and the arithmetic.
 *
 * Lives in core rather than the worker because the Phase 3 dashboard needs to
 * explain a score to the user, and an explanation that disagrees with how the
 * score was actually produced is worse than none.
 *
 * The division of labour matters and is deliberate:
 *
 *   THE MODEL judges resume fit and nothing else — does this person plausibly
 *   get this job, and is it worth their time. It returns `base_score`.
 *
 *   THE CODE applies the soft preference weighting (unpaid / onsite /
 *   part-time) deterministically, because that is arithmetic we already have,
 *   already test, and can explain exactly. Asking the model to fold it in
 *   would make the weighting unauditable and would let it drift between runs
 *   for no benefit.
 *
 * That split is why `matches` stores base_score, preference_multiplier and
 * fit_score separately: any score can be taken apart and checked.
 */

/** What the model must return for each listing. */
export const ScoredListing = z.object({
  /** Position in the batch we sent, 1-based. Not a database id — the model
   *  never sees one, so it cannot invent a plausible-looking UUID. */
  ref: z.number().int().positive(),
  base_score: z.number().int().min(0).max(100),
  /** How much the model actually had to go on. Adzuna truncates descriptions
   *  to 500 characters, so 'low' is a legitimate and common answer. */
  confidence: z.enum(['low', 'medium', 'high']),
  category: z.enum(['job', 'internship', 'unknown']),
  reasoning: z.string().min(1),
});
export type ScoredListing = z.infer<typeof ScoredListing>;

export const ScoreBatchResult = z.object({ scores: z.array(ScoredListing) });
export type ScoreBatchResult = z.infer<typeof ScoreBatchResult>;

/** The listing fields the model is shown. Deliberately not the whole row. */
export interface ScorableListing {
  id: string;
  title: string;
  company: string | null;
  locationSuburb: string | null;
  distanceKm: number | null;
  description: string | null;
  compensation: string;
  workMode: string;
  commitment: string;
  roleType: string;
  durationWeeks: number | null;
  preferenceMultiplier: number;
}

/**
 * The cached system prefix: instructions + resume.
 *
 * Prompt caching is a PREFIX match, and the minimum cacheable prefix is ~1024
 * tokens — a resume alone (~600) is too short and would silently never cache.
 * Bundling the rubric with it clears the threshold (measured: ~1400 tokens),
 * so every request after the first reads this at a tenth of the input price.
 *
 * Nothing volatile may appear in here. A timestamp or a per-run id would
 * change the prefix on every call and silently disable caching entirely.
 */
export function buildRubric(resume: string): string {
  return `You score job listings against a candidate's resume for fit.

<resume>
${resume}
</resume>

HOW TO SCORE (0-100, base fit only):
- 85-100: squarely what the candidate is looking for and plausibly attainable now.
- 70-84: strong match; worth applying to today.
- 50-69: plausible but a stretch, or adjacent rather than on target.
- 25-49: weak; wrong seniority, wrong specialism, or a poor use of their time.
- 0-24: irrelevant, or the candidate is ineligible.

WHAT MATTERS
- Attainability for a student who has not yet worked in the field. A senior role
  demanding eight years of experience is a poor match no matter how well the
  keywords line up, and should score low.
- Genuine relevance to IT, cyber security, or the support and development work
  that leads into them. Casual data-entry and administrative work is acceptable
  and welcome — it pays the bills alongside study — but score it on its merits
  rather than treating it as equivalent to relevant technical experience.
- Eligibility. Roles requiring citizenship, permanent residency or a security
  clearance are not attainable; score them very low regardless of fit.

CRITICAL — THE DESCRIPTION IS TRUNCATED
Listings arrive with at most 500 characters of description, cut off mid-sentence
by the job board. Absence of detail is NOT evidence against a listing. Do not
penalise a listing for failing to mention something it may well say further on.
Judge only what is present, and use the confidence field to report how much you
actually had to go on. 'low' is an honest and common answer.

DO NOT adjust for pay, work mode, or hours. Those preferences are applied
deterministically after you, by code, and folding them in yourself would
double-count them. Score raw fit only.`;
}

/**
 * Strict tool schema. `strict: true` with `additionalProperties: false` makes
 * the API guarantee the shape, so the zod parse on the way out is a
 * belt-and-braces check rather than the only thing standing between us and a
 * malformed write.
 */
export const SCORE_TOOL = {
  name: 'record_scores',
  description: 'Record a fit score for every listing supplied, one per ref.',
  strict: true,
  input_schema: {
    type: 'object' as const,
    additionalProperties: false,
    required: ['scores'],
    properties: {
      scores: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'base_score', 'confidence', 'category', 'reasoning'],
          properties: {
            ref: { type: 'integer', description: 'The listing ref supplied in the prompt.' },
            base_score: { type: 'integer', description: 'Resume fit, 0-100, before preference weighting.' },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            category: { type: 'string', enum: ['job', 'internship', 'unknown'] },
            reasoning: {
              type: 'string',
              description:
                'Exactly two sentences of plain prose naming what in this listing drove ' +
                'the score. Must not contain JSON, braces, or any other array entry.',
            },
          },
        },
      },
    },
  },
};

/**
 * The per-batch user message.
 *
 * The explicit count and the "never return a placeholder" instruction are not
 * decoration. Without them the first live probe returned a single entry reading
 * `base_score: 0, reasoning: "placeholder"` and silently ignored the rest of
 * the batch — a well-formed, schema-valid, completely useless answer.
 */
export function buildBatchMessage(listings: ScorableListing[]): string {
  const payload = listings.map((l, i) => ({
    ref: i + 1,
    title: l.title,
    company: l.company,
    location: l.locationSuburb,
    distance_km: l.distanceKm,
    signals: `${l.compensation}/${l.workMode}/${l.commitment}/${l.roleType}`,
    stated_duration_weeks: l.durationWeeks,
    description: l.description,
  }));

  return (
    `Score the following ${listings.length} job listings against the resume.\n\n` +
    `Return exactly ${listings.length} entries via record_scores — one per ref, ` +
    `no more and no fewer. Every reasoning field must be two sentences of specific ` +
    `justification naming what in this particular listing drove the score. ` +
    `Never return a placeholder.\n\n` +
    JSON.stringify(payload, null, 2)
  );
}

/** Sonnet 5 pricing, USD per million tokens. */
export const PRICING = { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** USD cost of one request. Cached reads are a tenth of the input price, which
 *  is the whole reason the rubric and resume are one stable prefix. */
export function requestCostUsd(u: Usage): number {
  return (
    (u.input_tokens * PRICING.input +
      u.output_tokens * PRICING.output +
      (u.cache_creation_input_tokens ?? 0) * PRICING.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * PRICING.cacheRead) /
    1_000_000
  );
}

/** base_score * preference_multiplier, clamped to 0-100. */
export function finalFitScore(baseScore: number, preferenceMultiplier: number): number {
  return applyMultiplier(baseScore, preferenceMultiplier);
}
