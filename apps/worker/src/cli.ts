/**
 * Flag parsing that survives npm.
 *
 * `npm run x -- --dry-run` does NOT pass --dry-run through: npm recognises it
 * as one of its own options and swallows it, setting npm_config_dry_run
 * instead. A script reading only process.argv therefore sees no flag and
 * cheerfully writes to the database, which is precisely the opposite of what
 * was asked for. Check both.
 */
export function hasFlag(name: string, argv = process.argv.slice(2)): boolean {
  if (argv.includes(`--${name}`)) return true;
  const envKey = `npm_config_${name.replace(/-/g, '_')}`;
  const value = process.env[envKey];
  return value === 'true' || value === '';
}

export function flagValue(name: string, argv = process.argv.slice(2)): string | null {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.env[`npm_config_${name.replace(/-/g, '_')}`] ?? null;
}
