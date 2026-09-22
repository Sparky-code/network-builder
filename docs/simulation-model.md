# The simulation model

This document exists to be challenged. Every constant has a source, every approximation
names what it gives up, and the places where the model is knowingly wrong are called out
rather than hidden. If something here is indefensible, it is cheaper to find out now than
after 41 levels have been tuned against it.

The goal is **numbers an experienced engineer will not laugh at**, produced cheaply and
deterministically. Not a research-grade network simulator — a teaching instrument whose
numbers are in the right order of magnitude and, more importantly, always move for the
right reason.

---

## 1. Why fluid simulation

The obvious framing is "discrete-event versus analytic". Both are wrong, and the third
option is what makes the later acts additive rather than a rewrite.

### Token-level discrete-event: rejected

Simulating every request as an event sequence is the intuitive choice and it fails on two
independent counts.

**Cost.** A stable p99 needs on the order of 10⁴–10⁵ completions. A level running 10k rps
for 60 simulated seconds is ~600k requests at roughly 20 events each: 12 million events.
In JavaScript that is seconds per run, not milliseconds. The game's entire pedagogy is the
*what-if* loop — change one thing, re-run, see what moved — and a multi-second run kills
it. The player stops experimenting and starts guessing.

**Noise.** Worse than slow, it is *unstable*. A Monte Carlo p99 carries sampling error, so
the same topology run twice lands on different sides of a pass/fail threshold. Grading
becomes a coin flip near the boundary, which is precisely where the interesting levels
live. A player who passes on the third identical attempt learns nothing except that the
game is arbitrary.

### Pure analytic steady-state: rejected

Solving the network once as a Jackson-style queueing network is instant and perfectly
stable. It also has **no time**, and time is the curriculum for half the game: autoscaler
lag, cache warm-up after a purge, health-check detection delay, the capacity dip during a
rolling deploy, DDoS onset, and retry-storm metastability are all transients. A
steady-state solver cannot express any of them.

### Fluid simulation, integrated over ticks: chosen

The unit of simulation is a **flow rate (requests/second) on an edge**, not a request.
Time advances in fixed ticks of 20–40ms simulated (25–50 ticks per simulated second).
Each tick:

```
apply scheduled events        (chaos, deploy, autoscale)
  → propagate flow rates      (topological order over the graph)
  → integrate state           (queue backlog, cache warmth, replicas, health, buckets)
  → compute latency kernels   (per station, from current λ and capacity)
  → compose kernels on routes (→ percentiles)
  → emit one MetricsFrame
```

Within a tick the system is treated as steady-state; across ticks, stateful quantities
integrate. This quasi-static approach gives sub-30ms full runs, **zero sampling noise in
grading**, and honest transients — the three things the rejected options each fail at.

The cost is that we must be comfortable with queueing approximations, which is roughly
150 lines of well-known mathematics and far cheaper than making a discrete-event
simulation both fast and stable.

**Where this is knowingly wrong:** fluid/mean-field descriptions degrade at low arrival
rates. At ~5 rps the smooth flow abstraction does not match what a player would intuit
from watching individual requests arrive. Mitigation: author level traffic at a few
hundred rps and above, and use the DES oracle (§8) to measure where the approximation
starts to drift rather than assuming a boundary.

### Packets on screen are a projection, not the simulation

The animated packets are sampled *from the same distributions the grader used* — spawned
at each edge's actual λ, with lifetimes drawn from the same inverse CDF and fates
(hit/miss/timeout/drop) drawn from the same probabilities. They are a view of the flow
state, never its source of truth.

This matters pedagogically, not just architecturally. When a station saturates, packets
visibly pile up *because the backlog state variable is genuinely growing*. What the player
watches and what the player is graded on cannot disagree, because one is drawn from the
other.

---

## 2. The five day-one commitments

The universal abstraction in §3 survives the jump to Kubernetes and security **if and
only if** these five things are true from the first commit. Each one is a rewrite if
deferred, so none of them may be quietly postponed during Phase 1 on the grounds that
Act I does not need them yet. Act I does not need them. Act V cannot be retrofitted
without them.

1. **`servers` is mutable state driven by a `Controller`, never a config constant.**
   If station concurrency is a number read from config, autoscaling, rolling deploys and
   readiness gating all become special cases bolted onto the engine.
