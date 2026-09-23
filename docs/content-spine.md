# Content spine

All 41 campaign levels and 5 chaos set-pieces. Each level introduces **exactly one**
concept and is named for the lesson rather than the component — "The Speed of Light Is a
Budget", not "Add a second region".

Each entry records:

- **Concept** — the single idea the level exists to deliver.
- **Mechanic** — what the player does, and what the simulation shows them.
- **Target** — the SLO and budget that define passing.
- **Deep dive** — the vocabulary revealed in the opt-in expert layer.
- **CI claim** — the `demonstrations` assertion that keeps this lesson honest. If tuning
  ever makes the claim false, CI fails by name instead of shipping a level that teaches
  something untrue. See [`architecture.md`](architecture.md) §5.

Star grading throughout: ★ SLO met · ★★ under budget · ★★★ survives the chaos event.

---

## Act I — The Request

Four levels, one origin, no distractions. The player learns to read a request before they
are allowed to change one.

### 1. Anatomy of a Request
- **Concept** — a request is a sequence of round trips, not an instant.
- **Mechanic** — one client, one origin, low traffic. The attribution waterfall opens for
  the first time and shows DNS → TCP → TLS → HTTP as separate bars.
- **Target** — none. This level cannot be failed; it exists to teach the instrument.
- **Deep dive** — resolver delegation depth, TCP three-way handshake, TLS 1.3 vs 1.2 round
  trips.
- **CI claim** — `handshake bars sum to roughly 3× RTT on a cold TLS 1.2 connection`.

### 2. The Speed of Light Is a Budget
- **Concept** — distance is a cost you cannot buy your way out of.
- **Mechanic** — the same topology, but the client moves to another continent. Nothing
  else changes and latency roughly quadruples. Upgrading the server does nothing, which
  is the point.
- **Target** — p99 < 400ms for a transatlantic user. Passable, but uncomfortable.
- **Deep dive** — great-circle distance, refractive index of fiber, path detour factor.
- **CI claim** — `a bigger origin does not improve p99 for a distant client`.

### 3. One Server, Too Many Users
- **Concept** — queueing delay explodes long before capacity runs out.
- **Mechanic** — a traffic slider. The player raises rps and watches p99 curve upward
  while the origin still reports spare capacity. Meeting ρ and the hockey stick.
- **Target** — p99 < 200ms at 800 rps.
- **Deep dive** — utilization ρ, Erlang C, Little's law, the `1/(1−ρ)` term.
- **CI claim** — `p99 at ρ=0.85 is more than 3× p99 at ρ=0.50`.

### 4. Vertical vs Horizontal
- **Concept** — two ways to add capacity, with different cost curves and different failure
  behaviour.
- **Mechanic** — one bigger box or three smaller ones, at comparable cost. Both pass the
  SLO; only one survives losing a node, which foreshadows Act II.
- **Target** — p99 < 200ms at 2,000 rps, under $900/mo.
- **Deep dive** — scale-up vs scale-out, single point of failure, N+1.
- **CI claim** — `the three-node solution keeps serving when one node is removed; the single large node does not`.

---

## Act II — The Local Site

Five levels plus the first chaos event. One site, made properly resilient.

### 5. Something Has to Choose
- **Concept** — something has to decide which backend serves each request.
- **Mechanic** — round-robin against least-connections, with deliberately uneven service
  times so the two visibly diverge at the tail.
- **Target** — p99 < 150ms at 3,000 rps.
- **Deep dive** — L4 vs L7, connection vs request balancing, head-of-line blocking.
- **CI claim** — `least-connections beats round-robin on p99 when backend service times are uneven`.

### 6. Health Checks
- **Concept** — failover is never instant, and the delay is something you configure.
- **Mechanic** — a backend dies. Without probes, traffic keeps flowing into it and errors
  persist. With probes, the player tunes `interval` and `threshold` and watches detection
  lag shrink — and watches false positives appear if they tune too aggressively.
- **Target** — error rate < 1% across a mid-run backend failure.
- **Deep dive** — active vs passive checks, `interval × threshold` as minimum outage,
  flapping, hysteresis.
- **CI claim** — `error duration after a backend failure is within one probe window of interval × threshold`.

### 7. Session Affinity
- **Concept** — state is what makes servers hard to replace.
- **Mechanic** — a stateful app breaks under round-robin. Sticky sessions fix it
  immediately but unbalance the load; externalising session state fixes it properly and
  costs a hop. The game grades the second answer higher.
