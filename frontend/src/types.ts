export type Separator = 'roformer' | 'demucs'

export interface Job {
  id: string
  url: string
  separator: Separator
  status: 'queued' | 'downloading' | 'separating' | 'transcribing' | 'finalizing' | 'done' | 'error'
  message: string
  progress: number
  error: string | null
  meta: { title?: string; uploader?: string; duration?: number; thumbnail?: string }
  created_at: number
}

export interface Note {
  pitch: number
  start: number
  end: number
  velocity: number
}

export interface TrackData {
  id: string
  kind: 'audio' | 'midi'
  audio: string
  midi?: string | null
  notes?: Note[]
  pitch_curve?: { fps: number; values: (number | null)[] }
}

export interface Result {
  job_id: string
  meta: Job['meta']
  separator: Separator
  tempo: number
  beats: number[]
  tracks: TrackData[]
}

/** UI 상의 트랙 상태 (DAW 믹서) */
export interface TrackState {
  id: string
  label: string
  color: string
  hasNotes: boolean
  showNotes: boolean
  audioOn: boolean
  solo: boolean
  volume: number
  synthOn: boolean
}
