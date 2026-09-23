/**
 * Branded identifier types.
 *
 * These are strings at runtime and distinct types at compile time, so a
 * RegionId cannot be passed where a NodeId is expected. That matters most in
 * `@nb/content`, where a level author wires dozens of ids together by hand.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type NodeId = Brand<string, 'NodeId'>;
export type EdgeId = Brand<string, 'EdgeId'>;
export type RegionId = Brand<string, 'RegionId'>;
export type ClassId = Brand<string, 'ClassId'>;
export type ComponentTypeId = Brand<string, 'ComponentTypeId'>;
export type ProtocolId = Brand<string, 'ProtocolId'>;

export const nodeId = (s: string): NodeId => s as NodeId;
export const edgeId = (s: string): EdgeId => s as EdgeId;
export const regionId = (s: string): RegionId => s as RegionId;
export const classId = (s: string): ClassId => s as ClassId;
export const componentTypeId = (s: string): ComponentTypeId => s as ComponentTypeId;
export const protocolId = (s: string): ProtocolId => s as ProtocolId;
