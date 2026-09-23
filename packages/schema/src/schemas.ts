import { z } from 'zod';

/**
 * Runtime validation for authored data.
 *
 * Types catch reference errors at compile time; these catch the things types
 * cannot express — a negative budget, an unreachable SLO, a TTL of zero. They
 * run at test time over `@nb/content`, not in the simulation hot path.
 */

const positive = z.number().finite().positive();
const nonNegative = z.number().finite().nonnegative();
const unitInterval = z.number().finite().min(0).max(1);

export const trafficClassSchema = z.object({
  id: z.string().min(1),
  cacheable: z.boolean(),
  objectPopulation: z
    .object({
      count: z.number().int().positive(),
      zipfAlpha: z.number().finite().positive(),
    })
    .optional(),
  responseBytes: positive,
  originCpuMs: nonNegative,
  clientTimeoutMs: positive,
  retryPolicy: z.object({
    maxAttempts: z.number().int().min(1),
    backoffMs: nonNegative,
    budgetFraction: unitInterval,
  }),
  slo: z
    .object({ p99Ms: positive, errorRatePct: nonNegative })
    .optional(),
}).refine(
  (c) => !c.cacheable || c.objectPopulation !== undefined,
  { message: 'a cacheable class needs an objectPopulation to compute hit ratio' },
);

export const protocolProfileSchema = z.object({
  id: z.string().min(1),
  handshakeRtts: nonNegative,
  connectionReuse: unitInterval,
  cryptoCpuMs: nonNegative,
  requiresClientCert: z.boolean().optional(),
});

export const regionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
});

export const topologySchema = z.object({
  nodes: z.array(z.object({
    id: z.string().min(1),
    typeId: z.string().min(1),
    regionId: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
  })),
  edges: z.array(z.object({
    id: z.string().min(1),
    from: z.object({ nodeId: z.string().min(1), portId: z.string().min(1) }),
    to: z.object({ nodeId: z.string().min(1), portId: z.string().min(1) }),
    config: z.object({
      protocolId: z.string().min(1),
      weight: positive.optional(),
    }),
  })),
}).superRefine((t, ctx) => {
  const ids = new Set(t.nodes.map((n) => n.id));
  if (ids.size !== t.nodes.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate node id' });
  }
  for (const e of t.edges) {
    for (const ref of [e.from, e.to]) {
      if (!ids.has(ref.nodeId)) {
        ctx.addIssue({ code: 'custom', message: `edge ${e.id} references unknown node ${ref.nodeId}` });
      }
    }
  }
});
