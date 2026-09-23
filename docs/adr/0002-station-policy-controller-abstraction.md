# ADR 0002 — One abstraction: Station + Policy + Controller

**Status:** Accepted · 2026-09-22
**Context:** Phase 0 design. Depends on [ADR 0001](0001-fluid-simulation-over-discrete-event.md).

## Context

The game spans three domains that are usually taught separately: edge delivery networks,
container orchestration, and security. Roughly 41 levels across six acts.

The obvious risk is that each domain wants its own engine. If Act V needs a Kubernetes
simulator distinct from the CDN simulator, the project is really three projects, and the
third one is never finished. The question this ADR answers is whether one simulation
abstraction can carry all three — and what it costs to keep that true.

## Decision

Everything the player can place is a **`Station`**, carrying:

- `servers` (concurrency), `serviceMeanMs`, `serviceCv2`, `queueLimit`
- `admission: AdmissionPolicy[]` — rate limiting, WAF filtering, shedding, circuit breaking
- `routing: RoutingPolicy` — terminal, weighted, hash, cache-split, fanout
- `controllers: Controller[]` — HPA, readiness gating, health probing, deploy control
- per-tick state: `backlogReqs`, `health`, `warmth`

`@nb/sim` knows these three concepts and nothing else. It does not know what a CDN is, or
a pod, or a WAF. `@nb/catalog` is the sole place where game concepts map onto them.

**Later acts are re-parameterisations, not extensions:**

- a Kubernetes pod is a station whose `servers` is its replica count;
- an HPA is a `Controller` mutating `servers` with deliberate lag;
- a readiness probe is a `Controller` gating whether the station is in the routing set;
- a rolling deploy is two versions sharing traffic by weight with `servers` shifting;
- mTLS is a `ProtocolProfile` adding a round trip and crypto CPU;
- a WAF is added service time plus a drop rule;
- segmentation is an edge-legality rule the graph validator already enforces.

**Kubernetes needs exactly one new primitive**: a `ResourcePool` that a scheduler bin-packs
pods into, producing the "pending pod because the cluster is full" lesson. The field is
declared on day one, implemented in Act V. **Security needs none.**

## The five day-one commitments

The abstraction survives **if and only if** these are true from the first commit. Each is a
rewrite if deferred — and each is genuinely unnecessary for Act I, which is exactly why
they are written down. The temptation to postpone them will be reasonable at the time.

1. **`servers` is mutable state driven by a `Controller`, never a config constant.**
   Otherwise autoscaling, rolling deploys and readiness gating all become special cases
   bolted onto the engine.
2. **Traffic classes exist from level 1.** Without them a cache cannot be modelled honestly
   (a CDN fronting 100% dynamic traffic should get ~0% hits), nor a WAF that correctly
   identifies only part of an attack.
3. **Edges carry links with protocol profiles and RTT counts.** Handshake cost is a
   property of the link. Making it a node property means rewriting every security level.
4. **Flow is a vector over classes, not a scalar.** Scalarising now means touching every
   formula later.
5. **Latency is a distribution object, not a number.** A mean cannot be composed into a
   believable p99, and retrofitting distributions through a scalar engine is a full
   rewrite of the metrics path.

## Alternatives considered

### Per-domain engines — rejected

A CDN simulator, a cluster simulator, a security layer. Honest about the domains being
genuinely different, and it would let each be modelled at its natural fidelity.

Rejected because it triples the engineering and, worse, it **destroys the pedagogy**. The
single best thing this game can teach is that an Ingress *is* the load balancer from Act
II, that a pod replica count *is* "more boxes" from level 4, that mTLS is the same
handshake cost from level 8 charged on every internal hop. Separate engines would make
those identities invisible — the player would learn three vocabularies instead of one
model.

### A plugin/extension system on a minimal core — rejected

Keep the engine tiny and let each act register its own node behaviours.

Rejected as the same problem wearing better clothes. Extension points defined before the
extensions exist are guesses, and the ones that turn out wrong are more expensive to
change than a plain abstraction, because plugins have already been written against them.

### Deferring the five commitments until needed — rejected

Build Act I with scalar flow and constant concurrency, generalise when Act V arrives.

Rejected because each of the five is cheap now and structural later. Traffic classes cost
a type parameter today; adding them in month four means revisiting every formula, every
test fixture and every authored level. This ADR exists largely to make that argument
durable, so a future reader does not re-litigate it under deadline pressure.

## Consequences

**Good.** One engine, one mental model, and later acts genuinely add content rather than
machinery. The cross-domain identities the game most wants to teach are structural facts
about the code rather than claims in prose.

**Costly.** Act I is built with machinery it does not need. Levels 1–4 would be simpler
with scalar flow and fixed concurrency, and a reviewer of the Phase 1 engine will
reasonably ask why it is so general.

**Verification, deliberately early.** The claim is tested in **Phase 2** — immediately
after the engine works — with a throwaway HPA spike: one `Controller` mutating `servers`
with lag. It costs about a day and is then shelved until Act V. If the abstraction cannot
absorb autoscaling, that is the cheapest possible moment to find out. Discovering it in
month four, with four acts of content already authored, is the single most expensive
failure available to this project.