2. **Traffic classes exist from level 1.** Not "added when we need caching". Without
   classes you cannot honestly model a cache (a CDN fronting 100% dynamic API traffic
   should get ~0% hits) or a WAF that correctly identifies only some attack traffic.
3. **Edges carry links with protocol profiles and RTT counts.** Handshake cost is a
   property of the link, not the node. This is where TLS, QUIC, keep-alive and mTLS all
   plug in; making it a node property means rewriting every security level's mechanics.
4. **Flow is a vector over classes, not a scalar.** Every rate in the engine is
   `Float64Array` indexed by class. Scalarising it now means touching every formula later.
5. **Latency is a distribution object, not a number.** Stations emit an invertible CDF.
   A mean latency cannot be composed into a believable p99, and retrofitting distributions
   through an engine written around scalars is a full rewrite of the metrics path.

---

## 3. The universal abstraction: Station + Policy + Controller

Everything the player can place is one shape.

```ts
// @nb/sim — knows nothing about "CDN" or "Kubernetes"
interface Station {
  id: NodeId;
  regionId: RegionId;

  servers: number;        // c — concurrent service slots. STATE, mutated by Controllers
  serviceMeanMs: number;  // S
  serviceCv2: number;     // squared coefficient of variation of service time
  queueLimit: number;     // beyond this, shed (503) rather than queue

  admission: AdmissionPolicy[];  // rate limit, WAF filter, load shedding, circuit breaker
  routing: RoutingPolicy;        // terminal | weighted | hash | cache-split | fanout
  controllers: Controller[];     // HPA, readiness gate, health prober, deploy controller

  backlogReqs: number;           // per-tick state, double-buffered
  health: 'healthy' | 'degraded' | 'down';
  warmth: number;                // 0..1 — cache fill, JIT warm, connection pool warm
}

interface Controller {
  id: string;
  /** Pure: reads the previous tick, returns mutations. Never mutates in place. */
  onTick(prev: Readonly<SimState>, self: Readonly<Station>, ctx: TickCtx): StationMutation[];
}

interface AdmissionPolicy {
  /** Splits offered flow into admitted and rejected, per traffic class. */
  admit(offered: FlowVector, self: Readonly<Station>, ctx: TickCtx): AdmissionResult;
}

interface RoutingPolicy {
  /** Splits admitted flow across outgoing edges. Cache hit/miss is a routing split. */
  route(admitted: FlowVector, edges: readonly Edge[], ctx: TickCtx): FlowSplit[];
}
```

Every component across all six acts maps onto it:

| Component | `servers` | service kernel | admission | routing | controllers |
| --- | --- | --- | --- | --- | --- |
| Origin server | worker count | lognormal, Cv²≈0.5 | — | terminal / to DB | — |
| Database | connection pool size | Cv²≈4.0 | — | terminal | — |
| Load balancer | ~∞ | 0.2ms | health-based shed | weighted over healthy | health prober |
| CDN PoP | ~∞ | 1ms | — | **cache split** | cache warmth |
| Origin shield | ~∞ | 1ms | — | cache split on aggregated misses | cache warmth |
| K8s pod | container concurrency | per-**version** kernel | — | terminal | readiness gate |
| Deployment | Σ replicas | mix over versions | — | — | **HPA**, rolling deploy |
| WAF | ~∞ | +`inspectionMs` | class filter with FP/FN rates | passthrough | — |
| Rate limiter | ~∞ | ~0 | token bucket per key | passthrough | — |
| TLS terminator | crypto workers | handshake CPU | — | passthrough | — |

### What the later acts actually need

**Kubernetes requires exactly one new primitive**: a `ResourcePool` (cluster nodes with
CPU and memory) that a scheduler bin-packs pods into, producing the "pending pod because
the cluster is full" lesson. The field is declared on day one and implemented in Act V.
Everything else — HPA, readiness gating, rolling deploys, surge and maxUnavailable — is a
`Controller` mutating `servers` and the version mix with lag.

**Security requires zero new primitives** beyond the connection model in §5. A WAF is
service time plus a drop rule. Rate limiting is an admission policy. mTLS is a protocol
profile. Segmentation is an edge-legality rule the graph validator already enforces.

This is the load-bearing claim of the whole design, which is why the Phase 2 spike exists
to test it a day after the engine works rather than a quarter later.

---

## 4. Demand, traffic classes, geography

