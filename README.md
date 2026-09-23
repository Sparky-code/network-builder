# Network Builder

**A browser game that teaches you to build scalable networks — from one server in one
room to a global edge network, then to containers, then to defending it.**

You place infrastructure on a canvas, wire it together, send real-shaped traffic through
it, and get graded on latency, error rate and cost. Then the game breaks it and asks you
to keep it running.

```
  place & wire components  →  ▶ RUN TRAFFIC  →  metrics + attribution waterfall
          ↑                                                ↓
          └──────  post-mortem: why the numbers moved  ─────┘
```

> **Status: pre-implementation.** This repository currently contains the design only —
> roadmap, simulation model, content spine and architecture decisions. No engine, no app.
> The documents are deliberately detailed enough to be argued with before any code is
> written, because the simulation model is the thing that decides whether this works.

## Why this exists

Most engineers learn the delivery path by absorbing it — a cache here, a load balancer
there, an origin shield someone else configured years ago. The pieces get cargo-culted
because the feedback loop is too slow and too expensive to experiment with. You cannot
casually try "what if we removed the shield" against production.

### What already exists

The build-simulate-grade format is **not novel, and that is worth stating plainly.**
Several tools already do a version of it well:

| Tool | What it does | Where it stops |
| --- | --- | --- |
| [systemdesignsim.com](https://systemdesignsim.com/) | Drag components, wire, send live traffic, graded against SLOs and cost budgets across 7 progressive challenges, with chaos injection | No edge/CDN depth, no Kubernetes, no security; emphasises experimentation over instruction |
| [paperdraw.dev](https://paperdraw.dev) | Sandbox drag-and-drop with live latency/error/throughput/cache metrics and chaos switches | Sandbox only — no curriculum, levels or grading |
| [k8sgames](https://k8sgames.com/) | Kubernetes as a playable 3D cluster with real `kubectl`, campaign and chaos modes | Kubernetes only; nothing upstream of the cluster |
| [packetlab.io](https://packetlab.io/) | **325 scenarios** with a prerequisite graph, covering essentially this entire curriculum — `cdn-origin-shield`, `geodns-anycast`, `load-balancer-health-checks`, `kubernetes-ingress`, `service-mesh-mtls`, `zero-trust`. Step-through animated explainers with clickable packets | You watch, you do not build. Controls are play/step/reset on an authored, fixed topology — no components to place, no parameters to change, nothing graded. Most edge and security scenarios are paywalled |

That the format keeps being independently reinvented is a signal it works. Treating it as
unclaimed territory would have been wrong.

### What is actually unclaimed

Neither the format nor the topic list is novel. **The combination is.**

The prior art splits cleanly along one axis — *depth of subject* versus *agency of the
learner* — and nothing occupies both corners:

```
                    depth of subject matter
                    shallow            deep
                  ┌─────────────────┬─────────────────┐
     you build    │ systemdesignsim │                 │
     and are      │ paperdraw       │   ← empty →     │
     graded       │ k8sgames (k8s)  │                 │
                  ├─────────────────┼─────────────────┤
     you watch    │                 │ packetlab       │
     or read      │                 │ (325 scenarios) │
                  └─────────────────┴─────────────────┘
```

Packetlab already explains origin shields, GeoDNS versus anycast, health-check behaviour,
service-mesh mTLS and Kubernetes ingress — more topics than this roadmap lists. But its
controls are play, step and reset over a fixed authored diagram. You cannot place a
shield, get it wrong, and watch your origin melt. systemdesignsim gives you exactly that
agency, but over components with no interior: a "CDN" is one box with a hit-ratio dial.

The bet is that **consequence is what makes these concepts stick**. Reading that splitting
traffic across PoPs lowers per-PoP hit ratio is a fact you forget. Watching your own
origin load climb *after you added PoPs to make things faster*, then discovering the
shield that fixes it, is a thing you keep.

Three things follow from occupying that corner:

**The edge path has an interior.** Acts III and IV are thirteen levels on what is inside
the box other builders draw as "CDN" — TTL against staleness, key cardinality, stampede
and coalescing, shield re-aggregation, edge hit ratio versus total hit ratio as two
numbers with different jobs.

**One topology across three domains.** Network, then containers, then security, built so
the continuities are structural rather than asserted. An Ingress genuinely *is* the load
balancer from Act II, re-parameterised. Scenario libraries teach these as separate
entries; here they are the same object seen again.

**A simulation you can audit.** Fluid flow with Erlang C and Allen–Cunneen queueing,
Whitt variance propagation, exact TTL-cache renewal maths, validated against a
discrete-event oracle and anchored to published figures — see
[`docs/simulation-model.md`](docs/simulation-model.md). Consequence only teaches if the
consequences are right, which is why the model is documented well enough to be argued
with.

## The design bet

Two decisions carry the whole project, and both are documented with their rejected
alternatives:

**The simulation is fluid, not discrete-event.** It models flow rates on edges rather than
individual requests, integrated over ticks, with closed-form queueing kernels composed
along routes. Simulating every request would need ~10⁵ completions for a stable p99 —
seconds per run, and enough sampling noise that two identical topologies land on opposite
sides of a pass/fail threshold. A pure steady-state solver is instant but has no *time*,
so it cannot teach autoscaler lag, cache warm-up or retry storms — which are exactly the
later curriculum. Fluid gets sub-30ms runs, zero grading noise, and honest transients.
See [ADR 0001](docs/adr/0001-fluid-simulation-over-discrete-event.md).

**Everything is one abstraction: `Station` + `Policy` + `Controller`.** A Kubernetes pod
is a station whose concurrency is its replica count; an HPA is a controller mutating that
number with deliberate lag; mTLS is a protocol profile adding a round trip. If this holds,
the later acts are additive. If it does not, they are a rewrite — so five specific
commitments are made on day one to keep it holding.
See [ADR 0002](docs/adr/0002-station-policy-controller-abstraction.md).

## How to read this repo

Start with the roadmap, then go as deep as you want:

| Document | What it covers |
| --- | --- |
| [`ROADMAP.md`](ROADMAP.md) | The product, the six-act content spine, and the delivery phasing |
| [`docs/simulation-model.md`](docs/simulation-model.md) | The queueing and sampling mathematics, written to be challenged |
| [`docs/content-spine.md`](docs/content-spine.md) | All 41 levels — the concept, mechanic, SLO and the claim CI enforces |
| [`docs/architecture.md`](docs/architecture.md) | Packages, topology model, port-based validation, rendering, authoring |
| [`docs/adr/`](docs/adr/) | Three decisions, each with what was rejected and why |

The commit history is meant to be read the same way. Each PR covers one coherent concept
in 5–7 atomic commits, and PR descriptions explain what is being added and why rather than
listing what changed.

## What the game teaches

Six acts, each introducing one concept per level:

1. **The Request** — the DNS/TCP/TLS/HTTP waterfall, and why distance is a budget
2. **The Local Site** — load balancing, health checks, session state, connection pooling
3. **Caching** — TTLs, cache keys, stampedes, origin shields
4. **Going Global** — many PoPs, GeoDNS vs anycast, failover, replication and consistency
5. **Containers** — pods, services, probes, autoscaling, rollouts
6. **Security** — TLS, WAF, rate limiting, DDoS, zero trust, segmentation, supply chain

Plus **Chaos** set-pieces that break the topology you personally built, and a **Console**
that unlocks the real commands (`dig`, `curl -sI`, `kubectl`, `openssl s_client`) for
inspecting what you made — reading live simulation state, so the output always agrees with
the canvas.

Some of the best lessons fall out of the mathematics rather than being scripted. Adding
PoPs *lowers* your cache hit ratio, because each one sees a fraction of the traffic and
amortises fewer misses per TTL window — which is exactly why origin shields exist. Moving
from a 90% to a 95% hit ratio *halves* origin load. A database at 60% utilization can
queue worse than an app server at 85%, because service-time variance matters more than
utilization. None of these are special-cased; they emerge, which is what makes them worth
learning here.

## License

MIT — see [LICENSE](LICENSE).
