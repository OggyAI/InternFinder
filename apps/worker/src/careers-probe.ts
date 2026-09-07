import { fetchCareerPage, blockedDomains, preferIPv4 } from '@intern-finder/core';
preferIPv4();

/**
 * `npm run careers:probe -- <url>` — can this career page be used, and what
 * would it yield?
 *
 * Run this BEFORE adding a page. It answers the three questions that decide
 * whether a page is worth tracking: are we allowed to fetch it, does it publish
 * structured job data, and what does that data look like once mapped.
 *
 * Read-only. One robots.txt request and one page request; writes nothing.
 */

const url = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (!url) {
  console.log('usage: npm run careers:probe -- https://example.com/careers');
  console.log(`\nblocked hosts: ${blockedDomains().join(', ')}`);
  process.exit(1);
}

const result = await fetchCareerPage(url);

console.log(`\n${result.ok ? 'OK' : 'REFUSED'}  ${url}`);
if (result.reason) console.log(`  reason: ${result.reason}`);
if (result.status) console.log(`  status: ${result.status}`);
console.log(`  robots: ${result.robots ?? 'n/a'}${result.crawlDelaySeconds != null ? `, crawl-delay ${result.crawlDelaySeconds}s` : ''}`);
console.log(`  requests used: ${result.calls}`);

if (!result.ok) process.exit(2);

console.log(`  JobPosting blocks found: ${result.jobs.length}`);
if (result.needsRendering) {
  console.log(
    '\n  No schema.org JobPosting markup on this page. It is either an index\n' +
      '  page whose roles live on separate URLs, or it renders via JavaScript.\n' +
      '  Try a specific job URL first before concluding it needs a browser.',
  );
}

for (const job of result.jobs.slice(0, 10)) {
  console.log(`\n  ${job.title}`);
  console.log(`    company:  ${job.company ?? '—'}`);
  console.log(`    location: ${job.locationRaw ?? '—'}`);
  console.log(`    type:     ${job.employmentType ?? '—'}`);
  console.log(`    posted:   ${job.postedDate?.toISOString().slice(0, 10) ?? '—'}`);
  console.log(`    url:      ${job.url ?? '—'}`);
  if (job.description) console.log(`    text:     ${job.description.slice(0, 120).replace(/\s+/g, ' ')}…`);
}
