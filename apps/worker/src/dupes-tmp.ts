import { getServiceClient } from '@intern-finder/core';
const db = getServiceClient();

const { data } = await db
  .from('job_listings')
  .select('id,content_fingerprint,title,company,location_suburb,distance_km,url,source,posted_date,first_seen_at,prefilter_status')
  .eq('prefilter_status', 'passed')
  .limit(5000);

const rows = (data ?? []) as any[];
const byFp = new Map<string, any[]>();
for (const r of rows) {
  const list = byFp.get(r.content_fingerprint) ?? [];
  list.push(r); byFp.set(r.content_fingerprint, list);
}
const groups = [...byFp.values()].filter(g => g.length > 1);

console.log(`${rows.length} passing listings`);
console.log(`${groups.length} fingerprint groups with >1 member`);
console.log(`${groups.reduce((s,g)=>s+g.length,0)} listings involved, ${groups.reduce((s,g)=>s+g.length-1,0)} would be suppressed\n`);

// Do duplicates share a location? If not, they may be genuinely different jobs.
let sameLoc = 0, diffLoc = 0, sameSource = 0, crossSource = 0;
for (const g of groups) {
  const locs = new Set(g.map(r => r.location_suburb ?? '?'));
  if (locs.size === 1) sameLoc++; else diffLoc++;
  const srcs = new Set(g.map(r => r.source));
  if (srcs.size === 1) sameSource++; else crossSource++;
}
console.log(`groups all in ONE suburb : ${sameLoc}`);
console.log(`groups spanning suburbs  : ${diffLoc}   <-- possibly distinct jobs`);
console.log(`groups from one source   : ${sameSource}`);
console.log(`groups spanning sources  : ${crossSource}\n`);

console.log('=== 8 largest groups ===');
for (const g of groups.sort((a,b)=>b.length-a.length).slice(0,8)) {
  console.log(`\n[${g.length}x] "${g[0].title}" — ${g[0].company ?? '?'}`);
  for (const r of g) {
    console.log(`     ${String(r.location_suburb ?? '?').padEnd(18)} ${String(r.distance_km ?? '?').padStart(6)}km  ${r.source}  posted=${String(r.posted_date).slice(0,10)}  ${r.url.slice(0, 58)}`);
  }
}
