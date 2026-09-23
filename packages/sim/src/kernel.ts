import { erlangC, meanWaitMs } from './math/erlang';
import { invNorm } from './math/invnorm';

/**
 * A station's response-time distribution, as a closed-form invertible CDF.
 *
 * Latency is a distribution object, not a number — day-one commitment #5. A
 * mean cannot be composed into a believable p99, and retrofitting distributions
 * through an engine written around scalars is a full rewrite of the metrics
 * path.
 */
export interface LatencyKernel {
  /** Erlang C: probability of queueing at all. */
  readonly pWait: number;
  /** Rate of the exponential wait component, in Hz. */
  readonly waitRateHz: number;
  readonly serviceMeanMs: number;
  readonly serviceCv2: number;
  /**
   * Lognormal is the production choice: one smooth family across the whole
   * Cv2 range, and invertible in closed form. Exponential exists so the
   * analytic oracle can check an exact M/M/1 sojourn — see test/analytic-oracle.
   */
  readonly serviceDist: 'lognormal' | 'exponential';
  /** Deterministic part: propagation + setup + DNS + transfer. */
  readonly fixedMs: number;
  /** Attribution split of fixedMs. Sums to fixedMs. */
  readonly fixed: {
    readonly dnsMs: number;
    readonly setupMs: number;
    readonly propagationMs: number;
    readonly transferMs: number;
  };
}

export interface KernelInput {
  readonly servers: number;
  readonly serviceMeanMs: number;
  readonly serviceCv2: number;
  readonly arrivalRps: number;
  readonly arrivalCv2: number;
  /** Queue already standing at this station, from the saturation integrator. */
  readonly backlogReqs?: number;
  readonly serviceDist?: 'lognormal' | 'exponential';
  readonly fixed?: {
    readonly dnsMs?: number;
    readonly setupMs?: number;
    readonly propagationMs?: number;
    readonly transferMs?: number;
  };
}

const ZERO_FIXED = { dnsMs: 0, setupMs: 0, propagationMs: 0, transferMs: 0 } as const;

/**
 * Utilization ceiling used in the steady-state term, to keep 1/(1-rho) finite.
 * At 0.995 the predicted wait is already ~200 service times.
 */
const RHO_CAP = 0.995;

export function buildKernel(input: KernelInput): LatencyKernel {
  const {
    servers, serviceMeanMs, serviceCv2, arrivalRps, arrivalCv2,
    backlogReqs = 0, serviceDist = 'lognormal',
  } = input;

  const dnsMs = input.fixed?.dnsMs ?? 0;
  const setupMs = input.fixed?.setupMs ?? 0;
  const propagationMs = input.fixed?.propagationMs ?? 0;
  const transferMs = input.fixed?.transferMs ?? 0;
  const fixedMs = dnsMs + setupMs + propagationMs + transferMs;

  const serviceRateHz = servers / (serviceMeanMs / 1000);
  const a = (arrivalRps * serviceMeanMs) / 1000;
  const rho = a / servers;

  let pWait: number;
  let waitMeanMs: number;

  if (!Number.isFinite(servers)) {
    // An infinite-server station has no queue by definition.
    pWait = 0;
    waitMeanMs = 0;
  } else {
    /*
     * One continuous expression across the whole load range:
     *
     *   wait = steadyStateWait(min(rho, RHO_CAP)) + backlogWait
     *
     * Splitting this into a stable branch and a saturated branch produced a
     * discontinuity exactly at rho = 1, where excess arrivals are zero so no
     * backlog accumulates, and the steady-state term was being skipped - a
     * station at precisely capacity reported no queueing at all, which is the
     * opposite of the truth.
     *
     * RHO_CAP keeps the 1/(1-rho) term finite. At the cap the steady-state wait
     * is already ~200 service times, so anything beyond it is dominated by the
     * backlog term anyway.
     */
    const rhoEff = Math.min(rho, RHO_CAP);
    const arrivalEff = (rhoEff * servers * 1000) / serviceMeanMs;
    const steadyWait = meanWaitMs(servers, serviceMeanMs, arrivalEff, arrivalCv2, serviceCv2);
    const backlogWait = (backlogReqs / serviceRateHz) * 1000;

    pWait = rho >= 1 ? 1 : erlangC(servers, a);
    waitMeanMs = (Number.isFinite(steadyWait) ? steadyWait : 0) + backlogWait;
  }



  if (!Number.isFinite(waitMeanMs)) waitMeanMs = 0;

  // Choose the exponential rate so that E[wait] matches the mean above. This is
  // what makes the M/M/1 case exact: pWait = rho and Wq = rho*S/(1-rho) give
  // rate = (1-rho)/S = mu - lambda, the textbook waiting rate.
  const waitRateHz = waitMeanMs > 0 && pWait > 0 ? pWait / (waitMeanMs / 1000) : 0;

  return {
    pWait,
    waitRateHz,
    serviceMeanMs,
    serviceCv2,
    serviceDist,
    fixedMs,
    fixed: fixedMs === 0 ? ZERO_FIXED : { dnsMs, setupMs, propagationMs, transferMs },
  };
}

/** Inverse of the wait component. Returns ms. */
export function invWaitMs(k: LatencyKernel, u: number): number {
  if (k.pWait <= 0 || k.waitRateHz <= 0) return 0;
  if (u >= k.pWait) return 0;
  return (-Math.log(1 - u / k.pWait) / k.waitRateHz) * 1000;
}

/** Inverse of the service component. Returns ms. */
export function invServiceMs(k: LatencyKernel, u: number): number {
  if (k.serviceMeanMs <= 0) return 0;
  if (k.serviceDist === 'exponential') {
    return -k.serviceMeanMs * Math.log(1 - u);
  }
  if (k.serviceCv2 <= 0) return k.serviceMeanMs;
  const s2 = Math.log(1 + k.serviceCv2);
  const mu = Math.log(k.serviceMeanMs) - s2 / 2;
  return Math.exp(mu + Math.sqrt(s2) * invNorm(u));
}

/**
 * Full inverse CDF at a pair of independent uniforms.
 *
 * Two uniforms rather than one because wait and service are independent
 * components; sharing a single uniform would correlate them and distort the
 * tail, which is the part we care most about.
 */
export function invKernel(k: LatencyKernel, uWait: number, uService: number): number {
  return k.fixedMs + invWaitMs(k, uWait) + invServiceMs(k, uService);
}
