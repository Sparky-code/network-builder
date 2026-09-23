# Screens, layers, and the load envelope

A design review of three proposals: a layer explorer, a command centre, and background
load with peak periods. Reviewed by four passes — information architecture, visual
language and stack, a codebase readiness audit, and my own — with the engine findings
independently reproduced.

**Conclusion up front:** the load-envelope idea is the strongest of the three and should
come first, because it is what gives the command centre a reason to exist. The layer
explorer's *shape* is right and its *axis* is wrong. Three engine defects block the work,
one of which is a hard crash.

---

## 1. Playback should not loop — and the reason is now better

Runs already play once and hold, which was done to make recovery legible. The load-envelope
framing justifies it better: if real systems have a **baseline with peaks on top**, then a
run is a *period with a shape*. A period that silently restarts is not a period, it is a
treadmill.

This also reframes what a traffic profile is. Today a demand carries one `RateProfile`.
What is actually wanted is **composition** — background load, plus a diurnal cycle, plus
spikes of distinct character.

Good news from the audit: **demands of the same class already sum.** Baseline-plus-peak
works today by stacking two `Demand` entries, verified by running it, not by reading it.
No new union member is needed for the common case.

---

## 2. The layer explorer: right shape, wrong axis

### L0–L7 is a mistake, not a preference

Counting the 41 levels in `content-spine.md` by OSI layer:

| Layer | Levels |
| --- | --- |
| L1 | ~2 (speed of light, fiber cut) |
| **L2** | **0** |
| L3 | ~2 |
| L4 | ~3 |
| L5 / L6 | ~0 |
| L7 | **30+** |

And Act V and most of Act VI — Kubernetes scheduling, RBAC, image signing, observability —
have no OSI layer at all.

Seven equal columns advertise seven equal bodies of content. The curriculum is roughly 75%
one column plus two orphan domains. Empty columns read as an unfinished game, and players
notice them immediately.

### Use the latency waterfall as the axis instead

The `LatencyWaterfall` in the metrics contract — DNS, setup, propagation, queue, service,
transfer — is already the project's central instrument, already CI-enforced, and is
literally *the request's journey*. Traffic enters from the left exactly as the sketch
draws it.

Expanded to the tiers the game actually teaches:

```
Client → Resolution & steering → Transport & session → Edge (cache/PoP/WAF)
       → Mid-tier (shield) → Entry (LB/Ingress) → Compute (pods) → Data (DB/state)
```

Eight columns, every one of the 41 levels has a natural home, and — the decisive property —
**each column is a measurable quantity in every run.** Clicking a column can filter its
levels, terms and components *and* highlight its contribution in your last run.

That is the difference between a diagram and an instrument, and it is the whole argument.

### Where the layered model does belong

The objection above is to L0–L7 as the **navigation spine**, not to teaching it. The layered
model is worth teaching properly, and it lands in three places:

**1. A primer, before Act I.** A short pre-read — one card per layer — covering what the
layer is, one concrete artifact a reader has met, and whether this game goes there. Roughly
seven cards, readable in a few minutes, skippable by anyone who already knows it.

The primer should be **honest about its own sparseness**, because that is better teaching
than pretending otherwise:

| | Layer | This game |
| --- | --- | --- |
| L0 | The medium — fiber, copper, radio | Yes: the speed-of-light budget is literally L0 |
| L1 | Physical signalling | Touched, via propagation delay |
| L2 | Framing and switching | **No** — this game is about delivery, not switching |
| L3 | Routing and addressing | Yes: anycast, BGP, GeoDNS |
| L4 | Transport, ports, connections | Yes: TCP handshakes, load balancing, pooling |
| L5 / L6 | Session and presentation | **Barely exist in practice** — say so |
| L7 | Application | Most of the game: HTTP, caching, TLS, everything above |

That L5 and L6 are near-empty is not a gap in the curriculum, it is a fact about the model:
OSI is a *teaching* abstraction, and the TCP/IP stack that actually runs has four layers, not
seven. A player who learns that has learned something real, and it explains the shape of the
table above rather than apologising for it.

**2. An alternate lens in the explorer.** Because the explorer is generated from tags, adding
an `osiLayer` tag alongside the column tag gives a second lens over the same content for
free — a toggle between *the request's journey* and *the layered model*. In a reference view
a sparse layer is informative; it was only as a campaign map that empty columns read as
unfinished.

**3. A footnote on levels that earn it.** Level 5 should say "this is the L4 versus L7
distinction", because interviewers use those words and a player should not be ambushed by
them.

The line that reconciles the two axes, and which the primer should probably end on:

> **Layers tell you what a thing *is*. The waterfall tells you *when it happens* to your
> request.**

One is a taxonomy, the other is a timeline. Both are true; only one of them is a route
through a curriculum.

### Generate the explorer; do not author it

Tag levels, lessons and components with column ids and **derive** the explorer from the
existing registries (`METRIC_REGISTRY`, `PARAM_REGISTRY`, `explains`, `demonstrations`,
`learnMoreId`). Two hand-authored hierarchies over one body of content is the classic way
an educational project rots — and this repo already built the antidote for exactly this
reason. A generated index cannot contain a level the campaign lacks, and CI already fails
by name when a reference breaks.

### Rejected alternatives

- **Layers as the campaign spine.** Breaks Chaos, which is defined as running against the
  topology *the player built in the preceding act*. A taxonomy has no "preceding".
- **Layers as the navigation shell.** Worst option: it forces every level into one home
  layer, but the best levels are *about interactions between* layers — anycast is L3
  routing arbitrated by an L7 resolver TTL. Single assignment guarantees an L8 junk drawer.

---

## 3. The command centre: a second mode, not a third screen

Build answers *"why did p99 move in the run I just watched?"* There is exactly one question
it structurally cannot answer, and the background-load idea is what creates it:

> **Is this system right across the whole load envelope, not just the run I watched?**

Contents derived from that job, in priority order:

1. **The load envelope** as a scrubbable band — baseline, peaks, events — with grading shown
   **per window**.
2. **Headroom** as the headline, not total $/month.
3. **Cost at baseline versus at peak** — what you pay for idle insurance.
4. **Run-to-run diff.** This is quality-gate criterion **A2**, currently a hard fail.
5. **Per-region breakdown** — the map's actual job.

### Three corrections to the sketch

- **The terminal should not be a pop-out modal.** The Console's entire value is that its
  output agrees with the canvas in front of you. A modal covering the canvas destroys the
  thing that makes it worth having. Keep it a drawer, available in both modes.
- **The globe loses to the flat map** on information density: it hides half your PoPs at all
  times and cannot sit beside a per-region table. The sketch already labels it "alt" — that
  instinct was right. Make it a late cosmetic mode, not a fixture.
- **The map is decoration until Act IV**, which is where the roadmap already schedules it.

---

## 4. Navigation: one shell, two modes, one overlay

- **Shell** = level context. `Build` and `Review` are tabs on the same route reading the same
  store. No router needed yet.
- **Codex is a sheet, not a route.** It is always entered from a question — a refused
  connection's `learnMoreId`, a term in a brief, a column in the explorer. Stackable,
  dismissible, returns you to the exact pixel. Give it a route and you invite players to
  navigate *to* it, which is reading rather than playing.
- **Shared state:** topology, layout, diagnostics, result, and critically the **playhead** —
  switching modes must not stop playback. Review must never call `simulate` itself; a second
  grading path is how numbers start disagreeing.
- **Persists:** per-level best grade, best cost, and the topology that achieved it — required
  by criterion F3, "a reason to try again".

---

## 5. Three engine defects, all reproduced

These block the work and are not speculative.

### A day-long run crashes

```
RangeError: Invalid array length
  at pool (packages/sim/src/pooled.ts:37)
  at metricsFor (packages/sim/src/engine.ts:485)
```

Reproduced at `durationSec: 86400`, throwing after 42.2s. Cause: `popsByClass` and
`popsByRegion` accumulate a 256-value population per sampling point, per route, per class,
**for the entire run**, and `pool()` allocates one array over all of them at the end. At two
sampling points per simulated second that is ~172,800 points over 24 hours.

Note the irony: the per-frame percentile path a few lines above already pools only the
current sampling point — that was fixed when it made a 20-second run take 60 seconds. The
whole-run path kept the original shape.

Scaling is otherwise linear at ~0.76ms per simulated second: 30s → 26ms, 300s → 213ms,
1h → 2.7s. Interactive up to a few minutes; nowhere near a day.

**Fix:** an O(1)-in-duration percentile accumulator (fixed-bucket weighted CDF) plus frame
decimation. This changes reported percentiles slightly, so it must land *before* any golden
snapshots are authored against diurnal levels.

### `perRegion` reports the wrong class

```ts
for (const regionKey of [...popsByRegion.keys()].sort()) {
  const first = classes[0];              // every region, always class zero
```

Any multi-class scenario silently reports the first class's percentiles for every region,
unlike `perClass` which is correctly keyed. A "latency by region" panel would be wrong the
day it shipped.

### Cost extrapolation breaks under diurnal load