- **Target** — 0% session errors, p99 < 180ms.
- **Deep dive** — sticky sessions, consistent hashing, externalised state, cattle vs pets.
- **CI claim** — `sticky sessions raise p99 tail imbalance relative to externalised state at equal rps`.

### 8. Keep-Alive & Pooling
- **Concept** — the handshakes from level 1 can be amortised, and the saving scales with
  RTT.
- **Mechanic** — connection reuse slider from 0 to 0.95. The saving is dramatic for the
  distant client from level 2 and nearly invisible for the local one.
- **Target** — p99 < 120ms at 5,000 rps without adding capacity.
- **Deep dive** — keep-alive, connection pools, HTTP/2 multiplexing, pool exhaustion.
- **CI claim** — `raising connection reuse lowers p99 more for a 140ms-RTT client than for a 2ms-RTT client`.

### 9. The Database Is the Bottleneck
- **Concept** — variance matters as much as utilization.
- **Mechanic** — scaling app servers stops helping. The database sits at 60% utilization
  and still queues badly, because its Cv² is 4.0. Read replicas and pool limits are the
  levers.
- **Target** — p99 < 200ms at 6,000 rps.
- **Deep dive** — coefficient of variation, connection pool sizing, read replicas,
  replication lag.
- **CI claim** — `a Cv²=4.0 station at ρ=0.6 has higher p99 than a Cv²=0.5 station at ρ=0.85`.

### ⚡ Chaos 1 — Peak Day
10× traffic against the site the player built in levels 5–9. Whatever they skimped on
fails first. Survival requires headroom, shedding, or both — and the post-mortem names
which of their own earlier choices decided the outcome.

---

## Act III — Caching

Seven levels. The densest act, and the one that most changes how a player thinks.

### 10. The Cache Tier
- **Concept** — origin load is `1 − hitRatio`, so the last points are worth the most.
- **Mechanic** — a cache in front of the origin. The player watches origin rps collapse as
  hit ratio climbs, and sees the halving from 90% → 95% directly.
- **Target** — origin < 500 rps at 10,000 rps offered.
- **Deep dive** — origin offload, byte hit ratio vs request hit ratio.
- **CI claim** — `raising hit ratio from 0.90 to 0.95 halves origin request rate`.

### 11. TTL & Freshness
- **Concept** — every cache trades staleness for load, and you choose the exchange rate.
- **Mechanic** — a TTL dial with a staleness meter beside the load meter. Content has an
  authored update rate, so long TTLs visibly serve stale data.
- **Target** — origin < 400 rps with staleness under the level's tolerance.
- **Deep dive** — `Cache-Control`, `s-maxage`, `must-revalidate`, ETags.
- **CI claim** — `raising TTL monotonically lowers origin rate and monotonically raises staleness`.

### 12. Cache Keys
- **Concept** — hit ratio is designed, not wished for.
- **Mechanic** — the app appends a tracking query string. Hit ratio collapses to near zero
  with no other change. The player normalises the key, then meets `Vary` and cookies.
- **Target** — restore hit ratio above 0.85 without changing TTL.
- **Deep dive** — cache key normalisation, `Vary`, cookie stripping, key cardinality.
- **CI claim** — `adding an unbounded query parameter to the cache key drops hit ratio below 0.1`.

### 13. Stale-While-Revalidate
- **Concept** — a user should not wait for your cache to refresh.
- **Mechanic** — with SWR off, every expiry produces a slow request. With it on, the
  refresh happens behind a stale response and the tail flattens.
- **Target** — p99 < 100ms with content no more than one TTL stale.
- **Deep dive** — `stale-while-revalidate`, `stale-if-error`, background revalidation.
- **CI claim** — `enabling stale-while-revalidate lowers p99 without raising origin rate`.

### 14. The Stampede
- **Concept** — synchronised expiry turns a hot object into an origin outage.
- **Mechanic** — every copy of a popular object expires in the same second. Origin rps
  spikes by the amplification factor `(1 + λᵢ·L)`, and the retry dynamic from the engine
  keeps it down after the spike ends. Request coalescing and TTL jitter are the fixes.
- **Target** — survive a synchronised expiry with error rate < 2%.
- **Deep dive** — request coalescing, TTL jitter, thundering herd, metastable failure.
- **CI claim** — `request coalescing reduces peak origin rate during synchronised expiry by more than 10×`.

