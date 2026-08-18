/**
 * The one shared table of address forms behind the ip-address module's own unit
 * test and each call site's test (health, base-url-policy, install-guards) — so an
 * address form that a call site's wiring drops shows up as a failure at that call
 * site, not just in the module.
 */
export interface AddressFixture {
  readonly input: string;
  readonly loopback: boolean;
  readonly privateOrLocal: boolean;
}

export const ADDRESS_FIXTURES: AddressFixture[] = [
  { input: '127.0.0.1', loopback: true, privateOrLocal: true },
  { input: '127.0.0.1.', loopback: true, privateOrLocal: true },
  // Short forms are rejected rather than expanded (`127.1` !== `127.0.0.1`): every
  // implementation this module replaces required exactly four dot-separated
  // octets, so an unparseable address falls to each function's fail-safe default.
  { input: '127.1', loopback: false, privateOrLocal: true },
  { input: '10.0.0.1', loopback: false, privateOrLocal: true },
  { input: '100.64.0.1', loopback: false, privateOrLocal: true },
  { input: '169.254.1.1', loopback: false, privateOrLocal: true },
  { input: '8.8.8.8', loopback: false, privateOrLocal: false },
  { input: '256.1.1.1', loopback: false, privateOrLocal: true },
  { input: '::1', loopback: true, privateOrLocal: true },
  { input: '[::1]', loopback: true, privateOrLocal: true },
  { input: 'fe80::1%eth0', loopback: false, privateOrLocal: true },
  { input: '::ffff:127.0.0.1', loopback: true, privateOrLocal: true },
  { input: '::ffff:8.8.8.8', loopback: false, privateOrLocal: false },
  { input: '2001:db8::1', loopback: false, privateOrLocal: false },
];
