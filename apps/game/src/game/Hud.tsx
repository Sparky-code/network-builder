import { useMemo } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { LatencyWaterfall } from '@nb/schema';
import type { GameState, Grade } from './state';
import { LEVEL } from './level';

/**
 * Metrics, grading, and the attribution waterfall.
 *
 * The waterfall is not polish. The project's largest risk is a player who
 * cannot answer "why did p99 move from 90 to 340?" — decomposing every run into
 * named contributions is what turns a simulation into a teaching instrument.
 */

const fmtMs = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;

/**
 * p99 over the run. One series, so no legend — the heading names it.
 *
 * The threshold line is the point of the chart: the question is never "what is
 * the shape" but "are we under the line".
 */
function Sparkline({ state }: { state: GameState }) {
  const frames = state.result?.frames ?? [];
  const ghostFrames = state.previousResult?.frames ?? [];

  const path = useMemo(() => {
    if (frames.length < 2) return null;
    const w = 300;
    const h = 64;
    const values = frames.map((f) => f.p99Ms);
    const ghost = ghostFrames.map((f) => f.p99Ms);

    /*
     * Both runs share one scale, including the previous run's peak.
     *
     * Scaling each series to its own maximum would make every run look the
     * same shape and turn an improvement into a flat line - the comparison has
     * to be readable as a *gap*, which only works on a common axis.
     */
    const peak = Math.max(LEVEL.sloP99Ms * 1.4, ...values, ...ghost);

    // Runs can differ in length, so each series is positioned by its own
    // progress through its own run rather than by frame index.
    const xOf = (i: number, n: number): number => (n <= 1 ? 0 : (i / (n - 1)) * w);
    const y = (v: number): number => h - (Math.min(v, peak) / peak) * h;
    const toPath = (vs: readonly number[]): string =>
      vs.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i, vs.length).toFixed(1)},${y(v).toFixed(1)}`)
        .join(' ');

    return {
      w, h,
      line: toPath(values),
      ghostLine: ghost.length > 1 ? toPath(ghost) : null,
      area: `M0,${h} ${values.map((v, i) => `L${xOf(i, values.length).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} L${w},${h} Z`,
      sloY: y(LEVEL.sloP99Ms),
      headX: xOf(Math.max(0, state.playhead), values.length),
      headY: y(values[Math.max(0, state.playhead)] ?? 0),
    };
  }, [frames, ghostFrames, state.playhead]);

  if (path === null) return null;

  const current = state.result?.perClass['api-read']?.p99Ms;
  const before = state.previousResult?.perClass['api-read']?.p99Ms;
  const delta = current !== undefined && before !== undefined ? current - before : null;

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="chart-title">p99 latency over the run</span>
        <span className="chart-note">
          {delta === null
            ? `target under ${LEVEL.sloP99Ms}ms`
            : <>vs previous <Delta ms={delta} /></>}
        </span>
      </div>
      <svg viewBox={`0 0 ${path.w} ${path.h}`} className="sparkline" role="img"
        aria-label={delta === null
          ? `p99 latency over time, target under ${LEVEL.sloP99Ms} milliseconds`
          : `p99 latency over time compared with the previous run, ${fmtDelta(delta)}`}>
        <path d={path.area} className="sparkline-area" />
        {/* Recessive reference line: the chart's actual question. */}
        <line x1="0" x2={path.w} y1={path.sloY} y2={path.sloY} className="sparkline-slo" />
        {/* The previous run, behind and quiet. Overlaid history is what makes a
            readout an instrument rather than a number that changed. */}
        {path.ghostLine !== null && (
          <path d={path.ghostLine} className="sparkline-ghost" />
        )}
        <path d={path.line} className="sparkline-line" />
        <circle cx={path.headX} cy={path.headY} r="3.5" className="sparkline-head" />
      </svg>
    </div>
  );
}

/** Signed, with direction stated in words as well as sign and colour. */
function fmtDelta(ms: number): string {
  if (Math.abs(ms) < 0.5) return 'unchanged';
  return ms < 0 ? `${fmtMs(-ms)} faster` : `${fmtMs(ms)} slower`;
}

