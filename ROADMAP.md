# Roadmap

How Network Builder gets built, in what order, and what has to be true before each step
proceeds. The level-by-level detail lives in [`docs/content-spine.md`](docs/content-spine.md);
the mathematics in [`docs/simulation-model.md`](docs/simulation-model.md); the code
structure in [`docs/architecture.md`](docs/architecture.md).

---

## 1. The product

**You build a delivery network on a canvas, send real-shaped traffic through it, and are
graded on latency, error rate and cost — then the game breaks it.**

Three surfaces sit on one simulation:

**Campaign** — ~41 levels across six acts. Each introduces exactly one concept against a
fixed SLO and budget. Graded out of three stars: SLO met, under budget, survives the
level's chaos event.

**Chaos** — five set-piece incidents, each run against *the topology the player built* in
the preceding act. This is the detail that matters: it is not a separate map with a
pre-made cluster on it. When the fiber cut lands on the PoPs you chose and placed
yourself, the failure is legible in a way a stranger's topology never is.

**Console** — a terminal drawer that unlocks progressively, where the player runs the real
commands that inspect what they just built. `dig` and `curl -sI` after Act I, `traceroute`
after Act IV, `kubectl` after Act V, `openssl s_client` after Act VI. It reads live
simulation state, so the output always agrees with the canvas. This is the bridge from
game to job, and it is why the game is worth playing rather than just reading about.

### Difficulty tiers

One content spine, surfaced at two depths, written once:

- Every concept card has a **plain layer** (always shown) and a **deep-dive layer**
  (collapsed, opt-in) carrying the interview-grade vocabulary — tail latency, blast
  radius, read-after-write, Erlang C, coordination cost.
- The tier scales the *targets*, not the prose. **Explorer** grades on SLO only.
  **Engineer** adds budget and a chaos event. **Architect** adds a hidden constraint: a
  region loses capacity mid-run, or the budget drops 30% after you have already built.

This is what lets the same level serve someone who has never owned infrastructure and
someone preparing for a system design interview, without writing two games.

---

## 2. The content spine

Six acts. Each level is named for the lesson, not the component.

| Act | Levels | Arc | Chaos set-piece |
| --- | --- | --- | --- |
| **I — The Request** | 4 | One origin. The request waterfall, and distance as a budget | — |
| **II — The Local Site** | 5 | Load balancing, health checks, session state, pooling, the DB bottleneck | Peak Day: 10× traffic |
| **III — Caching** | 7 | Hit ratio, TTLs, cache keys, stampedes, origin shield, purge | Mass expiry |
| **IV — Going Global** | 6 | Many PoPs, GeoDNS, anycast, failover, replication, steering | Fiber cut |
| **V — Containers** | 10 | Pods, services, ingress, probes, limits, HPA, rollouts, state | Bad deploy |
| **VI — Security** | 9 | TLS, WAF, rate limiting, DDoS, zero trust, segmentation, supply chain | Breach drill |

Acts I–IV are a complete, shippable game about delivery networks. Acts V and VI are
expansions, not prerequisites — which is what makes the scope survivable.

Full level list with SLOs, mechanics and the claims CI enforces:
[`docs/content-spine.md`](docs/content-spine.md).

---

## 3. Delivery phases

Sequenced so the riskiest thing is proven first.

