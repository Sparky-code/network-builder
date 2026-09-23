import type { RateProfile } from '@nb/schema';

/** Offered rate for a demand profile at a given simulated second. */
export function rateAt(profile: RateProfile, tSec: number, durationSec: number): number {
  switch (profile.kind) {
    case 'constant':
      return profile.rps;
    case 'ramp': {
      const f = durationSec > 0 ? Math.min(1, Math.max(0, tSec / durationSec)) : 1;
      return profile.fromRps + (profile.toRps - profile.fromRps) * f;
    }
    case 'spike': {
      const inSpike = tSec >= profile.atSec && tSec < profile.atSec + profile.durationSec;
      return inSpike ? profile.peakRps : profile.baseRps;
    }
    case 'diurnal': {
      const phase = (2 * Math.PI * tSec) / profile.periodSec;
      return Math.max(0, profile.meanRps * (1 + profile.amplitude * Math.sin(phase)));
    }
  }
}
