import { describe, expect, it } from 'vitest';
import { blockedDomains, checkCareerUrl } from './denylist';
import { extractJobPostings, htmlToText } from './jsonld';
import { parseRobots } from './robots';

describe('denylist', () => {
  it('refuses the three boards CLAUDE.md names, including subdomains', () => {
    for (const url of [
      'https://www.seek.com.au/jobs',
      'https://seek.com.au/x',
      'https://au.linkedin.com/jobs/view/1',
      'https://linkedin.com/jobs',
      'https://au.indeed.com/q-intern',
      'https://www.indeed.com/viewjob',
    ]) {
      expect(checkCareerUrl(url).blocked, url).toBe(true);
    }
  });

  it('refuses private and loopback addresses', () => {
    // A user-supplied URL that reaches internal services is SSRF, not scraping.
    for (const url of [
      'http://localhost/careers',
      'http://127.0.0.1:8080/',
      'http://10.1.2.3/',
      'http://192.168.0.10/',
      'http://172.16.5.5/',
      'http://169.254.169.254/latest/meta-data/',
      'http://internal.local/jobs',
    ]) {
      expect(checkCareerUrl(url).blocked, url).toBe(true);
    }
  });

  it('fails CLOSED on anything it cannot parse', () => {
    // A guard that cannot identify the host must refuse, not shrug.
    for (const url of ['', 'not-a-url', 'file:///etc/passwd', 'ftp://example.com/x', '//example.com']) {
      expect(checkCareerUrl(url).blocked, url).toBe(true);
    }
  });

  it('allows an ordinary company career page', () => {
    for (const url of [
      'https://www.example.com.au/careers',
      'https://job-boards.greenhouse.io/acme/jobs/123',
      'https://jobs.lever.co/acme/abc-def',
    ]) {
      expect(checkCareerUrl(url).blocked, url).toBe(false);
    }
  });

  it('does not accidentally block a company whose name contains a board name', () => {
    // "seekers.com.au" is not "seek.com.au". Suffix matching must respect the
    // dot boundary or a legitimate employer gets silently refused.
    expect(checkCareerUrl('https://seekers.com.au/careers').blocked).toBe(false);
    expect(checkCareerUrl('https://myindeed.com/careers').blocked).toBe(false);
  });

  it('exposes the list so the dashboard can show it', () => {
    expect(blockedDomains()).toContain('seek.com.au');
  });
});

