# ADR 0003 — npm workspaces, React Flow, and a canvas packet overlay

**Status:** Accepted · 2026-09-22
**Context:** Phase 0 design.

## Context

Three structural choices that are cheap now and expensive later: how the code is split,
what draws the topology editor, and what draws the packets moving through it.

The animation requirement is unusual. Most node-graph editors are static between edits;
this one has continuous particle motion at 60fps on top of a graph the player is
simultaneously editing, while a simulation updates metrics underneath.

## Decision

### npm workspaces, five packages, strictly linear

```
@nb/schema  ←  @nb/sim  ←  @nb/catalog  ←  @nb/content  ←  apps/game
```

npm, not pnpm — npm 11 is what is installed, and there is no monorepo feature here that
needs more. Enforced by a test that reads each `package.json` and fails on any edge not in
this chain.

`@nb/schema` (~200 lines of shared types and zod, no logic) exists solely to keep the graph
acyclic. Without it the natural drift is `sim ↔ catalog ↔ content`, which is very hard to
unpick once content has been authored against it.

Libraries are **not built**. Each `exports` points at `./src/index.ts`; Vite and Vitest
consume TypeScript source directly. Nothing is published to a registry, so stale `dist/`
directories — the main npm-workspaces tax — are simply not paid.

### React Flow for the editor

`@xyflow/react` handles nodes, edges, pan, zoom, handles and selection. At 10–80 nodes it
is comfortably within range, and it supplies weeks of interaction work for free.

### A canvas overlay for packets — never React, never SVG

- Path lookup tables sampled from each edge's bezier once **per topology change**, not per
  frame.
- Particles in parallel typed arrays with a free list; zero allocation in the hot loop.
- A single canvas sibling of the React Flow pane, reading the viewport transform
  **imperatively** inside the rAF loop (`useStoreApi().getState().transform`) so panning
  and zooming cost no React work at all.
- React re-renders at 10Hz via `useSyncExternalStore`, on values **quantized to display
  precision** — a badge reading "142ms" must not re-render when the value moves to 142.3ms.
- The simulation runs in a Web Worker.

## Alternatives considered

### Packets as React components or SVG elements — rejected

The path of least resistance, and the one most likely to be taken by default. Hundreds of
animated SVG nodes destroy paint and layout: janky at 30 nodes, unusable at 80.

Rejected not only on performance but on **reversibility**. By the time the jank is
undeniable, the approach is baked into every node component and the fix is a rewrite of
the entire rendering layer. This is the rare case where the naive approach must be ruled
out before the first line is written rather than optimised later.

### PixiJS or a WebGL renderer from the start — rejected

More headroom than canvas, and genuinely the right answer at tens of thousands of
particles.

Rejected as premature: 100KB+ and a second renderer's worth of complexity for a problem we
do not have at ~2000 sprites, where `drawImage` from an `OffscreenCanvas` atlas costs
1–2ms per frame. The overlay sits behind a `PacketRenderer` interface, so if profiling
ever justifies WebGL the swap touches one file.

### A fully custom canvas editor instead of React Flow — rejected

Total control over rendering and no library performance ceiling.

Rejected because pan, zoom, hit testing, edge routing, connection dragging, handle
snapping, selection and the minimap are weeks of work that React Flow already does well.
The genuine risk was never the editor — it was the animation, and the overlay solves that
without giving up the editor.

### pnpm workspaces — rejected

Better disk usage and stricter dependency isolation.

Rejected because npm 11 is already installed and nothing here needs what pnpm adds.
Introducing a second package manager to the workspace is a real cost — onboarding, CI,
tooling — against no benefit at this size.

## Consequences

**Good.** The editor is cheap to build and the animation has a known performance ceiling
well above what the game needs. The package boundary keeps `@nb/sim` runnable headlessly
in Node, so every number the game shows is reproducible from a command line without a
browser.

**Costly.** Two rendering models coexist — React for the graph, imperative canvas for the
packets — and the seam between them needs care. In particular, the overlay must track the
React Flow transform exactly, and a future React Flow major version could change how that
transform is exposed.

**Guardrail.** A dev-mode React commit counter plus a CI assertion capping React commits
per simulated second. The failure mode here is gradual — one `useState` at a time — so it
needs an automated tripwire rather than review discipline.
