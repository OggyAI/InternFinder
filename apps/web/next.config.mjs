/*
 * Environment comes from scripts/with-env.mjs, which loads the workspace-root
 * .env BEFORE starting Next. Loading it here instead does not work: render
 * workers and the Edge middleware runtime are separate processes and do not
 * inherit a process.env mutated during config evaluation.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @intern-finder/core is published as raw TypeScript inside the workspace —
  // there is no build step anywhere in this repo — so Next has to compile it
  // rather than treat it as a prebuilt dependency.
  transpilePackages: ['@intern-finder/core'],

  // Deliberately NO `env:` block. Anything listed there is inlined into client
  // bundles wherever it is referenced, and the only secrets this app holds are
  // the service-role key and the dashboard password. Both stay server-side and
  // are read through process.env inside Server Components, Server Actions and
  // middleware.
  reactStrictMode: true,
};

export default nextConfig;