### 15. Origin Shield
- **Concept** — edge hit ratio and total hit ratio are different numbers with different
  jobs.
- **Mechanic** — the HUD splits into two hit-ratio readouts. A shield collapses misses
  from every PoP into one upstream cache, raising total hit ratio while leaving edge hit
  ratio untouched — and adding one hop to every miss. The player weighs that tradeoff.
- **Target** — origin < 200 rps, p99 < 90ms.
- **Deep dive** — mid-tier caching, request collapsing at the shield, miss-path latency.
- **CI claim** — `a shield raises total hit ratio and lowers origin rate, while edge hit ratio is unchanged and miss-path latency rises`.

### 16. Purge & Invalidation
- **Concept** — you will eventually need to un-cache something, fast.
- **Mechanic** — a content update must propagate. Purge-by-URL is slow and partial; tag
  purge is immediate and wide. Cache warmth then visibly recovers over roughly one TTL.
- **Target** — full invalidation in < 10s, recover hit ratio > 0.85 within 60s.
- **Deep dive** — surrogate keys, tag purge, soft vs hard purge, cold-cache cost.
- **CI claim** — `after a full purge, hit ratio recovers to within 10% of its prior value in about one TTL`.

### ⚡ Chaos 2 — Mass Expiry
Every TTL in the estate lands in the same second. Whether the player jittered their TTLs
in level 14 decides whether this is an inconvenience or an outage.

---

## Act IV — Going Global

Six levels. The map opens and geography becomes a design material.

### 17. Many PoPs
- **Concept** — moving caches closer to users lowers latency *and lowers hit ratio*.
- **Mechanic** — the player adds PoPs across regions. Latency drops as expected. Then the
  origin load graph goes the wrong way, because each PoP now sees λ/n and amortises fewer
  misses per TTL window. This is the setup that makes level 15's shield land properly.
- **Target** — global p99 < 120ms without origin rps exceeding its prior peak.
- **Deep dive** — cache fragmentation, per-PoP λ, footprint vs efficiency.
- **CI claim** — `increasing PoP count at fixed total traffic lowers per-PoP hit ratio`.

### 18. GeoDNS
- **Concept** — users have to *find* the nearest PoP, and DNS remembers too long.
- **Mechanic** — geographic DNS steering works well until a PoP is drained, at which point
  resolver TTLs keep sending users to it for minutes after the change.
- **Target** — 95% of users routed to their nearest PoP.
- **Deep dive** — EDNS client subnet, resolver TTL, DNS caching layers, propagation delay.
- **CI claim** — `after a steering change, misrouted traffic persists for approximately the DNS TTL`.

### 19. Anycast
- **Concept** — one address, many locations, failover at routing speed.
- **Mechanic** — a head-to-head against level 18's GeoDNS on the identical failure. Anycast
  reconverges in seconds where DNS took minutes. The cost is losing per-user steering
  control and risking mid-session PoP flips.
- **Target** — failover in < 30s with error rate < 1%.
- **Deep dive** — BGP announcement, route convergence, PoP flap, session affinity at L3.
- **CI claim** — `anycast failover time is at least 5× faster than GeoDNS failover at equal DNS TTL`.

### 20. Regional Origins & Failover
- **Concept** — surviving a region loss requires headroom you paid for in advance.
- **Mechanic** — active-passive costs idle capacity; active-active uses it but must absorb
  the failed region's traffic. If the survivors were at 70%, the failover kills them too.
- **Target** — survive a full region loss with error rate < 1%.
- **Deep dive** — N+1 headroom, active-active vs active-passive, cascading overload.
- **CI claim** — `two active regions each at ρ>0.55 both saturate when one fails`.

### 21. Replication & Consistency
- **Concept** — writes cannot be everywhere at once.
- **Mechanic** — the first write path. A user writes in one region and reads from another;
  replication lag makes their own write invisible to them. The player picks a consistency
  model and pays for it in latency or in correctness.
- **Target** — read-after-write correctness for the writing user, p99 < 200ms.
- **Deep dive** — read-after-write, eventual consistency, quorum, CAP, coordination cost.
- **CI claim** — `routing reads to a lagging replica produces read-after-write violations; routing to the primary eliminates them at a latency cost`.

