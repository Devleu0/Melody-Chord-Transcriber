export type Separator = 'roformer' | 'demucs'

export interface Job {
  id: string
  url: string
  separator: Separator
  status: 'queued' | 'downloading' | 'separating' | 'transcribing' | 'chords' | 'finalizing' | 'done' | 'error'
  message: string
  detail?: string | null // e.g. separator name or track id being transcribed
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

export type Quality =
  | 'maj'
  | 'min'
  | 'dim'
  | 'aug'
  | 'min6'
  | 'maj6'
  | 'min7'
  | 'minmaj7'
  | 'maj7'
  | '7'
  | 'dim7'
  | 'hdim7'
  | 'sus2'
  | 'sus4'

export interface Chord {
  start: number
  end: number
  root: number // pitch class
  quality: Quality
  bass: number | null // inversion bass pitch class
  pcs: number[]
}

export interface ChordResult {
  engine: 'btc' | 'template'
  chords: Chord[]
  change_penalty?: number
}

export interface TrackData {
  id: string
  kind: 'audio' | 'midi'
  audio: string
  midi?: string | null
  notes?: Note[]
  pitch_curve?: { fps: number; values: (number | null)[] }
  params?: Record<string, number>
  edited?: boolean
}

export interface Result {
  job_id: string
  meta: Job['meta']
  separator: Separator
  tempo: number
  beats: number[]
  tracks: TrackData[]
  chords?: ChordResult
}

/** Track state in the UI (DAW mixer). id 'chords' is a virtual track for the chord lane */
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