describe('robots.txt', () => {
  const AGENT = 'intern-finder-bot/1.0';

  it('honours a disallow for the wildcard agent', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private\n', AGENT);
    expect(rules.allows('/private/x')).toBe(false);
    expect(rules.allows('/careers')).toBe(true);
  });

  it('lets the longest match win, with Allow beating Disallow', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /careers\nAllow: /careers/jobs\n',
      AGENT,
    );
    expect(rules.allows('/careers/jobs/1')).toBe(true);
    expect(rules.allows('/careers/other')).toBe(false);
  });

  it('treats an empty Disallow as permission', () => {
    expect(parseRobots('User-agent: *\nDisallow:\n', AGENT).allows('/anything')).toBe(true);
  });

  it('prefers a group naming us over the wildcard group', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: intern-finder-bot\nDisallow: /admin\n',
      AGENT,
    );
    expect(rules.allows('/careers')).toBe(true);
    expect(rules.allows('/admin/x')).toBe(false);
  });

  it('reads crawl-delay', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: 5\n', AGENT).crawlDelaySeconds).toBe(5);
  });

  it('supports wildcards and end-anchors', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /*.pdf$\n', AGENT);
    expect(rules.allows('/files/brochure.pdf')).toBe(false);
    expect(rules.allows('/files/brochure.pdf.html')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobots('# hello\n\nUser-agent: *  # everyone\nDisallow: /x\n', AGENT);
    expect(rules.allows('/x')).toBe(false);
  });
});

/** Shaped after real ATS output: @graph wrapper, HTML description, nested address. */
const REAL_ISH_PAGE = `
<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Organization","name":"Acme Pty Ltd"}
</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[{
  "@type":"JobPosting",
  "title":"IT Support Intern",
  "datePosted":"2026-09-01",
  "employmentType":["PART_TIME","INTERN"],
  "hiringOrganization":{"@type":"Organization","name":"Acme Pty Ltd"},
  "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress",
    "addressLocality":"Footscray","addressRegion":"VIC","postalCode":"3011",
    "addressCountry":"AU"}},
  "baseSalary":{"@type":"MonetaryAmount","currency":"AUD",
    "value":{"@type":"QuantitativeValue","minValue":30,"maxValue":35,"unitText":"HOUR"}},
  "url":"/careers/it-support-intern",
  "description":"&lt;p&gt;Help desk support.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;12 week placement&lt;/li&gt;&lt;/ul&gt;"
}]}
</script>
</head><body></body></html>`;

describe('JSON-LD JobPosting extraction', () => {
  const jobs = extractJobPostings(REAL_ISH_PAGE, 'https://acme.com.au/careers/');

  it('finds the posting and ignores the Organization block', () => {
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.title).toBe('IT Support Intern');
  });

  it('digs through @graph', () => {
    expect(jobs[0]!.company).toBe('Acme Pty Ltd');
  });

  it('flattens the nested address into something resolveLocation can read', () => {
    // The geo layer takes the first recognised segment, so locality must lead.
    expect(jobs[0]!.locationRaw).toBe('Footscray, VIC, 3011, AU');
  });

  it('resolves a relative url against the page', () => {
    expect(jobs[0]!.url).toBe('https://acme.com.au/careers/it-support-intern');
  });

  it('converts the HTML description to text', () => {
    expect(jobs[0]!.description).toContain('Help desk support.');
    expect(jobs[0]!.description).toContain('12 week placement');
    expect(jobs[0]!.description).not.toContain('<');
  });

  it('reads salary and date', () => {
    expect(jobs[0]!.salaryMin).toBe(30);
    expect(jobs[0]!.salaryMax).toBe(35);
    expect(jobs[0]!.salaryCurrency).toBe('AUD');
    expect(jobs[0]!.postedDate?.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('keeps the raw posting for diagnosis', () => {
    expect((jobs[0]!.raw as Record<string, unknown>)['@type']).toBe('JobPosting');
  });

  it('survives a malformed block without losing the good ones', () => {
    const html =
      '<script type="application/ld+json">{ this is not json }</script>' + REAL_ISH_PAGE;
    expect(extractJobPostings(html, 'https://acme.com.au/')).toHaveLength(1);
  });

  it('tolerates raw control characters inside a description', () => {
    // Real pages paste tabs and newlines straight into JSON strings, which is
    // illegal and makes JSON.parse throw.
    const html =
      '<script type="application/ld+json">{"@type":"JobPosting","title":"Cyber Intern",' +
      '"description":"line one	line two"}</script>';
    const found = extractJobPostings(html, 'https://acme.com.au/');
    expect(found).toHaveLength(1);
    expect(found[0]!.title).toBe('Cyber Intern');
  });

  it('drops a posting with no title rather than inventing one', () => {
    const html = '<script type="application/ld+json">{"@type":"JobPosting","description":"x"}</script>';
    expect(extractJobPostings(html, 'https://acme.com.au/')).toHaveLength(0);
  });

  it('returns nothing for a page with no markup, without throwing', () => {
    expect(extractJobPostings('<html><body>nothing here</body></html>', 'https://x.com/')).toEqual([]);
  });

  it('deduplicates a posting emitted both bare and inside @graph', () => {
    const one = '{"@type":"JobPosting","title":"Dup","url":"https://x.com/1"}';
    const html =
      `<script type="application/ld+json">${one}</script>` +
      `<script type="application/ld+json">{"@graph":[${one}]}</script>`;
    expect(extractJobPostings(html, 'https://x.com/')).toHaveLength(1);
  });
});

describe('htmlToText', () => {
  it('keeps list structure readable', () => {
    expect(htmlToText('<ul><li>One</li><li>Two</li></ul>')).toBe('- One\n- Two');
  });

  it('decodes entities and strips scripts', () => {
    expect(htmlToText('<script>evil()</script><p>R&amp;D team</p>')).toBe('R&D team');
  });
});
