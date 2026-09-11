/**
 * User-facing name of the remote-inference feature.
 *
 * "Cloud" described one option rather than the feature: it adds hosted, cloud and
 * LAN OpenAI-compatible endpoints alongside the local engines, so a session can
 * be any mix of the two. The internal identifiers stay `cloud` / `cloud-mode` —
 * they are wire keys, not copy.
 */
export const HYBRID_CLOUD_NAME = 'Hybrid Cloud'
