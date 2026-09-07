import dns from 'node:dns';
import net from 'node:net';

/**
 * Force outbound connections onto IPv4.
 *
 * The Oracle VM has no working IPv6 egress, and api.telegram.org publishes both
 * an A and an AAAA record. Node's Happy Eyeballs (`autoSelectFamily`, on by
 * default since Node 20) opens the AAAA address, which black-holes — no RST, no
 * ICMP, just silence — and instead of falling back to the working A record the
 * connection hangs until it times out. `curl` and `openssl s_client` reach the
 * same host fine, which is what made this look impossible for a while: the
 * network is not broken, only Node's fallback is.
 *
 * The symptom was `telegram: poll failed — fetch failed` every 60 seconds for
 * 21 hours: no commands, no buttons, no notifications, while polling, scoring
 * and the dashboard all kept working because Adzuna, Anthropic and Supabase all
 * resolve IPv4-first.
 *
 * Diagnosis, in case this ever returns:
 *
 *   tls.connect({host: 'api.telegram.org'})                        ETIMEDOUT
 *   tls.connect({host: '<the A record>', servername: '...'})        OK 678ms
 *   tls.connect({host: '...', family: 4, autoSelectFamily: false})  OK 626ms
 *
 * `--dns-result-order=ipv4first` alone is NOT enough — ordering does not stop
 * Happy Eyeballs from attempting the AAAA address. Both settings are required.
 *
 * Safe on IPv4-only and dual-stack hosts. On a genuinely IPv6-only network this
 * would be wrong, but nothing this project talks to is IPv6-only.
 */
export function preferIPv4(): void {
  // Added in Node 20. Guarded so an older runtime degrades rather than throws.
  if (typeof net.setDefaultAutoSelectFamily === 'function') {
    net.setDefaultAutoSelectFamily(false);
  }
  dns.setDefaultResultOrder('ipv4first');
}
