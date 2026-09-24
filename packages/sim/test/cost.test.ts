import { describe, expect, it } from 'vitest';
import { nodeId, regionId } from '@nb/schema';
import { computeCost, makeStation } from '../src/index';

/**
 * Stations are charged what they declare.
 *
 * Found in playtest: a load balancer appeared to be free. It was - `computeCost`
 * applied one flat per-server rate to every station and never read the catalog's
 * cost specs, so a load balancer, a CDN PoP and an origin shield all cost
 * nothing, and a database was billed at more than twice its real rate. The
 * origin was correct only because the global default happened to match its
 * price, which is what hid the bug.
 */
const agg = {
  edgeEgressBytes: 0, originEgressBytes: 0, totalRequests: 0,
  cacheStorageBytes: 0, simulatedSeconds: 60,
};

const station = (id: string, servers: number, perServer: number, fixed: number) =>
  makeStation({
    id: nodeId(id), regionId: regionId('r'), servers, serviceMeanMs: 10,
    costPerServerMonth: perServer, costFixedMonth: fixed,
  });

describe('per-component pricing', () => {
  it('charges a per-slot price', () => {
    const m = new Map([[nodeId('o'), station('o', 10, 30, 0)]]);
    expect(computeCost(m, agg).computeUsdMonth).toBe(300);
  });

  it('charges a fixed fee even with no billable slots', () => {
    // A load balancer is an infinite-server pass-through: no slots to bill,
    // but it is not free.
    const lb = makeStation({
      id: nodeId('lb'), regionId: regionId('r'),
      servers: Number.POSITIVE_INFINITY, serviceMeanMs: 0.2,
      costPerServerMonth: 0, costFixedMonth: 25,
    });
    expect(computeCost(new Map([[nodeId('lb'), lb]]), agg).computeUsdMonth).toBe(25);
  });

  it('charges slots and a fixed fee together', () => {
    // A database: 16 connections at $12, plus $120 for the instance.
    const m = new Map([[nodeId('db'), station('db', 16, 12, 120)]]);
    expect(computeCost(m, agg).computeUsdMonth).toBe(16 * 12 + 120);
  });

  it('falls back to the rate card when a station declares no price', () => {
    const m = new Map([[nodeId('x'), station('x', 4, 0, 0)]]);
    expect(computeCost(m, agg).computeUsdMonth).toBe(4 * 30);
  });

  it('a traffic source costs nothing at all', () => {
    const client = makeStation({
      id: nodeId('c'), regionId: regionId('r'),
      servers: Number.POSITIVE_INFINITY, serviceMeanMs: 0,
    });
    expect(computeCost(new Map([[nodeId('c'), client]]), agg).computeUsdMonth).toBe(0);
  });
});