### 22. Traffic Steering
- **Concept** — you should be able to remove a PoP without dropping a request.
- **Mechanic** — drain a PoP for maintenance. Done abruptly, in-flight requests fail; done
  with connection draining and weight shifting, nobody notices.
- **Target** — drain a PoP with zero failed requests.
- **Deep dive** — connection draining, weighted steering, capacity-aware routing.
- **CI claim** — `gradual weight shift drains a PoP with zero errors; instant removal does not`.

### ⚡ Chaos 3 — Fiber Cut
A PoP goes dark mid-run with no warning. Anycast reconvergence, regional headroom and
cache warmth in the surviving PoPs all decide the outcome — every one of them a choice the
player already made.

---

## Act V — Containers & Orchestration

Ten levels. The same topology seen at a different altitude. Every concept here is a
re-parameterisation of something the player already built — which is the point, and is
said out loud in the lesson text.

### 23. From Server to Container
- **Concept** — an immutable image replaces a configured machine.
- **Mechanic** — the origin from Act I becomes a container. Deploy time collapses; config
  drift disappears; a cold start appears where there wasn't one.
- **Target** — none; a transition level.
- **Deep dive** — image layers, immutability, twelve-factor config, cold start.
- **CI claim** — `containerised origin has lower deploy time and non-zero cold-start latency`.

### 24. Pods & Replicas
- **Concept** — "more boxes" from level 4, now declarative.
- **Mechanic** — a replica count instead of individually placed servers. The player
  declares intent and a controller reconciles toward it.
- **Target** — p99 < 150ms at 4,000 rps.
- **Deep dive** — Deployment, ReplicaSet, reconciliation loop, desired vs actual state.
- **CI claim** — `replica count maps to station concurrency: 3 replicas matches the 3-node topology from level 4 within 5% on p99`.

### 25. Service & Discovery
- **Concept** — pods are ephemeral, so something stable must point at them.
- **Mechanic** — pods restart and change address. Direct wiring breaks; a Service keeps
  working because endpoints are updated behind a stable name.
- **Target** — zero errors across a pod restart.
- **Deep dive** — ClusterIP, cluster DNS, EndpointSlices, kube-proxy.
- **CI claim** — `pod replacement causes errors when addressed directly and none when addressed through a Service`.

### 26. Ingress
- **Concept** — this is the load balancer from level 5, wearing a different name.
- **Mechanic** — external traffic must enter the cluster. The lesson explicitly maps
  Ingress back to Act II's LB and names what is genuinely new: routing rules, TLS
  termination inside the cluster.
- **Target** — p99 < 150ms, all external traffic routed correctly.
- **Deep dive** — Ingress controller, Gateway API, L7 routing rules, TLS termination point.
- **CI claim** — `ingress-fronted topology and Act II LB topology produce p99 within 10% at equal load`.

### 27. Liveness vs Readiness
- **Concept** — conflating the two probes is a self-inflicted outage.
- **Mechanic** — a pod that is slow to warm up. With only a liveness probe, Kubernetes
  kills it repeatedly and never converges. With readiness, traffic waits until it is
  actually able to serve.
- **Target** — zero errors during a rolling start of 6 replicas.
- **Deep dive** — readiness gates endpoints, liveness restarts containers, startup probes,
  `initialDelaySeconds`.
- **CI claim** — `a slow-starting pod with only a liveness probe enters a restart loop; adding a readiness probe eliminates errors`.

### 28. Requests & Limits
- **Concept** — the scheduler needs to know what you need, and the limit is enforced.
- **Mechanic** — requests too low means noisy-neighbour contention; too high means pods go
  Pending because the `ResourcePool` cannot fit them. Memory limits OOMKill; CPU limits
  throttle silently, which is worse because latency rises with no error to point at.
- **Target** — all replicas scheduled, p99 < 180ms.
- **Deep dive** — requests vs limits, bin packing, OOMKilled, CFS throttling, QoS classes.
- **CI claim** — `raising requests beyond node capacity produces pending pods; a CPU limit below demand raises p99 without raising error rate`.

### 29. Autoscaling
- **Concept** — autoscaling is not free, and its lag is the whole story.
- **Mechanic** — an HPA on CPU against a traffic spike. Scale-up lags by metric window plus
  pod start time, so the spike is absorbed *late*. Tuning too tightly produces flapping.
