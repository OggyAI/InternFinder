import { readFile } from 'node:fs/promises';
import { log, type NormalizedListing, type SourceName } from '@intern-finder/core';
import { AdzunaResponse, normalizeAdzunaJob } from './adzuna';
import { JoobleResponse, normalizeJoobleJob } from './jooble';
import type { FetchResult, SourceAdapter } from './types';

/**
 * Fixture-backed adapters.
 *
 * These exist so the entire Phase 1 pipeline — normalise, dedupe, pre-filter,
 * upsert — is runnable and testable without Adzuna or Jooble credentials.
 *
 * Critically, they reuse the SAME normalisers and the SAME zod schemas as the
 * live adapters. Only the transport is swapped: a file read instead of an HTTP
 * request. A fixture that parses is real evidence the live path will parse an
 * identically-shaped response; it is not evidence that the live response has
 * that shape, which is a separate thing to confirm once keys exist.
 */

const FIXTURE_FILES: Record<'adzuna' | 'jooble', string> = {
  adzuna: new URL('../fixtures/adzuna.sample.json', import.meta.url).pathname,
  jooble: new URL('../fixtures/jooble.sample.json', import.meta.url).pathname,
};

// On Windows, URL.pathname yields "/C:/..." which fs cannot open.
function fsPath(p: string): string {
  return p.replace(/^\/([A-Za-z]:)/, '$1');
}

async function loadAdzunaFixture(): Promise<NormalizedListing[]> {
  const raw = JSON.parse(await readFile(fsPath(FIXTURE_FILES.adzuna), 'utf8'));
  const parsed = AdzunaResponse.parse(raw);
  return parsed.results
    .map((j) => normalizeAdzunaJob(j))
    .filter((l): l is NormalizedListing => l !== null);
}

async function loadJoobleFixture(): Promise<NormalizedListing[]> {
  const raw = JSON.parse(await readFile(fsPath(FIXTURE_FILES.jooble), 'utf8'));
  const parsed = JoobleResponse.parse(raw);
  return parsed.jobs
    .map((j) => normalizeJoobleJob(j))
    .filter((l): l is NormalizedListing => l !== null);
}

function makeFixtureAdapter(name: 'adzuna' | 'jooble'): SourceAdapter {
  return {
    name: name as SourceName,
    isConfigured: () => true,
    async fetch(): Promise<FetchResult> {
      const listings = name === 'adzuna' ? await loadAdzunaFixture() : await loadJoobleFixture();
      log.info(`${name}[fixture]: loaded ${listings.length} listings from disk`);
      // Zero calls: nothing was spent, so the daily quota is untouched.
      return { listings, calls: 0 };
    },
  };
}

export const adzunaFixtureAdapter = makeFixtureAdapter('adzuna');
export const joobleFixtureAdapter = makeFixtureAdapter('jooble');
