import { protocolId, type ProtocolId, type ProtocolProfile } from '@nb/schema';

/**
 * Protocol profiles, keyed by id.
 *
 * Handshake cost is a property of the link, not the node - day-one commitment
 * #3. This is where TLS, QUIC, keep-alive and mTLS all plug in, which is why
 * Act VI needs no new simulation primitives.
 */

export const HTTP2_TLS13: ProtocolProfile = {
  id: protocolId('http2-tls13'),
  handshakeRtts: 2, // TCP 1 + TLS 1.3 1
  connectionReuse: 0.9,
  cryptoCpuMs: 1,
};

export const HTTP1_TLS12: ProtocolProfile = {
  id: protocolId('http1-tls12'),
  handshakeRtts: 3, // TCP 1 + TLS 1.2 2
  connectionReuse: 0.5,
  cryptoCpuMs: 2,
};

export const HTTP3_QUIC: ProtocolProfile = {
  id: protocolId('http3-quic'),
  handshakeRtts: 0, // 0-RTT resumption
  connectionReuse: 0.95,
  cryptoCpuMs: 1,
};

/** Internal service-to-service, mutually authenticated. Act VI. */
export const MTLS_GRPC: ProtocolProfile = {
  id: protocolId('mtls-grpc'),
  handshakeRtts: 2,
  connectionReuse: 0.95,
  cryptoCpuMs: 2,
  requiresClientCert: true,
};

/** Pooled database connections: no per-request handshake at all. */
export const PLAIN_TCP: ProtocolProfile = {
  id: protocolId('plain-tcp'),
  handshakeRtts: 1,
  connectionReuse: 0.99,
  cryptoCpuMs: 0,
};

export const PROTOCOLS: ReadonlyMap<ProtocolId, ProtocolProfile> = new Map(
  [HTTP2_TLS13, HTTP1_TLS12, HTTP3_QUIC, MTLS_GRPC, PLAIN_TCP].map((p) => [p.id, p]),
);

export const DEFAULT_PROTOCOL = HTTP2_TLS13;