```ts
interface TrafficClass {
  id: ClassId;                  // 'static-asset' | 'api-read' | 'api-write' | 'attack'
  cacheable: boolean;
  objectPopulation?: { count: number; zipfAlpha: number };
  responseBytes: number;        // drives egress cost and transfer time
  originCpuMs: number;
  clientTimeoutMs: number;
  retryPolicy: { maxAttempts: number; backoffMs: number; budgetFraction: number };
  slo?: { p99Ms: number; errorRatePct: number };
}

interface Demand {
  classId: ClassId;
  originRegions: Array<{ regionId: RegionId; weight: number }>;
  profile: RateProfile;         // constant | ramp | diurnal | spike | flood
}
```

### Propagation delay

The mechanic that motivates the entire edge chapter:

```
oneWayMs = haversineKm(a, b) / 200 * DETOUR     // 200 km/ms ≈ two-thirds c, in fiber
rttMs    = 2 * oneWayMs + LOCAL_FLOOR           // DETOUR ≈ 1.6, LOCAL_FLOOR ≈ 1ms
```

`DETOUR` accounts for the fact that fiber does not run along great circles — real paths
follow cable routes, and 1.4–1.8× is the usual observed range.

**Sanity check.** San Francisco to London is ~8,600 km. Ideal one-way is 43ms; with detour,
69ms; round-trip ~138ms. That matches real-world measurement, and it is the bar every
constant in this model has to clear: derive it, then check it against something published.

---

## 5. Connection setup is an edge property

The piece most likely to be bolted on badly, and the reason commitment #3 exists.

```ts
interface Link {
  fromRegion: RegionId; toRegion: RegionId;
  rttMs: number;                // derived from geography, cached
  bandwidthMbps: number;
  protocol: ProtocolProfile;
}

interface ProtocolProfile {
  id: 'http1-tls12' | 'http2-tls13' | 'http3-quic' | 'mtls-grpc' | 'plain-tcp';
  handshakeRtts: number;        // TCP 1 + TLS1.2 2 = 3;  TCP 1 + TLS1.3 1 = 2;  QUIC 0-RTT = 0
  connectionReuse: number;      // 0..1 — keep-alive pool effectiveness
  cryptoCpuMs: number;          // per handshake, charged to the terminating station
  requiresClientCert?: boolean; // mTLS: +1 RTT and 2× cryptoCpuMs
}

setupMs = (1 - connectionReuse) * handshakeRtts * rttMs
dnsMs   = resolverCached ? 0 : dnsRtt * (1 + delegationDepth)
```

One formula makes several otherwise hand-wavy lessons quantitative:

- why TLS 1.3 matters far more at 140ms RTT than at 2ms (the saving is *one RTT*, and an
  RTT is worth what geography says it is worth);
- why terminating TLS at the edge beats the raw compute saving by a wide margin — you are
  not saving CPU, you are moving handshake round trips from 140ms to 5ms;
- why mTLS in a service mesh taxes p99 on *every internal hop*, not once at the boundary;
- why connection pooling is often worth more than a faster server.

---

## 6. Per-station queueing

For a station with arrival rate λ, `c` servers, mean service time `S`, service CV² `Cs²`
and arrival CV² `Ca²`:

```
a = λ·S            offered load, in erlangs
ρ = a / c          utilization
```

### Stable case (ρ < 1)

M/M/c via Erlang, corrected toward M/G/c by the Allen–Cunneen approximation:

```
Erlang B recursion:  B(0,a) = 1;   B(n,a) = a·B(n−1,a) / (n + a·B(n−1,a))
Erlang C:            C = B(c,a) / (1 − ρ·(1 − B(c,a)))
Mean wait:           Wq = C·S / (c·(1 − ρ))  ×  (Ca² + Cs²)/2
Wait tail:           P(W > t) = C · exp(−(c/S)(1 − ρ)·t)
```

The Erlang B recursion is numerically stable for `c` into the thousands and costs O(c);
cache it per (c, quantized a).

This is where the single most important intuition in the game comes from: the
`1/(1−ρ)` term means p99 explodes long before capacity actually runs out. A station at 85%
utilization is not "15% away from trouble".

### Unstable case (ρ ≥ 1)

Where the drama lives, and where fluid beats analytic outright — a steady-state solver
simply has no answer here:

```
backlog += (λ − c/S) · dt
if backlog > queueLimit:
    dropped = λ − c/S
    backlog = queueLimit
wait = backlog / (c/S)            // Little's law, applied to the backlog
```