- **Target** — survive a 5× spike with error rate < 2%.
- **Deep dive** — HPA, metric window, stabilisation window, flapping, cold start,
  over-provisioning as insurance.
- **CI claim** — `HPA response lag equals metric window plus pod start time; headroom reduces spike error rate more than a faster HPA does`.

### 30. Rolling, Blue/Green, Canary
- **Concept** — how you replace running code determines your blast radius.
- **Mechanic** — three strategies against the same bad release. Rolling with a high surge
  drops capacity mid-deploy; blue/green doubles cost but rolls back instantly; canary
  limits exposure to a fraction of users.
- **Target** — deploy a regression affecting < 5% of requests, then roll back.
- **Deep dive** — `maxSurge`, `maxUnavailable`, blue/green, canary analysis, rollback time.
- **CI claim** — `canary exposes a bad version to a bounded traffic fraction; rolling deploy exposes all traffic`.

### 31. StatefulSets & Storage
- **Concept** — state refuses to be cattle, and Act II level 7 already said so.
- **Mechanic** — the externalised session store from level 7 now needs stable identity and
  persistent volumes. Rescheduling is no longer free.
- **Target** — zero data loss across a node drain.
- **Deep dive** — StatefulSet, stable network identity, PersistentVolumeClaim, volume
  reattachment, ordered rollout.
- **CI claim** — `a stateless workload survives node drain with zero errors; a stateful one without persistent volumes loses data`.

### 32. Multi-Region Clusters
- **Concept** — Act IV's geography, now with orchestration on top.
- **Mechanic** — clusters in several regions behind the anycast layer from level 19. The
  control plane is regional; the traffic layer is global; the data layer still has the
  consistency problem from level 21.
- **Target** — global p99 < 130ms, survive a region loss.
- **Deep dive** — cluster federation, regional control planes, cross-region service
  discovery, data gravity.
- **CI claim** — `losing one regional cluster leaves global error rate under 1% when surviving regions have N+1 headroom`.

### ⚡ Chaos 4 — Bad Deploy
A rollout ships a version that crashes on startup. CrashLoopBackOff spreads through the
replica set while the HPA reacts to the falling capacity by adding more pods that also
crash. Readiness probes, surge settings and rollback speed decide how bad it gets.

---

## Act VI — Security

Nine levels. Security is introduced as something with a *cost*, measured in the same
latency and dollars the player has been optimising for six acts.

### 33. TLS Everywhere
- **Concept** — encryption has a location and a lifecycle, and both bite.
- **Mechanic** — where TLS terminates changes the handshake RTT cost from level 8. Then a
  certificate expires mid-run and everything stops at once.
- **Target** — all traffic encrypted, p99 < 130ms, survive a cert expiry.
- **Deep dive** — termination vs passthrough, SNI, cert rotation, OCSP stapling,
  expiry monitoring.
- **CI claim** — `terminating TLS at the edge lowers p99 versus terminating at origin for distant clients`.

### 34. WAF
- **Concept** — inspection costs latency, and false positives cost users.
- **Mechanic** — a WAF blocks an attack class, adds `inspectionMs` to *all* traffic, and
  has a tunable false-positive rate that rejects legitimate requests. Turning sensitivity
  up stops more attacks and more customers.
- **Target** — block > 95% of attack traffic with < 0.1% false positives, p99 < 150ms.
- **Deep dive** — managed rulesets, false positive vs false negative, detection vs
  blocking mode, tuning by observation.
- **CI claim** — `raising WAF sensitivity raises both attack block rate and legitimate request rejection rate`.

### 35. Rate Limiting & Bots
- **Concept** — you limit per identity, and picking the wrong identity breaks real users.
- **Mechanic** — a token bucket. Keyed by IP, it punishes everyone behind a NAT; keyed by
  API token or session, it works. Bucket size versus refill rate trades burst tolerance
  against protection.
- **Target** — absorb a scripted flood with < 0.5% legitimate requests rejected.
- **Deep dive** — token bucket, leaky bucket, per-key cardinality, burst allowance,
  `429` and `Retry-After`.
- **CI claim** — `IP-keyed rate limiting rejects more legitimate traffic than token-keyed limiting behind shared egress`.

### 36. DDoS
- **Concept** — volumetric and application-layer attacks are different problems.
- **Mechanic** — an L3/4 flood is absorbed by anycast capacity spread across PoPs — the
  level 19 investment paying off unexpectedly. An L7 flood looks like real traffic and
  reaches the origin, requiring the level 34 and 35 tooling instead.
