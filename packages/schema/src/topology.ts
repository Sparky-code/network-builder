import type { ComponentTypeId, EdgeId, NodeId, ProtocolId, RegionId } from './ids';

export type JsonValue =
  | string | number | boolean | null
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

export interface PortRef {
  readonly nodeId: NodeId;
  readonly portId: string;
}

export interface TopologyNode {
  readonly id: NodeId;
  readonly typeId: ComponentTypeId;
  readonly regionId: RegionId;
  readonly config: Readonly<Record<string, JsonValue>>;
}

export interface TopologyEdge {
  readonly id: EdgeId;
  readonly from: PortRef;
  readonly to: PortRef;
  readonly config: {
    readonly protocolId: ProtocolId;
    /** Relative share for weighted routing. Defaults to 1. */
    readonly weight?: number;
  };
}

/**
 * The semantic graph. Deliberately excludes node positions: `inputHash` is
 * computed over this, so tidying up the diagram never invalidates a cached run.
 */
export interface Topology {
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
}

/** Presentation only. Never reaches the simulator. */
export interface Layout {
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
}
