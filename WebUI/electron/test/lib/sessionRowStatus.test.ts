import { describe, expect, it } from 'vitest'
import { sessionRowMarker, sessionRowStatus } from '@/lib/sessionRowStatus'

const labels: Record<string, string> = {
  HISTORY_STATUS_RUNNING: 'Running',
  HISTORY_STATUS_QUEUED: 'Queued',
  HISTORY_STATUS_QUEUED_AT: 'Queued, position {position}',
  HISTORY_STATUS_PAUSED: 'Needs your input',
  HISTORY_STATUS_PAUSED_FOR: 'Needs you: {reason}',
  HISTORY_PAUSE_DOWNLOAD: 'model download',
  HISTORY_STATUS_DOWNLOADING: 'Downloading {percent}%',
  HISTORY_STATUS_DOWNLOAD_QUEUED: 'Download queued',
  HISTORY_STATUS_UNSEEN: 'New result',
  HISTORY_STATUS_UNSEEN_FAILED: 'Turn failed',
  HISTORY_QUEUE_ORDINAL_ONE: '{n}st',
  HISTORY_QUEUE_ORDINAL_TWO: '{n}nd',
  HISTORY_QUEUE_ORDINAL_FEW: '{n}rd',
  HISTORY_QUEUE_ORDINAL_OTHER: '{n}th',
}

describe('sessionRowStatus', () => {
  it('shows nothing for an idle Session nobody needs to look at', () => {
    expect(sessionRowStatus({})).toEqual({})
  })

  it('runs while a chat, audio or media turn holds the Session', () => {
    expect(sessionRowStatus({ turn: { turnId: 't', kind: 'chat' } })).toEqual({
      status: 'running',
    })
    expect(sessionRowStatus({ turn: { turnId: 't', kind: 'audio' } })).toEqual({
      status: 'running',
    })
    expect(sessionRowStatus({ turn: { turnId: 't', kind: 'media' } })).toEqual({
      status: 'running',
    })
  })

  it('is queued while its panel run waits for the Turn Queue', () => {
    expect(sessionRowStatus({ turn: { turnId: 't', kind: 'media' }, mediaQueued: true })).toEqual({
      status: 'queued',
    })
  })

  it('knows its panel run’s place in the Turn Queue', () => {
    const turn = { turnId: 't', kind: 'media' as const }
    expect(sessionRowStatus({ turn, mediaQueued: true, mediaQueuePosition: 3 })).toEqual({
      status: 'queued',
      queuePosition: 3,
    })
  })

  it("takes an agent turn's queue position and pause reason", () => {
    const turn = { turnId: 't', kind: 'agent' as const }
    expect(sessionRowStatus({ turn, agentTurn: { state: 'queued', queuePosition: 2 } })).toEqual({
      status: 'queued',
      queuePosition: 2,
    })
    const pauseReason = { kind: 'download' as const, summary: 'Qwen' }
    expect(sessionRowStatus({ turn, agentTurn: { state: 'paused', pauseReason } })).toEqual({
      status: 'paused',
      pauseReason,
    })
  })

  it('is downloading while its turn waits on a Model Download', () => {
    const download = { percent: 40, queued: false }
    expect(sessionRowStatus({ turn: { turnId: 't', kind: 'agent' }, download })).toEqual({
      status: 'downloading',
      download,
    })
  })

  it('is unseen once a turn ended while the Session was not open, unless another runs', () => {
    expect(sessionRowStatus({ unseen: 'done' })).toEqual({ status: 'unseen' })
    expect(sessionRowStatus({ unseen: 'failed' })).toEqual({ status: 'unseenFailed' })
    expect(sessionRowStatus({ turn: { turnId: 't', kind: 'chat' }, unseen: 'done' })).toEqual({
      status: 'running',
    })
  })
})

describe('sessionRowMarker', () => {
  it('labels each status, with a short form where the row has room', () => {
    expect(sessionRowMarker({ status: 'running' }, labels, 'en-US')).toEqual({
      status: 'running',
      label: 'Running',
    })
    expect(sessionRowMarker({ status: 'queued', queuePosition: 2 }, labels, 'en-US')).toEqual({
      status: 'queued',
      label: 'Queued, position 2',
      short: '2nd',
    })
    expect(
      sessionRowMarker(
        { status: 'paused', pauseReason: { kind: 'download', summary: 'Qwen' } },
        labels,
        'en-US',
      ),
    ).toEqual({
      status: 'paused',
      label: 'Needs you: model download · Qwen',
      short: 'model download',
    })
    expect(
      sessionRowMarker(
        { status: 'downloading', download: { percent: 40, queued: false } },
        labels,
        'en-US',
      ),
    ).toEqual({ status: 'downloading', label: 'Downloading 40%', short: '40%' })
    expect(sessionRowMarker({ status: 'unseenFailed' }, labels, 'en-US')).toEqual({
      status: 'unseenFailed',
      label: 'Turn failed',
    })
    expect(sessionRowMarker({}, labels, 'en-US')).toBeNull()
  })
})
