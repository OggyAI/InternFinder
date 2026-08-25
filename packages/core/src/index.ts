/** Public surface of @intern-finder/core, shared by the worker and (Phase 3) the dashboard. */
export * from './types';
export * from './env';
export * from './log';
export * from './geo';
export * from './signals';
export * from './preferences';
export * from './prefilter';
export * from './dedupe';
export * from './supabase';
export * from './filters';
export { MELBOURNE_SUBURBS, SUBURB_ALIASES } from './data/melbourne-suburbs';
