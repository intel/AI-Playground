import type { ArtifactsScope } from '@/lib/sessionTabs'
import type { SessionArtifact } from '@/types/sessionIpc'

export function artifactsInScope(
  artifacts: SessionArtifact[],
  scope: ArtifactsScope,
  openSessionId: string | null,
): SessionArtifact[] {
  if (scope === 'all-sessions') return artifacts
  return artifacts.filter((artifact) => artifact.sessionId === openSessionId)
}