- **Target** — maintain SLO for legitimate users through both attack types.
- **Deep dive** — volumetric vs application-layer, anycast absorption, scrubbing centres,
  challenge pages, always-on vs on-demand.
- **CI claim** — `anycast absorbs an L3/4 flood without origin impact; the same volume of L7 traffic reaches the origin`.

### 37. Zero Trust & mTLS
- **Concept** — internal traffic is not trustworthy, and proving identity costs a round
  trip on every hop.
- **Mechanic** — mTLS between services. Using the protocol profile from the engine, the
  p99 tax appears on *every* internal hop rather than once at the edge — visible
  immediately in the attribution waterfall.
- **Target** — all internal traffic mutually authenticated, p99 < 200ms.
- **Deep dive** — mTLS, SPIFFE identity, service mesh sidecars, certificate rotation,
  sidecar resource overhead.
- **CI claim** — `enabling mTLS raises p99 proportionally to internal hop count, not by a fixed amount`.

### 38. NetworkPolicy & Segmentation
- **Concept** — segmentation does not prevent a breach; it bounds one.
- **Mechanic** — default-allow lets a compromised frontend reach the database directly.
  Default-deny plus explicit policies contains it. The blast-radius readout makes the
  difference concrete.
- **Target** — zero unnecessary reachable paths; no legitimate traffic broken.
- **Deep dive** — default-deny, east-west traffic, blast radius, microsegmentation,
  least-privilege networking.
- **CI claim** — `under default-deny, a compromised frontend reaches strictly fewer services than under default-allow`.

### 39. Secrets & Least Privilege
- **Concept** — credentials spread unless something stops them.
- **Mechanic** — a leaked service account token. With broad RBAC it reaches everything;
  scoped to one namespace and one verb set, it is nearly useless. Secret rotation and
  short-lived credentials shrink the window further.
- **Target** — no service holds more privilege than it uses.
- **Deep dive** — RBAC verbs and scopes, service accounts, short-lived credentials, secret
  rotation, sprawl.
- **CI claim** — `a scoped token reaches fewer resources than a cluster-admin token in the same breach scenario`.

### 40. Supply Chain
- **Concept** — the code you did not write is still your attack surface.
- **Mechanic** — a compromised base image enters via a normal deploy. Admission control
  rejecting unsigned images blocks it at the door; without provenance checks it deploys
  cleanly and starts exfiltrating.
- **Target** — block the unsigned image without blocking legitimate deploys.
- **Deep dive** — image signing, SBOM, provenance attestation, admission controllers,
  dependency pinning.
- **CI claim** — `signature-verifying admission control rejects the compromised image and admits the signed one`.

### 41. Observability
- **Concept** — you cannot defend what you cannot see, which is why this is last.
- **Mechanic** — the same breach from level 38 replayed twice: once with no telemetry, and
  once with metrics, structured logs and traces. The attack is identical; only the
  detection time changes.
- **Target** — detect and localise the intrusion in < 60s.
- **Deep dive** — the three pillars, cardinality cost, sampling, distributed tracing,
  alert fatigue, mean time to detect.
- **CI claim** — `with tracing enabled the intrusion path is reconstructable from run output; without it, it is not`.

### ⚡ Chaos 5 — Breach Drill
Lateral movement from a compromised frontend, run **twice** — once against the player's
topology as built, once with segmentation, scoped credentials and telemetry enabled. The
two blast-radius diagrams side by side are the closing argument of the entire game.

---

## The Console

A terminal drawer, unlocked progressively, running the real commands that inspect what the
player built. It reads live simulation state, so output always agrees with the canvas.

| Unlocks after | Commands | What it makes concrete |
| --- | --- | --- |
| Act I | `dig`, `curl -sI` | The resolution and the response headers behind level 1's waterfall |
| Act III | `curl -sI` reading `x-cache`, `age` | Hit or miss, and how old the cached copy is |
| Act IV | `traceroute`, BGP route inspection | Which PoP a user actually reached, and why |
| Act V | `kubectl get/describe/scale/rollout` | Desired vs actual state, events, rollout progress |
| Act VI | `openssl s_client` | The certificate chain and negotiated protocol |

The Console is deliberately not a separate game mode. It is a second way to look at the
same running system — which is exactly the relationship these commands have to real
infrastructure.
