import type { RunResult } from '@nb/schema';

/**
 * What happened during a run, in words.
 *
 * Playtest finding: a player could see *something* going wrong at the origin —
 * colours changing, a queue filling — without being able to say what. Shape and
 * hue can signal that a state exists; only language can say which state, when it
 * started, and how bad it is.
 *
 * Derived from the frames rather than instrumented in the engine, so the feed
 * cannot disagree with the run it describes.
 */

/**
 * Each kind names one distinct thing that happened.
 *
 * `shedding-ended` and `recovering` were originally one kind, which collided as
 * a React key when both fired in the same frame - they do, at the moment a
 * spike ends - and the feed rendered an entry twice, out of order. Two events
 * that a player can tell apart need names the code can tell apart too.
 */
export type EventKind =
  | 'overload'
  | 'shedding'
  | 'shedding-ended'
  | 'recovering'
  | 'settled';

export interface RunEvent {
  readonly atSec: number;
  readonly frame: number;
  readonly nodeId: string;
  readonly kind: EventKind;
  readonly headline: string;
  readonly detail: string;
  readonly severity: 'info' | 'warning' | 'alarm';
}

/** Utilization above this is overload: arrivals exceed what the station can serve. */
const OVERLOAD = 1;

export function deriveEvents(result: RunResult): readonly RunEvent[] {
  const events: RunEvent[] = [];
  const state = new Map<string, { overloaded: boolean; shedding: boolean; hadBacklog: boolean }>();

  result.frames.forEach((f, i) => {
    for (const nodeId of Object.keys(f.stations).sort()) {
      const s = f.stations[nodeId];
      if (s === undefined) continue;
      const prev = state.get(nodeId) ?? { overloaded: false, shedding: false, hadBacklog: false };
      const overloaded = s.utilization >= OVERLOAD;
      const shedding = s.droppedRps > 0;
      const hasBacklog = s.backlogReqs > 0.5;

      const push = (
        kind: EventKind, headline: string, detail: string,
        severity: RunEvent['severity'],
      ): void => {
        events.push({ atSec: f.simTimeSec, frame: i, nodeId, kind, headline, detail, severity });
      };

      if (overloaded && !prev.overloaded) {
        push('overload', `${nodeId} is overloaded`,
          `${Math.round(s.utilization * 100)}% of capacity — requests are arriving faster than it can serve them, so a queue is forming.`,
          'warning');
      }
      if (shedding && !prev.shedding) {
        push('shedding', `${nodeId} is refusing requests`,
          `Its queue is full, so ${Math.round(s.droppedRps)} requests a second are being turned away. These are errors the user sees.`,
          'alarm');
      }
      if (!shedding && prev.shedding) {
        push('shedding-ended', `${nodeId} stopped refusing requests`,
          'The queue is no longer full, but the backlog still has to be worked through before latency returns to normal.',
          'warning');
      }
      if (!overloaded && prev.overloaded && hasBacklog) {
        push('recovering', `${nodeId} is working through its backlog`,
          'Arrivals are back under capacity. Recovery is slower than the collapse was, because the queue drains at whatever headroom is left over.',
          'info');
      }
      if (!hasBacklog && prev.hadBacklog && !overloaded) {
        push('settled', `${nodeId} has caught up`, 'The queue is empty and latency is back to normal.', 'info');
      }

      state.set(nodeId, { overloaded, shedding, hadBacklog: hasBacklog });
    }
  });

  return events;
}

/** Events that have happened by a given point in playback. */
export function eventsUpTo(events: readonly RunEvent[], frame: number): readonly RunEvent[] {
  return events.filter((e) => e.frame <= frame);
}
