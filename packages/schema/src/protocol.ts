import type { ProtocolId, RegionId } from './ids';

/**
 * Handshake cost is a property of the link, not the node — day-one
 * commitment #3. This is where TLS, QUIC, keep-alive and mTLS all plug in.
 */
export interface ProtocolProfile {
  readonly id: ProtocolId;
  /** TCP 1 + TLS1.2 2 = 3; TCP 1 + TLS1.3 1 = 2; QUIC 0-RTT = 0. */
  readonly handshakeRtts: number;
  /** 0..1 — keep-alive pool effectiveness. 1 means every request reuses. */
  readonly connectionReuse: number;
  /** Per-handshake CPU, charged to the terminating station. */
  readonly cryptoCpuMs: number;
  /** mTLS: costs an extra RTT and doubles crypto CPU. */
  readonly requiresClientCert?: boolean;
}

export interface Link {
  readonly fromRegion: RegionId;
  readonly toRegion: RegionId;
  readonly rttMs: number;
  readonly bandwidthMbps: number;
  readonly protocol: ProtocolProfile;
}
