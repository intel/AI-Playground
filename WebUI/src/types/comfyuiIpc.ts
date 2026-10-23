/**
 * ComfyUI tooling IPC (`comfyui:*` channels): custom-node identification the
 * renderer ships and the installer in main resolves. The repo coordinates are
 * enough to clone, pin a ref, and find the folder under custom_nodes/ again.
 */

/** A custom-node repo by GitHub coordinates, with an optional ref to check out. */
export type ComfyUICustomNodeRepoId = {
  username: string
  repoName: string
  gitRef?: string
}