function Delta({ ms }: { ms: number }) {
  const dir = Math.abs(ms) < 0.5 ? 'same' : ms < 0 ? 'better' : 'worse';
  return (
    <span className="delta" data-dir={dir}>
      {dir === 'same' ? '·' : dir === 'better' ? '▼' : '▲'} {fmtDelta(ms)}
    </span>
  );
}

/**
 * Where the p99 goes, as one stacked bar.
 *
 * Segments are ordered stages of a single request, not independent categories,
 * so they take a single-hue sequential ramp rather than categorical colors —
 * position in the ramp encodes position in the request path. A 2px surface gap
 * separates them so adjacent stages stay legible.
 */
/** The named contributions, in request order. Shared by both runs so the rows line up. */
function contributions(w: LatencyWaterfall): readonly { label: string; ms: number }[] {
  return [
    { label: 'DNS', ms: w.dnsMs },
    { label: 'TCP + TLS', ms: w.setupMs },
    { label: 'Network', ms: w.propagationMs },
    { label: 'Queueing', ms: w.queueMs },
    { label: 'Server work', ms: w.serviceMs },
    { label: 'Transfer', ms: w.transferMs },
  ];
}

/**
 * Which contribution changed most between two runs, and by how much.
 *
 * Exported for test: the sign convention is easy to invert, and inverting it
 * would tell the player to attack whichever part of the request they just
 * improved.
 */
export function biggestMover(
  before: LatencyWaterfall,
  after: LatencyWaterfall,
): { label: string; deltaMs: number } | null {
  const a = contributions(before);
  const b = contributions(after);
  let best: { label: string; deltaMs: number } | null = null;
  for (let i = 0; i < b.length; i++) {
    const delta = (b[i]?.ms ?? 0) - (a[i]?.ms ?? 0);
    if (Math.abs(delta) < 0.5) continue;
    if (best === null || Math.abs(delta) > Math.abs(best.deltaMs)) {
      best = { label: b[i]?.label ?? '', deltaMs: delta };
    }
  }
  return best;
}

function Waterfall({ state }: { state: GameState }) {
  const w = state.result?.attribution;
  if (w === undefined) return null;

  const previous = state.previousResult?.attribution;
  const before = previous === undefined ? null : contributions(previous);

  const rows = contributions(w)
    .map((r, i) => ({
      ...r,
      // Paired by position, so a contribution that fell to zero still reports
      // its drop rather than silently vanishing from the comparison.
      deltaMs: before === null ? null : r.ms - (before[i]?.ms ?? 0),
    }))
    .filter((r) => r.ms > 0.01 || (r.deltaMs !== null && Math.abs(r.deltaMs) > 0.5));

  const total = rows.reduce((a, r) => a + r.ms, 0);
  if (total <= 0) return null;

  const dominant = rows.reduce((a, b) => (b.ms > a.ms ? b : a));
  const mover = previous === undefined ? null : biggestMover(previous, w);

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="chart-title">Where the p99 goes</span>
        <span className="chart-note">{fmtMs(total)} total</span>
      </div>

      <div className="stack" role="img" aria-label={rows.map((r) => `${r.label} ${fmtMs(r.ms)}`).join(', ')}>
        {rows.map((r, i) => (
          <div
            key={r.label}
            className="stack-seg"
            style={{
              width: `${(r.ms / total) * 100}%`,
              // Sequential ramp: later stages sit deeper in the same hue.
              '--step': String(i / Math.max(1, rows.length - 1)),
            } as React.CSSProperties}
            title={`${r.label}: ${fmtMs(r.ms)}`}
          />
        ))}
      </div>

      <ul className="stack-legend">
        {rows.map((r, i) => (
          <li key={r.label} data-dominant={r.label === dominant.label}>
            <span
              className="swatch"
              style={{ '--step': String(i / Math.max(1, rows.length - 1)) } as React.CSSProperties}
              aria-hidden="true"
            />
            <span className="stack-legend-label">{r.label}</span>
            <span className="stack-legend-value">{fmtMs(r.ms)}</span>
            {r.deltaMs !== null && (
              <span className="stack-legend-delta">
                {Math.abs(r.deltaMs) < 0.5
                  ? <span className="delta" data-dir="same">·</span>
                  : <Delta ms={r.deltaMs} />}
              </span>
            )}
          </li>
        ))}
      </ul>

      <p className="chart-caption">
        {mover === null
          ? <><strong>{dominant.label}</strong> is the biggest cost here. Change that and
              the number moves; change anything else and it will not.</>
          : <><strong>{mover.label}</strong> moved most since your last run
              — {fmtDelta(mover.deltaMs)}. <strong>{dominant.label}</strong> is now the
              biggest remaining cost.</>}
      </p>
    </div>
  );
}

