import { describe, expect, it } from 'vitest';
import { CATALOG, canConnect, compile, hasErrors, topo, validate } from '../src/index';
import { nodeId } from '@nb/schema';

/**
 * Legality is emergent, not enumerated.
 *
 * The point of ports carrying a protocol and capability tags is that nobody
 * writes down "a cache may not connect to a database". It falls out, and it
 * falls out with an explanation attached.
 */

const ref = (node: string, port: string) => ({ nodeId: nodeId(node), portId: port });

const SITE = topo(
  [
    { id: 'client', type: 'client', region: 'us-west' },
    { id: 'origin', type: 'origin', region: 'us-west' },
    { id: 'db', type: 'database', region: 'us-west' },
  ],
  [{ from: 'client', to: 'origin' }, { from: 'origin', to: 'db' }],
);

describe('port-based connection rules', () => {
  it('allows a legal connection', () => {
    const t = topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'origin', type: 'origin', region: 'us-west' },
      ],
      [],
    );
    expect(canConnect(CATALOG, t, ref('client', 'out'), ref('origin', 'in'))).toEqual({ ok: true });
  });

  it('rejects a cache wired straight into a database, without a rule saying so', () => {
    const t = topo(
      [
        { id: 'pop', type: 'cdn-pop', region: 'us-west' },
        { id: 'db', type: 'database', region: 'us-west' },
      ],
      [],
    );
    const check = canConnect(CATALOG, t, ref('pop', 'miss'), ref('db', 'in'));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    // The cache speaks http; the database listens on sql. That is the whole rule.
    expect(check.code).toBe('protocol-mismatch');
    expect(check.message).toContain('http');
    expect(check.message).toContain('sql');
  });

  it('explains itself, so a mistake becomes a teaching moment', () => {
    const t = topo(
      [
        { id: 'pop', type: 'cdn-pop', region: 'us-west' },
        { id: 'db', type: 'database', region: 'us-west' },
      ],
      [],
    );
    const check = canConnect(CATALOG, t, ref('pop', 'miss'), ref('db', 'in'));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.learnMoreId).toBeDefined();
  });

  it('rejects self-connection, wrong direction and duplicates', () => {
    const self = canConnect(CATALOG, SITE, ref('origin', 'db'), ref('origin', 'in'));
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.code).toBe('self-connection');

    const backwards = canConnect(CATALOG, SITE, ref('origin', 'in'), ref('client', 'out'));
    expect(backwards.ok).toBe(false);

    const duplicate = canConnect(CATALOG, SITE, ref('client', 'out'), ref('origin', 'in'));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.code).toBe('duplicate-edge');
  });

  it('enforces maximum degree', () => {
    // A database accepts many connections; an origin's db port accepts one.
    const t = topo(
      [
        { id: 'origin', type: 'origin', region: 'us-west' },
        { id: 'db', type: 'database', region: 'us-west' },
        { id: 'db2', type: 'database', region: 'us-west' },
      ],
      [{ from: 'origin', to: 'db' }],
    );
    const second = canConnect(CATALOG, t, ref('origin', 'db'), ref('db2', 'in'));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('degree-exceeded');
  });
});

describe('graph-level rules', () => {
  it('accepts a well-formed site', () => {
    const diagnostics = validate(SITE, CATALOG);
    expect(hasErrors(diagnostics)).toBe(false);
  });

  it('rejects a topology where traffic never reaches an origin', () => {
    const t = topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'pop', type: 'cdn-pop', region: 'us-west' },
      ],
      [{ from: 'client', to: 'pop' }],
    );
    const diagnostics = validate(t, CATALOG);
    expect(hasErrors(diagnostics)).toBe(true);
    // The cache has an unconnected miss path, so this reports both the unmet
    // degree and the fact that nothing can answer a miss.
    expect(diagnostics.some((d) => d.code === 'degree-unmet')).toBe(true);
  });

  it('rejects a cycle', () => {
    const t = topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'lb', type: 'load-balancer', region: 'us-west' },
        { id: 'pop', type: 'cdn-pop', region: 'us-west' },
      ],
      [
        { from: 'client', to: 'lb' },
        { from: 'lb', to: 'pop' },
        { from: 'pop', to: 'lb' },
      ],
    );
    const diagnostics = validate(t, CATALOG);
    expect(diagnostics.some((d) => d.code === 'http-cycle')).toBe(true);
  });

  it('warns about a single point of failure without blocking the run', () => {
    const diagnostics = validate(SITE, CATALOG);
    const spof = diagnostics.filter((d) => d.code === 'single-point-of-failure');
    expect(spof.length).toBeGreaterThan(0);
    // A warning affects the grade; it does not stop the player pressing Run.
    expect(spof.every((d) => d.severity === 'warning')).toBe(true);
    expect(hasErrors(diagnostics)).toBe(false);
  });

  it('rejects invalid component configuration', () => {
    const t = topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'origin', type: 'origin', region: 'us-west', config: { servers: -4 } },
      ],
      [{ from: 'client', to: 'origin' }],
    );
    const diagnostics = validate(t, CATALOG);
    expect(diagnostics.some((d) => d.code === 'invalid-config')).toBe(true);
  });

  it('rejects an unknown component type', () => {
    const t = topo(
      [{ id: 'x', type: 'quantum-blockchain', region: 'us-west' }],
      [],
    );
    expect(validate(t, CATALOG).some((d) => d.code === 'unknown-component')).toBe(true);
  });
});

describe('compiling to simulation input', () => {
  it('turns a topology into stations and edges', () => {
    const { stations, edges } = compile(SITE, CATALOG);
    expect(stations).toHaveLength(3);
    expect(edges).toHaveLength(2);

    const client = stations.find((s) => s.id === 'client');
    const origin = stations.find((s) => s.id === 'origin');
    const db = stations.find((s) => s.id === 'db');

    // A traffic source is infinite-server; an origin is not.
    expect(client?.servers).toBe(Number.POSITIVE_INFINITY);
    expect(origin?.servers).toBe(8);
    // The database's high service variance is what makes level 9 work.
    expect(db?.serviceCv2).toBe(4.0);
  });

  it('applies player configuration over the template defaults', () => {
    const t = topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'origin', type: 'origin', region: 'us-west', config: { servers: 32 } },
      ],
      [{ from: 'client', to: 'origin' }],
    );
    const { stations } = compile(t, CATALOG);
    expect(stations.find((s) => s.id === 'origin')?.servers).toBe(32);
  });

  it('routes cache configuration into the routing policy, not a side channel', () => {
    const t = topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'pop', type: 'cdn-pop', region: 'us-west', config: { ttlSeconds: 60, collapsing: true } },
        { id: 'origin', type: 'origin', region: 'us-west' },
      ],
      [{ from: 'client', to: 'pop' }, { from: 'pop', to: 'origin' }],
    );
    const { stations } = compile(t, CATALOG);
    const routing = stations.find((s) => s.id === 'pop')?.routing;
    expect(routing?.kind).toBe('cache-split');
    if (routing?.kind === 'cache-split') {
      expect(routing.ttlSeconds).toBe(60);
      expect(routing.collapsing).toBe(true);
    }
  });
});
