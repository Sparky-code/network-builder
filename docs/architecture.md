# Architecture

How the code is organised, why the boundaries sit where they do, and which of them are
load-bearing. The mathematics lives in [`simulation-model.md`](simulation-model.md); the
decisions and their rejected alternatives in [`adr/`](adr/).

---

## 1. Packages

npm workspaces. The app starts from an internal workspace template rather than a bare
`create-vite` scaffold, which fixes the stack as React 19, Vite 8, Tailwind v4, shadcn/ui
on Base UI primitives, and DTCG design tokens compiled by Style Dictionary. Vite rather
than Next.js, because there is no SSR or SEO requirement and this is a single application,
not a content site.

```
network-builder/
├── package.json                 # npm workspaces root
├── ROADMAP.md
├── docs/
├── packages/
│   ├── schema/                  # @nb/schema  — shared types + zod. Depends on nothing
│   ├── sim/                     # @nb/sim     — engine. Zero DOM, zero domain nouns
│   ├── catalog/                 # @nb/catalog — component types → sim primitives
│   └── content/                 # @nb/content — levels, lessons, demonstrations
└── apps/
    └── game/                    # Vite + React 19
```

### The dependency graph is layered and downward-only

```
@nb/schema  ←  @nb/sim  ←  @nb/catalog  ←  @nb/content  ←  @nb/game
```

Enforced by `test/architecture.test.ts`, which reads every workspace `package.json` and
fails on any internal dependency that points **upward** or **sideways**, on any cycle, and
on any package whose name is not assigned a layer. That last one matters: adding a package
is a decision about where it sits, and the test makes someone make it rather than
defaulting.

A package may depend on any layer strictly below it, not only its immediate predecessor.
This is layered rather than a single chain because `@nb/catalog` legitimately needs schema
types directly, and routing that through `@nb/sim` would manufacture coupling to satisfy a
rule instead of serving its purpose. What the rule exists to prevent is cycles and upward
edges — the natural drift is `sim ↔ catalog ↔ content`, which is very hard to unpick once
content has been authored against it — and those are exactly what it forbids.

The app's package must be named `@nb/game` to satisfy the layer check.

The same test file enforces two further documented claims, because both are cheap to break
by accident:

- **`@nb/sim` is headless.** No UI or DOM package may appear in its dependencies, no
  source file may import `react` or `@xyflow/*`, and none may touch `document`, `window` or
  `navigator`. The contract is that the engine runs in Node, in a test, and in a Web Worker
  unchanged, so every number the game shows is reproducible from a command line.
- **`@nb/sim` has no ambient randomness or wall clock.** No `Math.random()`, `Date.now()`,
  `new Date`, `performance.now()` or `crypto.*` in engine source. Every draw is a pure
  function of `(seed, purpose, tick, index)`; a stray `Math.random()` added for a visual
  flourish would silently shift every graded number downstream of it.

Each of these guards was verified by deliberately introducing the violation it describes
and confirming the suite fails.

`@nb/schema` exists solely to make that chain acyclic. It is about 200 lines of shared
types and zod schemas with no logic, and it is the cheapest possible way to let `sim` and
`content` agree on a vocabulary without depending on each other.

### The boundary that matters

**`@nb/sim` knows `Station`, `Policy` and `Controller`. It does not know what a CDN is, or
a pod, or a WAF.** `@nb/catalog` is the only place where game concepts are mapped onto
simulation primitives.

This is the boundary that makes Acts V and VI additive rather than a rewrite. Adding
Kubernetes means adding catalog entries whose `simTemplate` sets a different concurrency
source and attaches an HPA controller — not touching the engine. If a new act ever
*requires* an engine change, that is the signal that the abstraction in
[ADR 0002](adr/0002-station-policy-controller-abstraction.md) has failed, and it should be
treated as a design emergency rather than a routine feature.

