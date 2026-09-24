# Quality gates

Most phases in `ROADMAP.md` gate on something a test can settle: numbers agree with an
oracle, runs are bit-identical, a level is solvable. Two do not. Those gates are written
out here in full, because a gate nobody can fail is not a gate.

---

## Phase 3 — "the loop is fun, not merely correct"

### Why this needs a gate at all

The first attempt at Phase 3 passed every test it had — 150 green, typecheck and lint
clean, a provably solvable level — and was still, in the reviewer's words, "very much
boilerplate". Twice.

That is the gate's own failure, not the reviewer's. "Fun" as written was unfalsifiable, so
the work optimised for what *was* checkable: correctness, then surface polish. Icons and a
hero number are not fun; they are what you reach for when you have no definition of fun to
aim at.

So the criteria below are deliberately about **mechanism, not decoration**. Almost none of
them can be satisfied by restyling.

### How to run it

One person, five minutes, out loud, on a machine that has never seen the level. No reading
the code first. Play it as a player: read the brief, try something, run it, react.

Say what you notice out loud and write it down verbatim. The verbatim part matters — "I
don't know what to change" is a finding; "the UI could be better" is not.

Each criterion is judged **pass / partial / fail** against its own bar. The phase closes
when there are no fails in group A or B, and at most two partials overall. A and B are
non-negotiable because they are the ones the whole project's pedagogy rests on.

---

### Group A — Causality: can you tell *why*?

This is the project's largest single risk. If a player cannot answer "why did p99 move from
90 to 340?", the simulation's fidelity is worthless.

**A1. One change, one attributable delta.**
After changing exactly one thing and re-running, you can name which contribution moved and
roughly by how much, without reading source.
*Bar:* within five seconds of the run finishing, unprompted.

**A2. Before and after are visible together.**
Comparing two runs does not require remembering the previous numbers.
*Bar:* the previous run's figures are on screen, or one interaction away, with the delta
shown — not recalled.

**A3. The dominant cost is stated, not inferred.**
The interface says which contribution is worth attacking, in words.
*Bar:* a player who does not know queueing theory still knows what to change next.

**A4. Wrong theories die fast.**
Acting on a plausible-but-wrong idea (buy a bigger server for a distant origin) visibly
fails, and the reason is legible from the result.
*Bar:* the failure is attributable, not just a number that did not improve.

### Group B — Consequence: does failure look like failure?

The engine's most dramatic behaviour — the backlog integrator, where breaking is fast and
recovery is slow — is currently invisible. A 3px progress bar is not a consequence.

**B1. Saturation is a visible event.**
When a station goes over capacity, something happens on the canvas that you would notice
with the metrics panel covered.
*Bar:* cover the right-hand rail; you can still tell the system is failing, and where.

**B2. Queues have depth you can see.**
Backlog is represented as an accumulating quantity, not a percentage.
*Bar:* you can see a queue *growing*, and see it drain more slowly than it filled.

**B3. Dropped requests are individually legible.**
A dropped request reads as a request that died, not as a colour change.
*Bar:* you can point at one and say "that one failed".

**B4. Recovery is felt.**
After fixing an overload, the system visibly works through its backlog rather than
snapping to healthy.
*Bar:* the asymmetry between collapse and recovery is observable without reading numbers.

### Group C — Agency: does the topology feel like yours?

**C1. Placement is direct.**
Components are dragged to where they belong, not dropped at a predetermined spot.
*Bar:* no component ever appears somewhere you did not choose.

**C2. Wiring is forgiving.**
Connecting, disconnecting and rewiring are all single, discoverable gestures.
*Bar:* a player rewires a topology without deleting anything, having been told nothing.

**C3. Refusals teach.**
An illegal connection explains itself in domain terms at the moment of refusal.
*Bar:* the explanation names the reason ("a cache speaks HTTP; a database speaks SQL"),
not the rule that fired.

### Group D — Rhythm: does the loop have a beat?

**D1. Running is a moment.**
Pressing run produces anticipation and then resolution, rather than numbers appearing.
*Bar:* there is a beat between asking and knowing. It is short, and it is not nothing.

**D2. The canvas is alive between runs.**
Idle state does not look broken or finished.
*Bar:* an idle topology invites a change rather than looking like a saved diagram.

