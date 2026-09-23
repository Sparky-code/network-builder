import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Architectural invariants, enforced rather than described.
 *
 * `docs/architecture.md` claims the dependency graph is layered and that the
 * engine is headless. Both claims are cheap to break by accident and expensive
 * to unpick later - the natural drift is sim <-> catalog <-> content, and a cycle
 * between packages that content has already been authored against is very hard
 * to undo. So they are tests.
 */

const ROOT = join(import.meta.dirname, '..');

/**
 * Layer order. A package may depend on any layer STRICTLY BELOW it, never on its
 * own layer and never upward.
 *
 * Layered rather than a single chain: `@nb/catalog` legitimately needs schema
 * types directly, and routing that through `@nb/sim` would manufacture coupling
 * to avoid a rule instead of satisfying its purpose. What the rule exists to
 * prevent is cycles and upward edges, and those are what it forbids.
 */
const LAYERS: readonly string[] = [
  '@nb/schema',
  '@nb/sim',
  '@nb/catalog',
  '@nb/content',
  '@nb/game',
];

interface Pkg {
  readonly name: string;
  readonly dir: string;
  readonly deps: readonly string[];
}

function readWorkspacePackages(): readonly Pkg[] {
  const out: Pkg[] = [];
  for (const group of ['packages', 'apps']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(base, entry.name, 'package.json');
      if (!existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const all = {
        ...json.dependencies, ...json.devDependencies, ...json.peerDependencies,
      };
      out.push({
        name: json.name ?? entry.name,
        dir: join(group, entry.name),
        deps: Object.keys(all),
      });
    }
  }
  return out;
}

const PACKAGES = readWorkspacePackages();
const layerOf = (name: string): number => LAYERS.indexOf(name);

describe('workspace layering', () => {
  it('finds the workspace packages', () => {
    expect(PACKAGES.length).toBeGreaterThan(0);
    // Every package that exists must have been assigned a layer. A new package
    // appearing without one is a deliberate decision someone has to make, not a
    // default this test should guess at.
    for (const p of PACKAGES) {
      expect(LAYERS, `${p.dir} (${p.name}) has no assigned layer in LAYERS`)
        .toContain(p.name);
    }
  });

  it('has no upward or sideways internal dependencies', () => {
    const violations: string[] = [];

    for (const p of PACKAGES) {
      const from = layerOf(p.name);
      for (const dep of p.deps) {
        if (!dep.startsWith('@nb/')) continue;
        const to = layerOf(dep);
        if (to === -1) {
          violations.push(`${p.name} depends on unknown internal package ${dep}`);
        } else if (to === from) {
          violations.push(`${p.name} depends on ${dep} in the same layer`);
        } else if (to > from) {
          violations.push(`${p.name} depends UPWARD on ${dep}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('has no dependency cycles', () => {
    // Layering already implies acyclicity, but asserting it directly means the
    // test still catches a cycle if someone loosens the layer rule.
    const graph = new Map<string, readonly string[]>(
      PACKAGES.map((p) => [p.name, p.deps.filter((d) => d.startsWith('@nb/'))]),
    );

    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycles: string[] = [];

    const visit = (node: string, path: readonly string[]): void => {
      if (done.has(node)) return;
      if (visiting.has(node)) {
        cycles.push([...path, node].join(' -> '));
        return;
      }
      visiting.add(node);
      for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
      visiting.delete(node);
      done.add(node);
    };

    for (const name of [...graph.keys()].sort()) visit(name, []);
    expect(cycles).toEqual([]);
  });
});

describe('the engine is headless', () => {
  const sim = PACKAGES.find((p) => p.name === '@nb/sim');

  it('@nb/sim exists', () => {
    expect(sim).toBeDefined();
  });

  it('@nb/sim declares no UI or DOM dependencies', () => {
    // The contract is that the engine runs in Node, in a test, and in a Web
    // Worker unchanged, so every number the game shows is reproducible from a
    // command line with no browser involved.
    const forbidden = [
      'react', 'react-dom', '@xyflow/react', 'vue', 'svelte',
      'jsdom', 'happy-dom', 'tailwindcss',
    ];
    const offending = (sim?.deps ?? []).filter((d) => forbidden.includes(d));
    expect(offending).toEqual([]);
  });

  it('@nb/sim source imports nothing browser-shaped', () => {
    const srcDir = join(ROOT, 'packages/sim/src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(srcDir);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      // Import specifiers only: a comment mentioning the DOM is fine, importing
      // it is not.
      for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1] ?? '';
        if (/^(react|react-dom|@xyflow)/.test(spec)) {
          offenders.push(`${f.replace(ROOT + '/', '')} imports ${spec}`);
        }
      }
      if (/\b(document|window|navigator)\s*\./.test(text)) {
        offenders.push(`${f.replace(ROOT + '/', '')} touches a DOM global`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('@nb/sim source uses no ambient randomness or wall clock', () => {
    // Determinism rule: every draw is a pure function of (seed, purpose, tick,
    // index). A stray Math.random() for a visual flourish would silently shift
    // every graded number downstream of it.
    const srcDir = join(ROOT, 'packages/sim/src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const text = readFileSync(p, 'utf8');
        const rel = p.replace(ROOT + '/', '');
        if (/Math\.random\s*\(/.test(text)) offenders.push(`${rel}: Math.random()`);
        if (/\bnew Date\b|\bDate\.now\s*\(/.test(text)) offenders.push(`${rel}: Date`);
        if (/\bperformance\.now\s*\(/.test(text)) offenders.push(`${rel}: performance.now()`);
        if (/\bcrypto\.\w/.test(text)) offenders.push(`${rel}: crypto`);
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