`computeCost` scales the measured window to a month by `SECONDS_PER_MONTH / simulatedSeconds`.
A 120-second window of a 24-hour sinusoid produces a wildly wrong bill unless the window is a
whole number of periods.

### Two profile-composition rough edges

- `spike` carries its own `baseRps`, which double-counts the moment it is stacked on a
  baseline — `level.ts` already works around this by hand.
- `ramp` normalises to `scenario.durationSec`, so it cannot be windowed.

Fix both with composable envelopes carrying `startSec`/`endSec`, or a
`{ kind: 'sum', of: RateProfile[] }` member.

---

## 6. The grading consequence, which is the important one

**A run-wide p99 is the wrong statistic once there is a baseline.** If 80% of a run is quiet,
the quiet part dominates the percentile and the peak — the only part that matters — becomes
invisible.

Grade **per named window**, baseline and peak stated separately.

This is also a real lesson worth teaching outright: *"p99 over the day" is exactly how teams
hide a broken peak.*

### Not every level should gain a baseline

Levels 1–4 teach the instrument; level 3 is literally a ρ slider, and a baseline adds noise
to the one variable under test. Baselines from Act II onward, where headroom becomes the
subject.

**Improved by a baseline:** 9 (database variance), 11 and 14 (TTL jitter against diurnal
expiry beats a scripted synchronised expiry), 20 (failover at peak versus trough *is* the
lesson), 29 (HPA lag is defined by rate of change, so a diurnal ramp is the correct stimulus —
a step spike overstates the difficulty), 34–35 (attack layered on peak).

**Must stay clean:** 1, 2, 4, 12, and the identity levels 24 and 26, which compare two
topologies and need identical stimulus for the "these are the same thing" claim to hold.

### Frame it as an envelope, not a clock

Time-of-day as a clock is the weaker framing. The stronger one is **a load envelope the
player designs against, drawn as a band rather than a line**: *provision for the peak, pay for
the trough.* That is the honest economic bridge into Act V's autoscaling.

---

## 7. Art direction: "Bench Instrument"

The Grafana-versus-game tension is false. Both want the same thing from opposite directions:
Grafana wants **legible truth**, a game wants **felt consequence**. The resolution is a
physical metaphor — the app is a piece of lab equipment you patch, load, and watch fail.

The right ancestor is the **modular-synth patchbay plus oscilloscope**, with Zachtronics'
SHENZHEN I/O as proof that hardware-datasheet aesthetics can be warm, dense and entirely
diagrammatic. It fits because the subject genuinely *is* signal flow through modules with
finite capacity.

Explicitly not: mission control (reverent, all authority and no agency), hacking fiction
(green-on-black is the most corporate "non-corporate" look available), or factory sims (their
pleasure is accumulation; ours is diagnosis).

Two registers from one system:

- **Instrument** — canvas, metrics, command centre. Graticule substrate instead of empty
  ground, hairlines and recessed wells instead of floating cards, monospace numerals, needles
  and tanks that settle rather than snap, and one hot "signal" hue reserved for live traffic
  and nothing else.
- **Manual** — layer explorer, lessons, refusals. Annotated field-manual plates: drawn,
  labelled *on* the drawing, callout leader lines, warm paper in light theme.

### The governing rule: no ornament that isn't a readout

This is also the answer to the corporate-infographic question. From the reference image:

| Keep — why it is legible | Drop — why it is corporate |
| --- | --- |
| Labels on the artwork itself | Isometric buildings encoding nothing |
| One connector = one relationship | A drop-shadowed "THE CLOUD" blob |
| Consistent icon vocabulary | Stock device icons |
| Spatial grouping of domains | Brand teal-and-orange pairing |
| Two hues plus grey | **Zero numbers anywhere** |

*Illustration that measures something is not corporate. Illustration that decorates always
is.* Plates should be drawn to schematic scale, with size, fill and position encoding
quantity, and bound to live run data through `data-bind` text nodes written from the existing
10Hz store — so a plate shows *your* run's figures.

### Six token additions, each load-bearing

1. **`--color-signal` / `--color-signal-dim`.** Live traffic currently uses `--color-primary` —
   the same blue as the Run button. Traffic reading as UI chrome is probably the single
   largest contributor to "boilerplate", and a hue reserved for *things moving* is the
   cheapest character win available.
2. **`--chart-series-1…6`.** The stacked bar ramps one hue via `color-mix`; at five-plus
   contributions adjacent steps stop being distinguishable.
3. **`--color-alarm`, distinct from `--color-danger`.** Destructive-action red and
   "this station is shedding" red are currently one token doing two jobs — which is precisely
   why criterion B1 fails. Saturation cannot be an event while it shares a colour with the
   Delete button.
