import { describe, expect, it } from 'vitest'
import { artifactsInScope } from '@/lib/artifactsInScope'
import type { SessionArtifact } from '@/types/sessionIpc'

function artifact(sessionId: string, name: string): SessionArtifact {
  return {
    sessionId,
    sessionTitle: sessionId,
    entryId: name,
    timestamp: 0,
    preset: 'Dummy Image (test)',
    kind: 'image',
    prompt: name,
    path: `files/${name}`,
    mediaType: 'image',
    url: `aipg-media://sessions/${sessionId}/files/${name}`,
  }
}

const listed = [
  artifact('a', 'fox.png'),
  artifact('b', 'owl.png'),
  artifact('a', 'cat.mp4'),
  artifact('b', 'song.wav'),
  artifact('a', 'cube.glb'),
]

describe('artifactsInScope', () => {
  it("keeps only the open Session's Artifacts, in listed order, for This Session", () => {
    expect(artifactsInScope(listed, 'this-session', 'a').map((a) => a.prompt)).toEqual([
      'fox.png',
      'cat.mp4',
      'cube.glb',
    ])
  })

  it('keeps everything for All Sessions', () => {
    expect(artifactsInScope(listed, 'all-sessions', 'a')).toEqual(listed)
  })

  it('yields nothing for a Session that made nothing', () => {
    expect(artifactsInScope(listed, 'this-session', 'empty')).toEqual([])
  })

  it('yields nothing for This Session when no Session is open', () => {
    expect(artifactsInScope(listed, 'this-session', null)).toEqual([])
  })
})