| Phase | Outcome | Gate before proceeding |
| --- | --- | --- |
| **0 — Design** | Roadmap, simulation model, content spine, architecture, ADRs | Design reviewed and agreed |
| **1 — Engine core** ✅ | `@nb/schema` + `@nb/sim`: station, tick loop, Erlang/Allen–Cunneen, latency kernels, route probes. Headless, with analytic and DES oracle tests. **No UI at all** | Act I numbers are defensible and deterministic |
| **2 — Catalog + determinism harness** ✅ | Six component types with ports and costs; shuffle, conservation, monotonicity and golden-snapshot tests. Plus the throwaway HPA spike (below) | Shuffled-input runs are bit-identical |
| **3 — Vertical slice** ← *next* | `apps/game`: React Flow editor, validation, canvas packet overlay, one hardcoded level | The loop is *fun*, not merely correct — [18 criteria](docs/quality-gates.md) |
| **4 — Content harness + Act I** | `defineLevel`, zod validation, the `explains`/`demonstrations` CI checks, [derived hints](docs/content-spine.md), levels 1–4 | A lesson cannot silently become false, and no advice is written for a player who does not exist |
| **5 — Grading + attribution** | Latency attribution waterfall, run-to-run diff, star grading | "Why did p99 move?" is answerable at a glance |
| **6 — Act II + Chaos 1** | First chaos set-piece, on the player's own topology | Chaos reads as consequence, not a new game |
| **7 — Act III** | Caching — the densest and most valuable act | Hit-ratio maths reads as true to a reviewer |
| **8 — Act IV + map view** | The global act; geography becomes visible | **Acts I–IV ship as a complete product** |
| **9 — Console v1** | Terminal drawer over live simulation state | — |
| **10 — Act V, then Act VI** | Kubernetes, then security | — |
| **11 — Polish** | Difficulty tiers, persistence, sandbox mode | — |

### The two gates that matter

**Phase 1 is the real gate.** If the engine cannot produce believable Act I numbers
headlessly, in Node, with no canvas in sight, then no amount of UI rescues the project.
Putting it first surfaces that in week one rather than month three. The engine is
therefore built and tested with zero rendering — the first thing that exists is a function
you can call from a test and argue with.

**The HPA spike was pulled forward into Phase 2** rather than waiting for Act V, as the
cheapest available insurance against discovering in month four that Kubernetes needs a
different engine.

**Result: the abstraction held.** An HPA turned out to be a function that adjusts `servers`
with lag. It needed one seam — `applyControllers`, called at the end of a station's tick —
and no new simulation primitive. Measured response lag is exactly `metricWindowSec +
podStartSec`, which is the quantity level 29 is built on. It also reproduced the lesson
that matters: against an 800 rps spike, a tightly tuned autoscaler starting at 6 replicas
gives 61% errors and a 49-second p99, while a floor of 24 replicas gives 0% and 95ms. No
amount of tuning conjures capacity that does not yet exist.

Because it works, it is kept rather than thrown away — it is Act V level 29, arriving early.

---

## 4. Risks

| Risk | Mitigation |
| --- | --- |
| **The numbers feel arbitrary, so players flail instead of learning.** The most likely cause of death, and a design risk rather than a technical one | The latency attribution waterfall is built **before level 3**, not as polish. Every run decomposes p99 into named contributions — DNS 20ms / TCP+TLS 90ms / propagation 60ms / origin queue 140ms — plus a diff against the previous attempt. "I understand why" is a P0 acceptance criterion for every level |
| **Scope explosion.** CDN, Kubernetes and security are each a semester, and the game layer is a fourth project | Acts are independently shippable; I–IV alone are a complete product. The station abstraction exists so later acts are additive, and the Phase 2 spike proves that early |
| **Balance and solvability rot.** One tuned constant silently breaks fifteen levels' lessons | Per-level reference solutions (a gold that must pass, a knownBad that must fail), `demonstrations` asserting each lesson's claim, and `explains` registry checks. Built alongside level 2, not level 20 |
| **Determinism regressions.** Someone adds `Math.random()` for a sparkle and replays stop reproducing — noticed weeks later | Purpose-keyed stateless PRNG so a visual stream *cannot* perturb grading; a lint ban on ambient randomness and clocks inside the engine; the shuffled-input bit-identity test |
| **Performance cliff** from React re-rendering on every simulation tick | Packets never touch React: canvas overlay, typed arrays, imperative viewport reads. Plus a CI assertion capping React commits per simulated second |
| **The fluid approximation is visibly wrong at very low rates** | Author level traffic at a few hundred rps and up; use the DES oracle to find where the approximation degrades and document that boundary honestly |

---

## 5. How work is delivered

The repo is part of the learning, so its history is a deliverable. One PR per coherent
concept, on its own branch, 5–7 atomic commits each. PR descriptions open with what
concept is being added and why. ADRs record what was rejected, not just what was chosen.

See [`CLAUDE.md`](CLAUDE.md) for the full conventions.