4. **`--color-grid` / `--color-grid-major`.** The graticule substrate; the visual signature of
   the direction, and not honestly derivable from `--color-border` in both themes.
5. **`--font-mono` and a `--type-micro-*` step** (10–11px). There is nothing below 12px, and
   instrument density needs it.
6. **`--duration-beat`** (~500ms) and **`--easing-settle`**. Criterion D1 needs a *named* beat,
   not an ad-hoc timeout.

---

## 8. Libraries

Verified against the registry, not memory.

| Add | Why |
| --- | --- |
| `d3-scale`, `d3-shape`, `d3-array` | ~9KB gz, tree-shakeable. Removes scale and path arithmetic bugs while keeping hand-authored markup, tokens and ARIA |
| `uplot` | The one thing hand-rolling gets bad at: multi-series live time series at 60fps. 21KB gz, zero deps, canvas, and an **imperative `setData`** — the only charting API that satisfies ADR 0003. Pin it; last publish lags the repo |
| `d3-geo` + `topojson-client` + `versor` | ~15KB gz. Gives the flat map *and* the revolvable globe from one codebase — `geoNaturalEarth1` versus `geoOrthographic`, a mode switch not a second library. Draws in the existing rAF loop |
| `vite-plugin-svgr` + `svgo` | Authored plates as components. **Hard rule: plates declare no colour** — every fill and stroke is `currentColor` or a token, which is what makes seven columns of artwork theme-correct from one stylesheet |
| `@fontsource-variable/geist-mono` | Instrument credibility is mostly monospace numerals, and it pairs with the Geist already shipped |

| Reject | Why |
| --- | --- |
| `three` / `react-globe.gl` | 20MB and 17MB unpacked, ~150KB gz for a minimal scene. Nothing in the model is 3D. This is ADR 0003's PixiJS rejection repeated with worse economics |
| `cobe` | Genuinely good and tiny, but a dotted globe cannot carry a labelled boundary or a legible choropleth. Ornament |
| `echarts` | 59MB unpacked, brings its own theme system to fight the tokens |
| `@observablehq/plot` | Depends on the whole `d3` meta-package, re-renders entire SVG on data change |
| `visx`, `recharts`, `nivo` | All render marks as React components — React per frame, directly prohibited by ADR 0003 |
| `@xterm/xterm` | 5.8MB for a VT100 emulator. The Console is a fake shell over live sim state; hand-roll it |
| `mermaid` | Auto-layout and generic; plates are authored content, not generated |

Use the native **View Transition API** for the full-screen column expand rather than adding a
motion library.

One gotcha: canvas and WebGL need numeric colour, not `oklch()` strings. Resolve tokens once
per theme change through a 1×1 `OffscreenCanvas` and cache the RGB triplets — about ten lines,
and `tokens.css` stays the single source of truth.

---

## 9. Sequencing

Phase 3 stands at 11 fails, 6 partials, 3 passes on its own gate, and **nothing on the
whiteboard fixes any of the eleven.** Building two new screens while the thing they surface is
still illegible is how a project acquires *more* boilerplate.

1. **Finish Phase 3.** A2 (run-to-run diff) and B1/B3 (saturation as an event, legible drops).
   B2 and B4 landed on `feat/visible-queues`.
2. **The three engine defects**, in the Phase 4 content-harness window — before `defineLevel`
   freezes 41 scenarios and their golden snapshots.
3. **Review mode at Phase 5.** Worth being precise: this is **not new scope**. Run-to-run diff
   and the cost readout were already Phase 5 work; the command centre is simply where they
   were always going to live.
4. **Codex at Phase 5–6**, generated from the registries that land in Phase 4–5.
5. **Layer explorer once the codex has entries to show.** Seven columns over a curriculum that
   is 75% one column is worse than shipping nothing.
6. **Map at Phase 8** as already scheduled. **Globe at Phase 11, or never.**

### The single highest-value next change

**Criterion A2, as a ghost trace.** Keep the previous run's series and draw it behind the
current one in the existing sparkline, with a delta column in the attribution legend.

Roughly a day. It closes A2 outright, upgrades A1 and A4 from partial, and probably lands E1 —
because "one big box beats three small ones" stops being two similar numbers and becomes a
visible gap. It is also the cheapest possible step into the art direction, since **overlaid
history is the visual signature of telemetry.**

One mechanism, four gate criteria, and the first register of the visual language established.

---

## 10. The through-line

The explorer and the command centre are both **views over content and runs that already have a
canonical source.** Build the source first, generate the views, and neither can lie to the
player.

That is the same argument the `demonstrations` harness already makes about prose, applied to
navigation.