`@nb/sim` also has a hard rule: **no React import, no DOM access, ever.** It runs in Node,
in a test, and in a Web Worker unchanged. Every number the game shows is reproducible from
a command line with no browser involved.

### Do not build the libraries

Each `package.json` points `exports` at `./src/index.ts`, and Vite and Vitest consume the
TypeScript source directly (the template already uses `moduleResolution: "bundler"`).
Type-checking is `tsc -b` from the root. Stale `dist/` directories are the main tax of npm
workspaces, and since nothing here is published to a registry, there is no reason to pay
it.

### Template copy notes

The template is internal to the authoring workspace, so these notes are for whoever
provisions the app rather than for a reader of this repo. Each one is a small trap:

- `style-dictionary.config.js` emits a **second** output to
  `../plain-html-fallback/tokens.css`. From `apps/game/` that resolves to
  `apps/plain-html-fallback/tokens.css` — a junk file in the repo. Remove that platform
  target when copying.
- Copy `src/`, `tokens/`, `index.html`, `public/`, `vite.config.ts`, the three
  `tsconfig*.json` files, `components.json` and `.oxlintrc.json`. Do **not** copy the
  committed `dist/`, `node_modules/` or `package-lock.json`.
- The root `tsconfig.json` project `references` must be extended to the four packages.
- `@xyflow/react` ships its own stylesheet; import it before Tailwind's layer so preflight
  does not fight it.

---

## 2. The topology model

### Semantics and layout are separate

```ts
interface Topology {          // hashed → simulation cache key. Layout deliberately absent
  nodes: Array<{
    id: NodeId; typeId: ComponentTypeId; regionId: RegionId;
    config: Record<string, JsonValue>;
  }>;
  edges: Array<{
    id: EdgeId; from: PortRef; to: PortRef;
    config: { protocolId: ProtocolId; weight?: number };
  }>;
}

interface Layout { positions: Record<NodeId, { x: number; y: number }>; }
interface PortRef { nodeId: NodeId; portId: string; }
```

Keeping `Layout` out of `Topology` means `inputHash` is stable under pure repositioning.
Dragging a node to tidy the diagram does not invalidate a cached run, so the editor stays
instant and the player is never punished for arranging their work neatly.

### Legality is emergent, not enumerated

The tempting implementation is a pairwise matrix of which component may connect to which.
It is O(n²), it rots as components are added, and it encodes no reason — only a verdict.

Instead, ports carry a protocol and capability tags:

```ts
interface Port {
  id: string;
  direction: 'in' | 'out';
  protocol: 'http' | 'grpc' | 'sql' | 'dns' | 'tcp';
  provides?: CapabilityTag[];   // e.g. ['authenticated', 'tls-terminated']
  accepts?: CapabilityTag[];    // must be a superset of the upstream's `provides`
  minDegree: number;
  maxDegree: number;
}
```

An edge is legal iff the protocols match, `to.accepts ⊇ from.provides`, and degree bounds
hold. A cache cannot connect to a database because the cache's out-port speaks `http` and
the database's in-port speaks `sql`. That rule was never written down — it emerges, and it
comes with an explanation the UI can show the player.

Capability tags are what let Act VI work without new machinery: a component can require
`tls-terminated` or `authenticated` on its inbound port, and the validator enforces it the
same way it enforces protocol matching.

Graph-level rules that ports cannot express live in a **named predicate registry**,
referenced by string id from catalog and level data — data-driven, without inventing a
rule DSL to regret later:

```ts
const GRAPH_RULES: Record<RuleId, (t: Topology, cat: Catalog) => Diagnostic[]> = {
  'reachability':            /* every client region reaches a terminal origin */,
  'no-http-cycle':           /* excluding designated retry edges */,
  'waf-before-origin':       /* all ingress paths traverse a WAF — Act VI */,
  'single-point-of-failure': /* severity 'warning': affects grade, does not block */,
};
```

### One validator, three consumers