Because backlog is an *integrator*, three correct behaviours fall out for free: latency
climbs progressively rather than jumping, queue depth is a real state variable the
animation can show, and **recovery takes time proportional to the accumulated backlog
instead of snapping back the instant load drops**. That asymmetry — breaking is fast,
recovering is slow — is itself one of the lessons.

### Variance propagation

Whitt's QNA approximations, about 15 lines, and what makes downstream numbers believable
rather than arbitrary:

```
departure:   Cd² = 1 + (1 − ρ²)(Ca² − 1) + (ρ²/√c)(Cs² − 1)
merge:       Ca²ₘ = Σ λᵢ·Cd²ᵢ / Σ λᵢ
split(p):    Cd²ₚ = p·Cd² + (1 − p)
```

`Cs²` is an authored per-component constant and an excellent teaching lever. A database at
60% utilization with Cs²=4.0 queues worse than an app server at 85% with Cs²=0.5. Players
discover that utilization alone does not predict latency — variance does too — which is
not a lesson most people get before they hit it in production.

---

## 7. Latency kernels and route composition

Each station emits a closed-form **invertible CDF**, not a scalar (commitment #5):

```ts
interface LatencyKernel {
  pWait: number;         // Erlang C — probability of queueing at all
  waitRateHz: number;    // exponential rate of the wait component
  serviceMeanMs: number;
  serviceCv2: number;    // lognormal shape
  fixedMs: number;       // propagation + setup + transfer — the deterministic part
}

function invKernel(k: LatencyKernel, u: number, u2: number): number {
  const wait = u < k.pWait
    ? -Math.log(1 - u / k.pWait) / k.waitRateHz * 1000
    : 0;
  const s2 = Math.log(1 + k.serviceCv2);
  const mu = Math.log(k.serviceMeanMs) - s2 / 2;
  const svc = Math.exp(mu + Math.sqrt(s2) * invNorm(u2));   // Acklam rational approximation
  return k.fixedMs + wait + svc;
}
```

End-to-end latency on a route is a sum of independent kernels. Convolving histograms would
be O(B²) per route and too slow, so instead:

**A fixed stratified probe set.** P = 256 probes, each a fixed low-discrepancy vector of
uniforms. For each probe, sum `invKernel` across the route's hops; sort the 256 results
and read percentiles as order statistics.

This is the quiet keystone of the design. It is:

- **deterministic** — probe vectors are compiled constants, not drawn from the run's RNG,
  so they cannot be perturbed by anything else in the engine;
- **smooth** — a small topology change moves percentiles continuously rather than
  jumping, which is what makes grading near an SLO threshold feel fair instead of random;
- **cheap** — roughly 120 sample points × 256 probes × ~8 hops ≈ 250k inverse evaluations
  per run, a few milliseconds.

**Fan-out amplification falls out for free.** A route that fans out to N backends and waits
for all of them has `p99_of_max = F⁻¹(0.99^(1/N))`. At N=20 you need each backend's
p99.95 — the tail-at-scale lesson, in one line of code rather than a special case.

---

## 8. Caching

Do not simulate individual objects. Use the exact renewal result for a TTL cache over a
Zipf-distributed object population, bucketed into 32–64 log-spaced popularity groups so
the whole thing is O(64) per tick rather than O(10⁶):

```
For object i with request rate λᵢ and TTL T:   missRateᵢ = λᵢ / (1 + λᵢ·T)
hitRatio = 1 − (Σᵢ missRateᵢ) / λ
```

Three genuinely useful lessons emerge from this one formula with no extra engineering:

1. **Hit ratio improves with traffic volume.** More requests per TTL window amortise the
   one mandatory miss.
2. **Splitting traffic across many PoPs *hurts* hit ratio.** Each PoP sees λ/n, so λᵢT
   falls, so each one misses more often. A player who over-provisions PoPs to chase
   latency gets *worse* origin load — counterintuitive, correct, and it sets up the next
   point rather than being a gotcha.
3. **Origin shield is the fix** — the same formula applied to the aggregated miss stream
   from all PoPs, which restores a high λᵢT.

**Warm-up.** `warmth` relaxes toward 1 with a time constant ≈ TTL after a purge or
topology change; effective hit ratio is `h × warmth`. This is what teaches cold-start
cost after a deploy or a full purge.

**Thundering herd / request collapsing**, also closed form:

```
without collapsing:  originRateᵢ = missRateᵢ · (1 + λᵢ · originLatencySec)
with collapsing:     originRateᵢ = missRateᵢ
```

The amplification factor `(1 + λᵢ·L)` explodes exactly when the object is hot and the
origin is slow — precisely the moment you can least afford it. Two lines of code for one
of the best lessons in the game.

---

## 9. Retries, timeouts, and metastable failure

The most important dynamic in the game, and it works **because it is deliberately not
solved as a fixed point**:

```
offeredλ(t) = organicλ(t) + retryλ(t−1)          // back-edge reads the PREVIOUS tick
timeoutRate = λ · (1 − F_route(clientTimeoutMs))  // straight from the composed CDF
retryλ(t)   = (timeoutRate + errorRate) · min(maxAttempts−1, budgetFraction·λ/failures)
```

Because the back-edge lags one tick and station backlog is an integrator, the system
exhibits real metastable failure. A brief spike pushes ρ above 1 → latency exceeds the
client timeout → timeouts generate retries → retries raise λ → **the system stays
collapsed after the original spike has ended**. Nothing scripts this; it is emergent.

The player then discovers retry budgets, jittered backoff, circuit breakers and load
shedding, and watches the system actually recover. An entire act's curriculum comes out of
one lagged feedback edge.

Health checks work the same way. A prober `Controller` flips a station down after
`threshold` consecutive failed probes at `interval`, so detection lag is *visible* and the
player learns that `interval × threshold` is their minimum possible outage duration.
Failover then redistributes λ onto the survivors, which can push *them* over capacity —
teaching N+1 headroom with no special-case code at all.

---

## 10. Reference constants

Tuned to published figures rather than invented. These anchor the Phase 1 gate: **if the
engine cannot reproduce this table, the engine is wrong.**

| Quantity | Anchor | Source |
| --- | --- | --- |
| Speed in fiber | ~200,000 km/s (≈⅔ c) → ~1ms per 100km one-way | physics |
| Path detour factor | 1.4–1.8× great-circle | observed cable routing |
| Well-tuned edge hit ratio | 85–95%; >95% for static/video; <80% is a problem | [Gcore](https://gcore.com/learning/what-is-cache-hit-ratio) |
| CDN origin offload | 70–90% of traffic absorbed before origin during spikes | [Fastly](https://www.fastly.com/blog/origin-offload-a-measure-of-cdn-efficiency-for-reducing-egress-cost) |
| Shield request collapsing | ≥90% reduction in origin requests during a stampede | [CacheFly](https://kb.cachefly.com/kb/guide/en/origin-offload-with-origin-shielding-yQKBzr5zMk/Steps/4665583) |
| Hit-ratio economics | 90% → 95% **halves** origin traffic | [Optimi](https://optimi.com/en/guides/cdn-cost-optimization) |
| Handshake RTTs | TCP 1, TLS 1.3 1, TLS 1.2 2 | protocol specifications |

Two of these are lessons in themselves and are promoted to level mechanics:

**The last points are worth the most.** Going from 90% to 95% hit ratio halving origin load
is counterintuitive until you see it — origin load is `1 − h`, so the *remaining* miss
fraction is what halves. This is the payoff of level 10 and the reason level 12 (cache
keys) matters at all.

**Edge hit ratio and total hit ratio are different numbers with different jobs.** A system
at 70% edge + 20% shield is not the same as one at 90% edge, even though both report "90%".
The edge number drives user-visible latency; the combined number drives origin offload and
egress cost. The HUD therefore reports them separately from Act III onward, and level 15
is built on making the player notice the difference. The shield's cost — an extra hop on
every miss — is the tradeoff they must weigh against it.

---

## 11. Determinism

`simulate(topology, scenario, seed)` must return byte-identical metrics for identical
inputs. The mathematics above is already deterministic; the real risks are iteration order
and floating point.

1. **No shared mutable RNG.** Use a counter-based stateless generator keyed by purpose:
   `rng(seed, purpose, tick, index)` over splitmix64.

   This is the highest-leverage rule in the document. With a shared stream, adding a
   visual effect that consumes one random number silently shifts every grading number
   downstream of it — a bug that is nearly impossible to attribute weeks later. With
   purpose-keyed streams, `purpose:'viz'` *cannot* perturb `purpose:'route-sample'`, by
   construction rather than by discipline.

2. **Double-buffered state.** Read `prev`, write `next`; no read-your-own-writes within a
   tick. Flow propagation is the one in-tick exception and runs in a stable topological
   order over id-sorted nodes. Retry back-edges read `prev`, which is both physically
   correct and order-independent.

3. **Never iterate a `Map`, `Set` or plain object for anything affecting arithmetic.**
   Iterate pre-sorted `NodeId[]` arrays.

4. **Ban wall-clock and ambient randomness inside `@nb/sim`** with an oxlint
   `no-restricted-globals` rule covering `Math.random`, `Date`, `performance` and `crypto`.

5. **`ENGINE_VERSION`** is stamped into every `RunResult` and saved replay. Bump it on any
   change to the mathematics, and refuse to compare scores across versions.

6. **Cross-engine transcendentals.** IEEE-754 guarantees `+ − × ÷ sqrt` are bit-identical
   across V8, JavaScriptCore and SpiderMonkey. `Math.log`, `Math.exp` and `Math.pow` are
   **not specified** to be, and `invKernel` uses both. Mitigation: round graded metrics to
   4 significant figures before threshold comparison, and design SLO thresholds without
   razor-thin margins. Only if a shared leaderboard ever ships would vendoring our own
   `ln`/`exp` polynomial approximations for the grading path be worth the cost.

### Test strategy, in priority order

| Test | What it catches |
| --- | --- |
| **Shuffled-input identity** — rerun with node IDs, array order and edge insertion order permuted; results must be **bit-identical** | Iteration-order dependence. A plain repeat-run test misses this entirely, which is why it ranks first — this is the test that actually protects determinism |
| **Conservation** — each tick, `completed + errored + dropped + Δinflight == offered` within 1e-9 | Flow leaks |
| **Monotonicity properties** (fast-check) — adding capacity never raises p99; raising λ never lowers ρ; raising TTL never lowers hit ratio; adding a PoP never raises nearest-client propagation | Sign errors and formula typos. Finds real bugs far more often than snapshots do |
| **Analytic oracle** — a single M/M/1 station against textbook `−ln(1−q)/(µ−λ)`; a two-node chain against the hypoexponential | Wrong queueing mathematics |
| **DES oracle** — a throwaway token-level Monte Carlo over 10⁶ requests, **as a test fixture only**; engine percentiles must fall inside its 95% CI across ~12 canonical topologies | The fluid approximation lying. This is how we earn the right not to ship a discrete-event simulator |
| **Golden snapshots** — 30 topologies × 3 seeds → full `RunResult` JSON, diffed in CI | Unintended balance drift |
| **Content demonstrations** — see [`architecture.md`](architecture.md) §5 | Lessons quietly becoming false |

---

## 12. Run output

```ts
interface RunResult {
  engineVersion: string;
  inputHash: string;             // hash(topology ⊕ scenario ⊕ seed ⊕ catalogVersion)

  perClass: Record<ClassId, {
    p50Ms: number; p95Ms: number; p99Ms: number;
    throughputRps: number; errorRatePct: number; timeoutRatePct: number;
  }>;
  perRegion: Record<RegionId, ClassMetrics>;   // where the edge-network lesson lives
  perNode: Record<NodeId, { utilization: number; backlogPeak: number; dropRatePct: number }>;

  cacheHitRatioEdge: number;     // drives latency
  cacheHitRatioTotal: number;    // drives origin offload — see §10

  /** Required feature, not polish. See ROADMAP risk 1. */
  attribution: LatencyWaterfall; // {dns, tcpTls, propagation, queue, service, transfer}[]

  timeline: Float32Array;        // downsampled per-metric series, for charts and scrubbing
  cost: CostBreakdown;
}
```

**Cost is post-processing, not simulation.** `computeCost(catalog, topology, aggregates)`
is a pure function over run aggregates: GB egress *per edge* (CDN egress is cheaper than
origin egress, which is itself a lesson), request counts, vCPU-hours, cache storage.
Keeping it out of the tick loop means "what if traffic doubled?" can be answered without
re-simulating.

The `attribution` waterfall is called out as required because of the project's single
largest risk: if a player cannot answer *why* p99 moved from 90ms to 340ms, then all of
the fidelity above is worthless. Decomposing every run into named contributions — DNS
20ms, TCP+TLS 90ms, propagation 60ms, origin queue 140ms, service 30ms — is what converts
a simulation into a teaching instrument.
