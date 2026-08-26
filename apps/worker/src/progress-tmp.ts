import { getServiceClient } from '@intern-finder/core';
const db = getServiceClient();
const { count: scored } = await db.from('matches').select('*', { count: 'exact', head: true });
const { count: passed } = await db.from('job_listings')
  .select('*', { count: 'exact', head: true }).eq('prefilter_status', 'passed');
const pct = passed ? Math.round((scored! / passed) * 100) : 0;
console.log(`scored ${scored} / ${passed} passing listings  (${pct}%)`);
console.log(`estimated spend so far: $${((scored ?? 0) * 0.00214).toFixed(2)}`);
