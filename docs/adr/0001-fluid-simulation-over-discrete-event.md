# ADR 0001 — Fluid simulation over discrete-event

**Status:** Accepted · 2026-09-22
**Context:** Phase 0 design, before any engine code exists.

## Context

The game grades players on p50/p95/p99 latency, error rate, cache hit ratio and cost, and
shows animated packets moving through their topology. Two requirements pull in opposite
directions:

- **Grading must be stable.** The same topology must produce the same verdict every time,
  or passing becomes a matter of retrying until the dice land well.
- **The teaching loop must be fast.** The game's pedagogy *is* the what-if cycle: change
  one thing, re-run, see what moved. A run that takes seconds converts an experimenter
  into a guesser.

There is also a third requirement that only becomes visible when looking past Act IV: half
the later curriculum is *transient* behaviour — autoscaler lag, cache warm-up, health-check
detection delay, rolling-deploy capacity dips, retry-storm metastability.

## Decision

Build a **tick-integrated fluid simulator with closed-form latency kernels**. The unit of
simulation is a flow rate (req/s) on an edge, not a request. Time advances in fixed ticks
of 20–40ms simulated; within a tick the system is treated as steady state, and across
ticks the stateful quantities integrate.

End-to-end percentiles come from composing per-station invertible CDFs along each route,
evaluated at a **fixed stratified probe set** of 256 compiled low-discrepancy vectors.

Animated packets are a **sampled projection of flow state for the view only**, drawn from
the same distributions the grader used.

## Alternatives considered

### Token-level discrete-event simulation — rejected

The intuitive choice: simulate each request as a sequence of events. Rejected on two
independent grounds.

**Too slow.** A stable p99 needs ~10⁴–10⁵ completions. A level at 10k rps for 60 simulated
seconds is ~600k requests at roughly 20 events each — 12 million events, seconds per run
in JavaScript. That kills the what-if loop.

**Too noisy.** Worse than slow, and less obvious: a Monte Carlo p99 carries sampling error.
The same topology run twice lands on different sides of a pass/fail threshold, precisely
at the boundary where the interesting levels live. A player who passes on the third
identical attempt learns that the game is arbitrary.

### Pure analytic steady-state — rejected

Solving the network once as a Jackson-style queueing network is instant and perfectly
stable. It also has **no time**. Every transient in Acts II, V and VI becomes
inexpressible, and those transients are not garnish — they are the curriculum. A
steady-state solver can tell you an autoscaled system is fine; it cannot show you the 40
seconds during which it was not.

### Monte Carlo path sampling with a seeded PRNG — rejected

An intermediate option: keep the analytic per-hop model but sample ~2000 random paths for
percentiles. Deterministic given a seed, and much faster than full DES.

Rejected because determinism is not the only property needed — **smoothness** is. Random
sampling makes percentiles jump discontinuously under small topology changes, so a player
who adds one replica sees p99 move for reasons unrelated to their change. The fixed
stratified probe set is deterministic *and* continuous, at the same cost.

## Consequences

**Good.** Sub-30ms runs. Zero sampling noise in grading. Honest transients. Animation that
is statistically faithful rather than decorative, because packets are drawn from the
graded distributions — when a station saturates, packets pile up because the backlog state
variable is genuinely growing.

**Costly.** We must be comfortable with queueing approximations: Erlang C, Allen–Cunneen,
Whitt's variance propagation. That is roughly 150 lines of well-known mathematics, and it
demands a test strategy that proves the approximation is not lying.

**The mitigation for that cost:** a token-level discrete-event Monte Carlo is written
anyway — as a **test fixture only**. Engine percentiles must fall inside its 95% confidence
interval across ~12 canonical topologies. We do not ship a DES; we use one to earn the
right not to.

**Known limitation, accepted.** Fluid/mean-field descriptions degrade at low arrival rates.
At ~5 rps the smooth abstraction does not match what a player would intuit from watching
individual arrivals. Mitigation: author level traffic at a few hundred rps and above, and
use the DES oracle to *measure* where drift begins rather than assuming a boundary.