**D3. Iteration is unpunished.**
Trying something costs nothing — no confirmation, no reload, no lost layout.
*Bar:* ten consecutive experiments in under a minute, without irritation.

### Group E — Surprise: does the counterintuitive land?

The engine produces genuinely surprising truths. They are the reason to play rather than
read, and they currently arrive as unremarkable numbers.

**E1. At least one result contradicts an expectation, visibly.**
In this level: the single big box is *faster* than three smaller ones at equal cost.
*Bar:* the player says some version of "wait, what?" — and then can find out why.

**E2. The surprise is explained where it is felt.**
The explanation is attached to the result, not filed in a brief the player has moved past.

### Group F — Closure: does solving it feel like solving it?

**F1. Passing is an event.**
Meeting the objectives is acknowledged distinctly from not meeting them.
*Bar:* more than a character changing colour in a list.

**F2. Partial credit reads as progress.**
Two of three stars feels like being nearly there, and says what the third requires.

**F3. There is a reason to try again.**
Having passed, the player can see a better solution existing.
*Bar:* an efficiency, cost or latency figure worth beating.

---

### Honest current status

Assessed against the above, as built:

| | Criterion | Status |
| --- | --- | --- |
| A1 | One change, one attributable delta | pass* — every contribution now carries a delta against the previous run |
| A2 | Before and after visible together | pass — ghost trace behind the current series, plus per-contribution deltas |
| A3 | Dominant cost stated | pass — the waterfall caption names it |
| A4 | Wrong theories die fast | pass* — the caption names which contribution moved most, and by how much |
| B1 | Saturation is a visible event | pass* — a shockwave on the canvas at the transition, sustained alarm state after |
| B2 | Queues have visible depth | pass — queue tank tracks the integrator; fills over 1.5s, drains over 4.0s |
| B3 | Dropped requests legible | pass* — refused at the door and deflected away, marked with a cross |
| B4 | Recovery is felt | pass — playback resolves and holds; drain animates 2.67× longer than build |
| C1 | Placement is direct | **fail** — palette click drops at a fixed coordinate |
| C2 | Wiring is forgiving | pass — as of the disconnect fix |
| C3 | Refusals teach | partial — the message exists but appears in a toast, away from the gesture |
| D1 | Running is a moment | **fail** — numbers simply appear |
| D2 | Canvas alive between runs | **fail** — static and dead until a run |
| D3 | Iteration is unpunished | pass |
| E1 | Counterintuitive result lands | partial — the delta makes the gap visible, but nothing remarks on it |
| E2 | Surprise explained where felt | **fail** |
| F1 | Passing is an event | **fail** — a list item changes |
| F2 | Partial credit reads as progress | partial |
| F3 | Reason to try again | **fail** |

**Originally: eleven fails, six partials, three passes.** Nine of the eleven needed
mechanism that did not exist, which is why no amount of restyling moved it.

**Now: five fails, four partials, nine passes.** Groups A and B are clear, which is the
stated bar for closing the phase.

Rows marked `pass*` are **mechanism-verified but not playtested.** The mechanism exists and
behaves as specified — a delta is computed and shown, a shockwave fires on the transition,
a refused request is deflected at the door. Whether those *read* as intended is what the
five-minute playtest decides, and these are the rows to watch during it. A criterion is not
closed because the code is there; that is the mistake this document exists to prevent.

What remains, all of it outside groups A and B: C1 (direct placement), D1 (running is a
moment), D2 (a live canvas between runs), E2 (the surprise explained where it is felt), F1
and F3 (passing as an event, and a reason to try again).

### What the gate implies about sequencing

Two roadmap corrections fall out of writing this down:

1. **Run-to-run diff is not Phase 5 work.** It is criterion A2, and A-group failures block
   the phase. It was scheduled late because it looked like a reporting feature; it is
   actually the core of the learning loop.
2. **Queue depth needs to be a first-class visual, not a derived one.** The engine already
   models backlog as an integrator — the most teachable behaviour it has — and the
   presentation layer currently discards it. B2 and B4 are both cheap once backlog is
   plumbed through to the canvas, and impossible until it is.

Neither is a new feature request. Both are existing capabilities the presentation layer
throws away.