```ts
function validate(t: Topology, cat: Catalog, level: Level): Diagnostic[];

function canConnect(cat: Catalog, t: Topology, from: PortRef, to: PortRef):
  | { ok: true }
  | { ok: false; code: DiagCode; message: string; learnMoreId?: LessonId };

interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: DiagCode;
  message: string;
  nodeIds: NodeId[];
  edgeIds: EdgeId[];
  hint?: string;
  learnMoreId?: LessonId;
}
```

The editor calls `canConnect` during a drag to grey out invalid handles and show the
reason; the runner calls `validate` to block Run on any `error`; the grader folds
`warning` diagnostics into the score. **No rule knowledge lives in the UI layer.**

`learnMoreId` is the detail worth keeping: every rejected connection can link to the lesson
that explains why. In a teaching game, a mistake is the best moment to teach, and throwing
away that moment with a bare "invalid connection" tooltip would be a waste of the
validator's knowledge.

---

## 3. Rendering

`@xyflow/react` handles nodes, edges, pan, zoom, handles and selection. At 10–80 nodes it
is comfortably within range, and it supplies weeks of interaction work for free.

The risk is never node count — it is animation. **Packets must never be React components
and never SVG elements.** Hundreds of animated SVG nodes destroy paint and layout, and by
the time that is obvious the approach is baked into every node component.

1. **Path lookup tables, computed on topology change only.** Build the edge path with
   `getBezierPath`, instantiate an off-DOM `SVGPathElement`, and sample ~64 points by
   arclength with `getPointAtLength` into a `Float32Array`. 80 edges × 64 samples is about
   5ms, paid once per edit rather than per frame.

2. **Particles in typed arrays, outside React, with zero allocation in the hot loop.**
   Parallel `Float32Array` / `Uint16Array` / `Uint8Array` for progress, speed, edge index,
   traffic class and fate, with a free list for reuse.

3. **One canvas overlay glued to React Flow's viewport**, reading the transform
   *imperatively* inside the rAF loop — `useStoreApi().getState().transform`, never a
   subscribing hook. The overlay is a sibling of the React Flow pane sharing its
   transform, so it stays pinned through pan and zoom with **zero React work**. Roughly
   2000 sprites via `drawImage` from an `OffscreenCanvas` atlas costs 1–2ms per frame.

4. **Spawn rate derives from simulation state, not a timer.** Per edge per frame,
   `accumulator += λ_display × dt`, emit `floor(accumulator)`. Total packets are capped and
   `λ_display` is scaled down logarithmically at high rates — 50,000 rps cannot be 50,000
   dots, so show density plus a numeric readout, and make the *cap* visible so nobody
   misreads sparse dots as low traffic.

5. **React renders at 10Hz, not 60Hz**, through `useSyncExternalStore`, with every
   displayed value **quantized to its display precision before comparison** — a badge
   reading "142ms" must not re-render when the underlying value moves to 142.3ms.
   Node-internal visuals such as queue fill bars and saturation glow bypass React
   entirely: set CSS custom properties imperatively from the same rAF loop.

6. **The simulation runs in a Web Worker.** This keeps the main thread free, and it enables
   batch parameter sweeps for the hint system — "a PoP in Frankfurt would cut EU p99 by
   41ms" — without janking the canvas.

**Not PixiJS.** 100KB+ and a second renderer's complexity for a problem we do not have.
The overlay sits behind a `PacketRenderer` interface so a later WebGL swap touches one
file, but canvas ships first. See
[ADR 0003](adr/0003-monorepo-and-canvas-overlay-rendering.md).

### Accessibility

Per the workspace stack conventions, and non-negotiable:

- Honour `prefers-reduced-motion` by reducing packet density and disabling pulse effects —
  **not** by removing the signal, which would take the information away from the people
  who asked for less motion.
- Encode health with shape and icon, never colour alone.
- Every colour, spacing, radius and font-size value references a design token.
- Verify both light and dark themes before calling any UI work done.

