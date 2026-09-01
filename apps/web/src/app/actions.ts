'use server';

import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@intern-finder/core';
import { z } from 'zod';

/**
 * Every write the dashboard can make.
 *
 * Server Actions, so the mutation runs on the server and the browser never
 * holds a database credential. They POST to the page they live on, which means
 * middleware.ts gates them exactly like a page request — there is no separate
 * API surface to forget to protect.
 *
 * Each input is parsed with zod before it reaches the database. A Server
 * Action is a public HTTP endpoint whatever it looks like in the source, so
 * "the form only sends valid values" is not a control.
 *
 * NOTHING HERE CONTACTS AN EMPLOYER. Marking a match "applied" records that
 * the human applied; it does not apply.
 */

const MatchStatus = z.enum(['new', 'notified', 'saved', 'applied', 'dismissed']);
const Uuid = z.string().uuid();

function db() {
  return getServiceClient();
}

export async function setMatchStatus(formData: FormData): Promise<void> {
  const matchId = Uuid.parse(formData.get('matchId'));
  const status = MatchStatus.parse(formData.get('status'));

  const { error } = await db().from('matches').update({ status }).eq('id', matchId);
  if (error) throw new Error(`could not update match: ${error.message}`);

  revalidatePath('/');
}

export async function setPaused(formData: FormData): Promise<void> {
  const paused = z.enum(['true', 'false']).parse(formData.get('paused')) === 'true';
  const { error } = await db().from('app_settings').update({ is_paused: paused }).eq('id', 1);
  if (error) throw new Error(`could not update pause state: ${error.message}`);
  revalidatePath('/', 'layout');
}

/**
 * Runtime-editable settings.
 *
 * These are database rows read fresh on every poll precisely so changing them
 * never needs a redeploy — that is a hard constraint of this project, not a
 * convenience. The bounds mirror the CHECK constraints in the schema so a bad
 * value is refused here with a readable message rather than as a Postgres
 * error.
 */
const SettingsPatch = z.object({
  notify_score_threshold: z.coerce.number().int().min(0).max(100).optional(),
  max_notifications_per_day: z.coerce.number().int().min(0).max(200).optional(),
  scoring_enabled: z
    .union([z.literal('on'), z.literal('off')])
    .transform((v) => v === 'on')
    .optional(),
  max_scoring_spend_usd_per_day: z.coerce.number().min(0).max(50).optional(),
  max_scoring_spend_usd_per_cycle: z.coerce.number().min(0).max(50).optional(),
});

export async function updateSettings(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(
    [...formData.entries()].filter(([, value]) => value !== '' && value !== null),
  );
  const patch = SettingsPatch.parse(raw);
  if (Object.keys(patch).length === 0) return;

  const { error } = await db().from('app_settings').update(patch).eq('id', 1);
  if (error) throw new Error(`could not update settings: ${error.message}`);
  revalidatePath('/settings');
  revalidatePath('/');
}

export async function updateFilter(formData: FormData): Promise<void> {
  const filterId = Uuid.parse(formData.get('filterId'));
  const patch = z
    .object({
      radius_km: z.coerce.number().int().min(1).max(500).optional(),
      min_duration_weeks: z.coerce.number().int().min(0).max(104).optional(),
      max_listing_age_days: z.coerce.number().int().min(1).max(365).optional(),
    })
    .parse(
      Object.fromEntries(
        [...formData.entries()].filter(
          ([key, value]) => key !== 'filterId' && value !== '' && value !== null,
        ),
      ),
    );
  if (Object.keys(patch).length === 0) return;

  const { error } = await db().from('filters').update(patch).eq('id', filterId);
  if (error) throw new Error(`could not update filter: ${error.message}`);
  revalidatePath('/filters');
}

export async function setKeywordActive(formData: FormData): Promise<void> {
  const id = Uuid.parse(formData.get('keywordId'));
  const active = z.enum(['true', 'false']).parse(formData.get('active')) === 'true';
  const { error } = await db().from('filter_keywords').update({ is_active: active }).eq('id', id);
  if (error) throw new Error(`could not update keyword: ${error.message}`);
  revalidatePath('/filters');
}

/**
 * Add a keyword.
 *
 * `whole_word` and `case_sensitive` are exposed rather than defaulted because
 * they are what makes a short term usable: without a word boundary, `IT`
 * matches "security" and "monitor"; with a boundary but case-insensitive it
 * matches the pronoun "it", which appears in every job ad ever written and
 * once made the pipeline return a cocktail bartender.
 */
export async function addKeyword(formData: FormData): Promise<void> {
  const input = z
    .object({
      filterId: Uuid,
      term: z.string().trim().min(1).max(80),
      kind: z.enum(['include', 'exclude', 'exclude_title']),
      category: z.enum(['domain', 'structural']).default('domain'),
      match_scope: z.enum(['text', 'title']).default('text'),
      whole_word: z.union([z.literal('on'), z.null()]).transform((v) => v === 'on'),
      case_sensitive: z.union([z.literal('on'), z.null()]).transform((v) => v === 'on'),
    })
    .parse({
      filterId: formData.get('filterId'),
      term: formData.get('term'),
      kind: formData.get('kind'),
      category: formData.get('category') ?? 'domain',
      match_scope: formData.get('match_scope') ?? 'text',
      whole_word: formData.get('whole_word'),
      case_sensitive: formData.get('case_sensitive'),
    });

  const { error } = await db().from('filter_keywords').insert({
    filter_id: input.filterId,
    term: input.term,
    kind: input.kind,
    category: input.category,
    match_scope: input.match_scope,
    whole_word: input.whole_word,
    case_sensitive: input.case_sensitive,
    weight: 1,
    is_active: true,
  });
  if (error) throw new Error(`could not add keyword: ${error.message}`);
  revalidatePath('/filters');
}

/**
 * Preference weights.
 *
 * Clamped to 0.5–2.0 here, but the ranking clamps the COMBINED multiplier to
 * [0.75, 1.35] anyway — preference weighting ranks, it never excludes, and a
 * paid full-time remote role must still be able to win on an exceptional
 * resume match. Editing these changes emphasis, not eligibility.
 */
export async function setPreferenceWeight(formData: FormData): Promise<void> {
  const id = Uuid.parse(formData.get('preferenceId'));
  const weight = z.coerce.number().min(0.5).max(2).parse(formData.get('weight'));
  const { error } = await db().from('filter_preferences').update({ weight }).eq('id', id);
  if (error) throw new Error(`could not update preference: ${error.message}`);
  revalidatePath('/filters');
}

export async function setSourceEnabled(formData: FormData): Promise<void> {
  const name = z.enum(['adzuna', 'jooble', 'careers_page']).parse(formData.get('name'));
  const enabled = z.enum(['true', 'false']).parse(formData.get('enabled')) === 'true';
  const { error } = await db().from('sources').update({ enabled }).eq('name', name);
  if (error) throw new Error(`could not update source: ${error.message}`);
  revalidatePath('/settings');
}