function Stat({ label, value, sub, state }: {
  label: string; value: string; sub?: string; state?: 'good' | 'bad';
}) {
  return (
    <div className="stat" data-state={state ?? 'neutral'}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub !== undefined && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Hud({ state, grading }: { state: GameState; grading: Grade | null }) {
  const metrics = state.result?.perClass['api-read'];
  const cost = state.result?.cost.totalUsdMonth ?? 0;

  if (state.result === null || metrics === undefined) {
    return (
      <div className="hud hud-empty">
        <div className="hud-empty-mark" aria-hidden="true" />
        <h2>Nothing has been measured yet</h2>
        <p className="muted">
          Send traffic through your design to find out what users would actually
          experience.
        </p>
      </div>
    );
  }

  const sloMet = metrics.p99Ms <= LEVEL.sloP99Ms && metrics.errorRatePct <= 1;

  return (
    <div className="hud">
      <div className="hero" data-state={sloMet ? 'good' : 'bad'}>
        <div className="hero-label">p99 latency</div>
        <div className="hero-value">{fmtMs(metrics.p99Ms)}</div>
        <div className="hero-sub">
          {sloMet
            ? `comfortably under the ${LEVEL.sloP99Ms}ms target`
            : `${fmtMs(metrics.p99Ms - LEVEL.sloP99Ms)} over the ${LEVEL.sloP99Ms}ms target`}
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="p50" value={fmtMs(metrics.p50Ms)} sub="typical request" />
        <Stat label="p95" value={fmtMs(metrics.p95Ms)} sub="unlucky request" />
        <Stat
          label="Errors" value={`${metrics.errorRatePct.toFixed(1)}%`}
          sub={metrics.errorRatePct > 1 ? 'requests never answered' : 'within tolerance'}
          state={metrics.errorRatePct <= 1 ? 'good' : 'bad'}
        />
        <Stat
          label="Cost" value={`$${Math.round(cost)}`}
          sub={`per month · budget $${LEVEL.budgetUsdMonth}`}
          state={cost <= LEVEL.budgetUsdMonth ? 'good' : 'bad'}
        />
      </div>

      <Sparkline state={state} />
      <Waterfall state={state} />

      {grading !== null && (
        <div className="grade">
          <div className="grade-head">
            <span className="grade-stars" aria-label={`${grading.stars} of 3 objectives met`}>
              {[0, 1, 2].map((i) => (
                <span key={i} className="grade-star" data-earned={i < grading.stars}>★</span>
              ))}
            </span>
            <span className="muted">{grading.stars} of 3</span>
          </div>
          <ul className="grade-list">
            {LEVEL.objectives.map((o) => {
              const met = o.id === 'slo' ? grading.sloMet
                : o.id === 'budget' ? grading.underBudget
                  : grading.resilient;
              return (
                <li key={o.id} data-met={met}>
                  <span className="grade-mark" aria-hidden="true">
                    {met ? '✓' : <TriangleAlert size={13} strokeWidth={2.2} />}
                  </span>
                  <span>
                    <strong>{o.label}</strong>
                    <span className="muted"> — {o.detail}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
