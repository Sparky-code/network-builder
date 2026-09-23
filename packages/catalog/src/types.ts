import type { ComponentTypeId, JsonValue } from '@nb/schema';
import type { AdmissionSpec, RoutingSpec } from '@nb/sim';
import type { z } from 'zod';

/**
 * The catalog is the only place where game concepts meet simulation primitives.
 *
 * `@nb/sim` knows Station, Policy and Controller. It does not know what a CDN
 * is, or a pod, or a WAF. Keeping that translation here is what lets Acts V and
 * VI add content instead of machinery.
 */

/** Wire protocol spoken by a port. Mismatched protocols cannot connect. */
export type PortProtocol = 'http' | 'grpc' | 'sql' | 'dns' | 'tcp';

/**
 * Semantic properties a connection carries, beyond its protocol.
 *
 * These are what let Act VI work without new machinery: a component can require
 * `tls-terminated` or `authenticated` on its inbound port and the same validator
 * enforces it, with no security-specific code path.
 */
export type CapabilityTag =
  | 'tls-terminated'
  | 'authenticated'
  | 'rate-limited'
  | 'inspected';

export interface Port {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly protocol: PortProtocol;
  /** What a connection leaving this port carries. */
  readonly provides?: readonly CapabilityTag[];
  /** What this port demands of anything connecting to it. */
  readonly accepts?: readonly CapabilityTag[];
  readonly minDegree: number;
  readonly maxDegree: number;
}

/** How a component instantiates as a simulation station. */
export interface StationTemplate {
  /** Concurrency. `'infinite'` marks a traffic source or a pass-through tier. */
  readonly servers: number | 'infinite';
  readonly serviceMeanMs: number;
  readonly serviceCv2: number;
  readonly queueLimitPerServer?: number;
  readonly cryptoCpuMs?: number;
  readonly admission?: readonly AdmissionSpec[];
  readonly routing: RoutingSpec;
}

export interface CostSpec {
  readonly usdPerServerMonth: number;
  readonly usdFixedMonth: number;
  /** Egress from this tier. Edge egress is cheaper than origin egress. */
  readonly tier: 'edge' | 'origin';
}

export interface ComponentType {
  readonly id: ComponentTypeId;
  readonly label: string;
  /** The act that introduces this component. Used for progressive unlocking. */
  readonly act: 1 | 2 | 3 | 4 | 5 | 6;
  readonly summary: string;
  readonly ports: readonly Port[];
  readonly simTemplate: StationTemplate;
  readonly cost: CostSpec;
  /** Player-editable knobs, validated when a level or a save is loaded. */
  readonly configSchema: z.ZodTypeAny;
  /** Lesson id explaining this component, surfaced on a rejected connection. */
  readonly learnMoreId?: string;
}

export type Catalog = ReadonlyMap<ComponentTypeId, ComponentType>;

export type DiagCode =
  | 'unknown-component'
  | 'unknown-port'
  | 'protocol-mismatch'
  | 'missing-capability'
  | 'degree-exceeded'
  | 'degree-unmet'
  | 'self-connection'
  | 'duplicate-edge'
  | 'unreachable-origin'
  | 'no-entry-point'
  | 'http-cycle'
  | 'single-point-of-failure'
  | 'invalid-config';

export interface Diagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: DiagCode;
  readonly message: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly hint?: string;
  /**
   * Turns a mistake into a teaching moment. In a game about infrastructure, the
   * instant a player wires something wrong is the best opportunity to explain
   * why - throwing that away on a bare "invalid connection" wastes what the
   * validator already knows.
   */
  readonly learnMoreId?: string;
}

export type ConnectionCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: DiagCode;
      readonly message: string;
      readonly learnMoreId?: string;
    };

export type ConfigOf<T extends ComponentType> = z.infer<T['configSchema']>;
export type NodeConfig = Readonly<Record<string, JsonValue>>;
