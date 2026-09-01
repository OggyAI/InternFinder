import {
  collectPipelineStats,
  getEnv,
  getMe,
  getServiceClient,
  hasAdzunaCreds,
  hasJoobleCreds,
  notificationsSentToday,
} from '@intern-finder/core';

/**
 * `npm run doctor` — is this environment actually ready to run?
 *
 * Answers, in order, the questions that go wrong during setup:
 *   1. Are the credentials present and well-formed?
 *   2. Does the database answer?
 *   3. Has the schema been applied — every table, or only some?
 *   4. Did the seed land, and with the expected row counts?
 *
 * Written to be run before the first poll and again after deploying to the
 * VM. It only reads; it never writes and never calls a job board.
 */

const EXPECTED_TABLES = [
  'filters',
  'filter_keywords',
  'filter_preferences',
  'sources',
  'app_settings',
  'job_listings',
  'resume_versions',
  'matches',
  'notification_log',
] as const;

/** Row counts the seed migration should produce, for tables it populates. */
const EXPECTED_SEED: Partial<Record<(typeof EXPECTED_TABLES)[number], number>> = {
  filters: 1,
  sources: 3,
  app_settings: 1,
};

const tick = (ok: boolean) => (ok ? 'OK  ' : 'FAIL');

async function main(): Promise<void> {
  let problems = 0;

  // --- 1. Credentials ------------------------------------------------------
  console.log('\nCredentials');
  const env = getEnv();
  console.log(`  ${tick(true)} SUPABASE_URL              ${env.SUPABASE_URL}`);
  console.log(
    `  ${tick(true)} SUPABASE_SERVICE_ROLE_KEY set (${env.SUPABASE_SERVICE_ROLE_KEY.length} chars)`,
  );
  const adzuna = hasAdzunaCreds(env);
  const jooble = hasJoobleCreds(env);
  console.log(`  ${tick(adzuna)} Adzuna                    ${adzuna ? 'configured' : 'missing — source will be skipped'}`);
  console.log(`  ${tick(jooble)} Jooble                    ${jooble ? 'configured' : 'missing — source will be skipped'}`);
  if (!adzuna && !jooble) {
    console.log('       ! no job sources configured; live polling will do nothing');
  }

  // --- 2 & 3. Schema -------------------------------------------------------
  console.log('\nSchema');
  const db = getServiceClient();
  const missing: string[] = [];
  const counts = new Map<string, number>();

  for (const table of EXPECTED_TABLES) {
    // Deliberately a real GET, not `head: true`. PostgREST answers a HEAD for
    // a missing table with a bodiless 404, so supabase-js leaves `error` null
    // and `count` null — which reads as "exists, 0 rows" and reports a schema
    // that was never applied as healthy. Ask for a row and check the status.
    const { error, count, status } = await db
      .from(table)
      .select('*', { count: 'exact' })
      .limit(1);
    if (error || status >= 400) {
      missing.push(table);
      problems++;
      const why = error ? error.message.slice(0, 55) : `HTTP ${status}`;
      console.log(`  ${tick(false)} ${table.padEnd(20)} ${why}`);
    } else {
      counts.set(table, count ?? 0);
      console.log(`  ${tick(true)} ${table.padEnd(20)} ${count ?? 0} rows`);
    }
  }

  if (missing.length === EXPECTED_TABLES.length) {
    console.log('\n  -> No tables at all. The schema has not been applied yet.');
  } else if (missing.length > 0) {
    console.log(
      `\n  -> PARTIAL SCHEMA: ${missing.length} of ${EXPECTED_TABLES.length} tables missing ` +
        `(${missing.join(', ')}).\n     Re-apply 20260823090000_init.sql; it is idempotent, so ` +
        `re-running it is safe.`,
    );
  }

  // --- 4. Seed -------------------------------------------------------------
  if (missing.length === 0) {
    console.log('\nSeed data');
    for (const [table, expected] of Object.entries(EXPECTED_SEED)) {
      const actual = counts.get(table) ?? 0;
      const ok = actual >= expected!;
      if (!ok) problems++;
      console.log(
        `  ${tick(ok)} ${table.padEnd(20)} ${actual} rows (expected at least ${expected})`,
      );
    }

    const { data: filter } = await db
      .from('filters')
      .select('name, center_label, radius_km, min_duration_weeks')
      .eq('is_active', true)
      .maybeSingle();

    if (!filter) {
      problems++;
      console.log('  FAIL no active filter row — the seed migration has not run');
    } else {
      console.log(
        `  ${tick(true)} active filter        "${filter.name}"\n` +
          `       ${filter.radius_km}km of ${filter.center_label}, min ${filter.min_duration_weeks}w`,
      );
      const [{ count: kw }, { count: pref }] = await Promise.all([
        db.from('filter_keywords').select('*', { count: 'exact', head: true }),
        db.from('filter_preferences').select('*', { count: 'exact', head: true }),
      ]);
      const kwOk = (kw ?? 0) > 0;
      const prefOk = (pref ?? 0) > 0;
      if (!kwOk || !prefOk) problems++;
      console.log(`  ${tick(kwOk)} keywords             ${kw ?? 0}`);
      console.log(`  ${tick(prefOk)} preferences          ${pref ?? 0}`);

      // Migration 20260825120000. Without this column every acronym matches
      // case-insensitively, which means the keyword IT matches the pronoun
      // "it" and the pre-filter passes essentially everything.
      const { data: cased, error: casedError } = await db
        .from('filter_keywords')
        .select('term')
        .eq('case_sensitive', true);

      if (casedError) {
        problems++;
        console.log(
          `  FAIL case_sensitive      column missing — apply migration ` +
            `20260825120000_keyword_case_sensitivity.sql`,
        );
      } else {
        const terms = (cased ?? []).map((r) => r.term as string);
        const hasIT = terms.includes('IT');
        if (!hasIT) problems++;
        console.log(
          `  ${tick(hasIT)} case-sensitive kw    ${terms.length} (${terms.join(', ') || 'none'})` +
            (hasIT ? '' : '\n       ! "IT" is not case-sensitive; it will match the pronoun "it"'),
        );
      }
    }
  }

  // --- 4b. Scoring (Phase 2) ----------------------------------------------
  if (missing.length === 0) {
    console.log('\nScoring');
    const anthropic = Boolean(env.ANTHROPIC_API_KEY);
    console.log(`  ${tick(anthropic)} ANTHROPIC_API_KEY    ${anthropic ? `set, model ${env.ANTHROPIC_MODEL}` : 'missing — scoring will be skipped'}`);

    const { data: settingsRow, error: settingsError } = await db
      .from('app_settings')
      .select('scoring_enabled,scoring_batch_size,max_scoring_spend_usd_per_cycle,max_scoring_spend_usd_per_day,scoring_spend_today')
      .eq('id', 1)
      .maybeSingle();

    if (settingsError) {
      console.log('  --   scoring settings    columns missing — apply 20260826120000_scoring_settings.sql');
    } else {
      const s = settingsRow as Record<string, unknown>;
      console.log(
        `  ${tick(Boolean(s.scoring_enabled))} scoring in loop     ` +
          `${s.scoring_enabled ? 'enabled' : 'disabled (queue will build up, nothing lost)'}`,
      );
      console.log(
        `  --   budget              $${Number(s.scoring_spend_today).toFixed(4)} spent today ` +
          `of $${Number(s.max_scoring_spend_usd_per_day).toFixed(2)}/day, ` +
          `$${Number(s.max_scoring_spend_usd_per_cycle).toFixed(2)}/cycle, batch ${s.scoring_batch_size}`,
      );
    }

    // Shared with the Telegram /stats command so the two can never disagree.
    // This used to be `passed - scored`, which stopped being true when
    // near-duplicate suppression shipped: duplicates are `passed` but are
    // deliberately never scored, leaving a phantom backlog that never cleared.
    const pipeline = await collectPipelineStats();
    console.log(
      `  --   queue               ${pipeline.scored} scored, ${pipeline.awaitingScore} awaiting a score` +
        (pipeline.duplicates ? ` (${pipeline.duplicates} near-duplicates excluded)` : ''),
    );
  }

  // --- 4c. Telegram (Phase 3) ---------------------------------------------
  if (missing.length === 0) {
    console.log('\nTelegram');
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.log(
        `  --   bot                 ${!token ? 'TELEGRAM_BOT_TOKEN' : 'TELEGRAM_CHAT_ID'} not set` +
          ' — notifications and commands disabled',
      );
    } else {
      try {
        const me = await getMe(token);
        console.log(`  ${tick(true)} bot token           valid, @${me.username ?? me.id}`);
      } catch (err) {
        problems++;
        console.log(`  ${tick(false)} bot token           ${err instanceof Error ? err.message : err}`);
      }
      // Not verified by sending a message — doctor must stay side-effect free.
      console.log(`  --   chat id             ${chatId} (${chatId.startsWith('-') ? 'group' : 'direct'})`);

      const sentToday = await notificationsSentToday();
      const { data: capRow } = await db
        .from('app_settings').select('max_notifications_per_day').eq('id', 1).maybeSingle();
      const cap = (capRow as { max_notifications_per_day: number } | null)?.max_notifications_per_day ?? 0;
      console.log(`  --   notifications       ${sentToday} sent today of ${cap}/day`);
    }
  }

  // --- 5. Security posture -------------------------------------------------
  // The single most important property in this project: the anon key must
  // reach nothing. RLS is enabled with no policies and privileges are revoked,
  // so a client holding the anon key should get either a permission error or
  // an empty result — never a row. Verified rather than assumed, because a
  // future migration that adds a policy could quietly undo it.
  if (missing.length === 0 && env.SUPABASE_ANON_KEY) {
    console.log('\nSecurity (anon key should reach nothing)');
    const { createClient } = await import('@supabase/supabase-js');
    const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    for (const table of ['filters', 'job_listings', 'matches'] as const) {
      const { data, error } = await anon.from(table).select('*').limit(1);
      const rows = data?.length ?? 0;
      const blocked = Boolean(error) || rows === 0;
      if (!blocked) problems++;
      console.log(
        `  ${tick(blocked)} ${table.padEnd(20)} ` +
          (error ? `blocked (${error.code ?? 'error'})` : rows === 0 ? 'blocked (0 rows)' : `LEAK — returned ${rows} row(s)`),
      );
    }
  } else if (missing.length === 0) {
    console.log('\nSecurity\n  --   SUPABASE_ANON_KEY not set, skipping anon-access check');
  }

  console.log(
    problems === 0
      ? '\nReady. Next: npm run worker:once\n'
      : `\n${problems} problem(s) above. See README step 4 (Apply the schema).\n`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\ndoctor failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
