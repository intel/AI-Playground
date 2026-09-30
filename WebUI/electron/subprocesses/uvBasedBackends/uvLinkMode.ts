/**
 * Shared installs copy wheels into the tree. A hardlink or same-volume move
 * keeps the uv-cache ACL, so those files never inherit the folder grant.
 */
export function withSharedUvLinkMode<T extends Record<string, string | undefined>>(
  env: T,
  shared: boolean,
): T {
  if (!shared) return env
  return { ...env, UV_LINK_MODE: 'copy' }
}
