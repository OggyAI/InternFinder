# Fixtures

Hand-built samples modelled on each provider's **documented** response shape.
They are not captured traffic — there were no API keys when Phase 1 was built.
Re-record them from a real response once keys exist, then re-run the tests.

They flow through the same zod schemas and the same normalisers as the live
adapters (`sources/fixtures.ts` swaps only the transport), so a fixture that
parses proves the *pipeline* handles that shape. It does not prove the live API
*returns* that shape.

Each entry targets one pre-filter path:

| Fixture | Listing | Expected |
|---|---|---|
| adzuna | Cyber Security Internship, Docklands, unpaid, 12wk, part-time | **pass**, highest multiplier |
| adzuna | IT Support Officer, Werribee, casual, paid | **pass** |
| adzuna | Security Guard, Sunshine | drop — `excluded_keyword` |
| adzuna | SOC Analyst, Sydney | drop — `out_of_radius` |
| adzuna | Cyber Graduate Program, citizenship required | drop — `work_rights` |
| adzuna | Data Entry Officer, Sunshine, part-time | **pass** |
| adzuna | Senior InfoSec Consultant, remote, full-time, paid | **pass**, lowest multiplier |
| adzuna | IT Work Experience, 2 weeks | drop — `too_short` |
| jooble | Cyber Security Intern, Point Cook, semester | **pass** |
| jooble | Service Desk Analyst, Laverton North, full-time | **pass** |
| jooble | Barista, Werribee | drop — `no_keyword_match` |
| jooble | IT Helpdesk, Ballarat | drop — `out_of_radius` |
| jooble | Volunteer IT Support, St Albans, unpaid | **pass**, high multiplier |
