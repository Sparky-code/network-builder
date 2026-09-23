import { useMemo } from 'react';
import { TriangleAlert } from 'lucide-react';
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
  const path = useMemo(() => {
    if (frames.length < 2) return null;
    const w = 300;
    const h = 64;
    const values = frames.map((f) => f.p99Ms);
    const peak = Math.max(LEVEL.sloP99Ms * 1.4, ...values);
    const x = (i: number): number => (i / (frames.length - 1)) * w;
    const y = (v: number): number => h - (Math.min(v, peak) / peak) * h;
    return {
      w, h, peak,
      line: values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
      area: `M0,${h} ${values.map((v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} L${w},${h} Z`,
      sloY: y(LEVEL.sloP99Ms),
      headX: x(Math.max(0, state.playhead)),
      headY: y(values[Math.max(0, state.playhead)] ?? 0),
    };
  }, [frames, state.playhead]);

  if (path === null) return null;

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="chart-title">p99 latency over the run</span>
        <span className="chart-note">target under {LEVEL.sloP99Ms}ms</span>
      </div>
      <svg viewBox={`0 0 ${path.w} ${path.h}`} className="sparkline" role="img"
        aria-label={`p99 latency over time, target under ${LEVEL.sloP99Ms} milliseconds`}>
        <path d={path.area} className="sparkline-area" />
        {/* Recessive reference line: the chart's actual question. */}
        <line x1="0" x2={path.w} y1={path.sloY} y2={path.sloY} className="sparkline-slo" />
        <path d={path.line} className="sparkline-line" />
        <circle cx={path.headX} cy={path.headY} r="3.5" className="sparkline-head" />
      </svg>
    </div>
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
function Waterfall({ state }: { state: GameState }) {
  const w = state.result?.attribution;
  if (w === undefined) return null;

  const rows = [
    { label: 'DNS', ms: w.dnsMs },
    { label: 'TCP + TLS', ms: w.setupMs },
    { label: 'Network', ms: w.propagationMs },
    { label: 'Queueing', ms: w.queueMs },
    { label: 'Server work', ms: w.serviceMs },
    { label: 'Transfer', ms: w.transferMs },
  ].filter((r) => r.ms > 0.01);

  const total = rows.reduce((a, r) => a + r.ms, 0);
  if (total <= 0) return null;

  const dominant = rows.reduce((a, b) => (b.ms > a.ms ? b : a));

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
          </li>
        ))}
      </ul>

      <p className="chart-caption">
        <strong>{dominant.label}</strong> is the biggest cost here. Change that and the
        number moves; change anything else and it will not.
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