---

## 4. Content authoring format

Typed TypeScript modules, validated by zod at test time, with MDX for prose.

**Why not JSON + zod alone:** it loses cross-references. A `"cdn-1"` typo becomes a runtime
failure in front of a player instead of a compile error. It also loses autocomplete and
computed values, which matters a great deal to whoever is writing 41 levels.

**Why not MDX alone:** excellent for prose, poor for structured data. Carrying a schema in
MDX frontmatter is a well-known trap.

**Typed TS modules** give autocomplete on `ComponentTypeId` (a union generated from the
catalog), compile-time reference checking, computed traffic profiles, and per-act code
splitting via dynamic `import()`. Zod covers what types cannot express — budget greater
than zero, SLOs that are actually achievable, referenced nodes that exist.

```ts
// @nb/content/acts/03-caching/06-origin-shield.ts
export default defineLevel({
  id: 'caching/origin-shield',
  brief: () => import('./06-origin-shield.mdx'),
  budgetUsdMonth: 4200,
  unlocks: ['cdn-pop', 'origin-shield'],
  startingTopology: topo(/* … */),

  scenario: { durationSec: 120, warmupSec: 20, demands: [/* … */], events: [/* … */] },

  objectives: [
    { id: 'eu-slo',     metric: 'perRegion.eu-west.api-read.p99Ms', lt: 90,   weight: 3 },
    { id: 'origin-qps', metric: 'perNode.origin.throughputRps',     lt: 200,  weight: 2 },
    { id: 'budget',     metric: 'cost.totalUsdMonth',               lte: 4200, weight: 1 },
  ],

  lessons: [
    { id: 'shield-reaggregates-misses',
      explains: { metric: 'cacheHitRatioTotal', param: 'cdn-pop.ttlSeconds' },
      body: () => import('./lesson-shield.mdx') },
  ],

  referenceSolutions: { gold: topo(/* … */), knownBad: topo(/* … */) },

  demonstrations: [
    { name: 'PoPs alone fragment the cache',
      topology: topo(/* … */), expect: { cacheHitRatioEdge: { lt: 0.55 } } },
    { name: 'shield restores total hit ratio',
      topology: topo(/* … */), expect: { cacheHitRatioTotal: { gt: 0.85 },
                                         'perNode.origin.throughputRps': { lt: 200 } } },
  ],
});
```

---

## 5. Keeping the teaching honest

Prose silently rotting away from mechanics is the classic death of an educational game.
Someone tunes a constant for balance, and fifteen lessons quietly start describing
behaviour the simulation no longer produces. Nothing fails; the game just becomes wrong.

Two cheap mechanisms prevent it, and **both are built alongside level 2, not level 20** —
retrofitting them across 41 levels costs far more than writing them once.

### `explains` bindings, checked in CI

The engine exports a `METRIC_REGISTRY` and a `PARAM_REGISTRY` listing every metric path
and configurable parameter. A test asserts every `explains` target resolves. Rename
`cacheHitRatio` to `cacheHitRatioTotal` and CI names exactly which lesson paragraphs are
now lying, instead of leaving them to be discovered by a confused player.

### `demonstrations`, run as tests

Each demonstration is a (topology, expected qualitative outcome) pair asserting **the
claim the lesson actually makes**. Tune a TTL constant until origin shields stop mattering
and CI fails with `shield restores total hit ratio` — by name, pointing at the lesson that
is now false.

Every level in [`content-spine.md`](content-spine.md) already carries its CI claim, which
is why that document is written the way it is: the claims are the test suite.

### Solvability

Per level, CI also asserts:

- the `gold` reference solution scores above the gold threshold — **the level is
  solvable**;
- the `knownBad` topology fails — **the level is not trivially passable**.

A level that quietly becomes unsolvable after a balance change is one of the most common
ways a content-driven game dies, and it is entirely preventable for the cost of two stored
topologies per level.
