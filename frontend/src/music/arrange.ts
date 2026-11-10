import type { Chord, Note } from '../types'
import { sameChord } from './chords'
import { beatPos, timeAtBeat, type BeatGrid } from './grid'

/** Left-hand style when a hand plays the chords */
export type Pattern = 'block' | 'beat' | 'alt' | 'arp' | 'bass'
export const PATTERNS: Pattern[] = ['block', 'beat', 'alt', 'arp', 'bass']

export interface ArrangeOpts {
  rh: string // 'none' | 'chords' | track id
  lh: string
  pattern: Pattern
  rhOct: number // octaves added on top of the automatic register
  lhOct: number
  quant: 1 | 2 // rhythm resolution in 16ths (2 = 8th notes)
}

/** A note or chord on the score. Times are in 16th-note units from the first bar */
export interface Ev {
  start: number
  end: number
  pitches: number[]
}

export interface Arrangement {
  origin: number // grid beat index of unit 0
  bars: number
  firstBar: number // number of the first bar (<= 0 for pickup bars)
  chordAt: (Chord | null)[] // chord per beat
  rh: Ev[] | null // null = hand not used
  lh: Ev[] | null
}

export const BAR = 16 // units per 4/4 bar
const MAX_BARS = 600
const SPLIT = 60 // polyphonic tracks: middle C and above go to the right hand
const LOW = 21
const HIGH = 108

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

/** Octave shift that brings a part into a comfortable register for the hand */
function autoOctave(evs: Ev[], hand: 'rh' | 'lh'): number {
  const ps = evs.flatMap((e) => e.pitches)
  if (!ps.length) return 0
  const m = median(ps)
  if (hand === 'rh') return m < 60 ? Math.ceil((60 - m) / 12) : m > 84 ? -Math.ceil((m - 84) / 12) : 0
  return m > 57 ? -Math.ceil((m - 57) / 12) : m < 36 ? Math.ceil((36 - m) / 12) : 0
}

/** Transcribed notes -> one line of notes/chords on the rhythm grid */
function trackEvents(notes: Note[], toUnit: (t: number) => number, quant: number, hand: 'rh' | 'lh', split: boolean): Ev[] {
  const groups = new Map<number, { end: number; pitches: Set<number> }>()
  for (const n of notes) {
    if (split && (hand === 'rh' ? n.pitch < SPLIT : n.pitch >= SPLIT)) continue
    const start = Math.round(toUnit(n.start) / quant) * quant
    if (start < 0) continue
    const end = Math.max(start + quant, Math.round(toUnit(n.end) / quant) * quant)
    const g = groups.get(start)
    if (g) {
      g.end = Math.max(g.end, end)
      g.pitches.add(n.pitch)
    } else groups.set(start, { end, pitches: new Set([n.pitch]) })
  }
  const starts = [...groups.keys()].sort((a, b) => a - b)
  return starts.map((start, i) => {
    const g = groups.get(start)!
    const sorted = [...g.pitches].sort((a, b) => a - b)
    // keep a playable handful: the top of the right hand, the bottom of the left
    const pitches = hand === 'rh' ? sorted.slice(-4) : sorted.slice(0, 3)
    return { start, end: Math.min(g.end, starts[i + 1] ?? Infinity), pitches }
  })
}

/** Chord tones in close position within C3..B3 (so successive chords move as little as possible) */
function blockVoicing(c: Chord): number[] {
  let pcs = [...new Set(c.pcs)]
  if (pcs.length > 4) pcs = pcs.filter((pc) => (pc - c.root + 12) % 12 !== 7) // drop the fifth first
  return pcs
    .slice(0, 4)
    .map((pc) => 48 + pc)
    .sort((a, b) => a - b)
}

/** Bass note (inversion bass if any) within F2..E3 */
function bassNote(c: Chord): number {
  const p = 36 + (c.bass ?? c.root)
  return p < 41 ? p + 12 : p
}

function chordEvents(chordAt: (Chord | null)[], pattern: Pattern): Ev[] {
  const out: Ev[] = []
  for (let bar = 0; bar * 4 < chordAt.length; bar++) {
    for (let k = 0; k < 4; ) {
      const c = chordAt[bar * 4 + k]
      let len = 1
      while (k + len < 4 && sameChord(chordAt[bar * 4 + k + len], c)) len++
      const u0 = (bar * 4 + k) * 4
      if (c) {
        const block = blockVoicing(c)
        const low = bassNote(c)
        if (pattern === 'block') out.push({ start: u0, end: u0 + len * 4, pitches: block })
        else if (pattern === 'bass') out.push({ start: u0, end: u0 + len * 4, pitches: [low] })
        else if (pattern === 'beat') {
          for (let j = 0; j < len; j++) out.push({ start: u0 + j * 4, end: u0 + j * 4 + 4, pitches: block })
        } else if (pattern === 'alt') {
          // bass on beats 1 and 3, chord on 2 and 4
          for (let j = 0; j < len; j++)
            out.push({ start: u0 + j * 4, end: u0 + j * 4 + 4, pitches: (k + j) % 2 === 0 ? [low] : block })
        } else {
          // 8th-note arpeggio rising from the bass
          const tones = [...new Set(c.pcs.map((pc) => (pc - (low % 12) + 12) % 12))].sort((a, b) => a - b)
          const up = tones.filter((iv) => iv > 0).map((iv) => low + iv)
          const seq = up.length >= 3 ? [low, up[0], up[1], up[2]] : up.length === 2 ? [low, up[0], up[1], up[0]] : [low, up[0] ?? low + 12]
          for (let j = 0; j < len * 2; j++) out.push({ start: u0 + j * 2, end: u0 + j * 2 + 2, pitches: [seq[j % seq.length]] })
        }
      }
      k += len
    }
  }
  return out
}

/**
 * Piano arrangement: each hand plays either a transcribed track or the chord progression.
 * Bars are 4 detected beats, counted from the first detected beat like everywhere else in the app.
 */
export function arrange(
  tracks: { id: string; notes?: Note[] }[],
  chords: Chord[],
  grid: BeatGrid,
  opts: ArrangeOpts,
): Arrangement | null {
  const base = grid.firstIndex % 4 // first bar line on the extended grid
  const used = [opts.rh, opts.lh].filter((s) => s !== 'none')
  if (!used.length) return null
  const notesOf = (src: string) => tracks.find((t) => t.id === src)?.notes ?? []

  // which bars have anything in them
  let lo = Infinity
  let hi = -Infinity
  const span = (a: number, b: number) => {
    lo = Math.min(lo, a)
    hi = Math.max(hi, b)
  }
  for (const c of chords) span(beatPos(grid, c.start), beatPos(grid, c.end))
  for (const src of used) if (src !== 'chords') for (const n of notesOf(src)) span(beatPos(grid, n.start), beatPos(grid, n.end))
  if (hi <= lo) return null
  const firstBarIdx = Math.max(0, Math.floor((lo - base + 0.25) / 4))
  const bars = Math.min(MAX_BARS, Math.max(1, Math.ceil((hi - base - 0.25) / 4) - firstBarIdx))
  const origin = base + firstBarIdx * 4
  const toUnit = (t: number) => (beatPos(grid, t) - origin) * 4

  const chordAt: (Chord | null)[] = []
  let ci = 0
  for (let b = 0; b < bars * 4; b++) {
    const mid = timeAtBeat(grid, origin + b + 0.5)
    while (ci < chords.length && chords[ci].end <= mid) ci++
    chordAt.push(ci < chords.length && chords[ci].start <= mid ? chords[ci] : null)
  }

  const hand = (src: string, which: 'rh' | 'lh', oct: number): Ev[] | null => {
    if (src === 'none') return null
    let evs: Ev[]
    let shift: number
    if (src === 'chords') {
      evs = chordEvents(chordAt, opts.pattern)
      shift = which === 'rh' ? 1 : 0
    } else {
      // when both hands share a polyphonic track, or it is not the melody, split it at middle C
      evs = trackEvents(notesOf(src), toUnit, opts.quant, which, src !== 'vocals')
      shift = autoOctave(evs, which)
    }
    const semis = (shift + oct) * 12
    const end = bars * BAR
    return evs
      .filter((e) => e.start < end)
      .map((e) => ({
        start: e.start,
        end: Math.min(e.end, end),
        pitches: e.pitches.map((p) => p + semis).filter((p) => p >= LOW && p <= HIGH),
      }))
      .filter((e) => e.pitches.length)
  }

  return {
    origin,
    bars,
    firstBar: (origin - grid.firstIndex) / 4 + 1,
    chordAt,
    rh: hand(opts.rh, 'rh', opts.rhOct),
    lh: hand(opts.lh, 'lh', opts.lhOct),
  }
}

export const unitTime = (arr: Arrangement, grid: BeatGrid, unit: number) => timeAtBeat(grid, arr.origin + unit / 4)

/** A hand's part as timed notes (synth playback, keyboard display) */
export function handNotes(arr: Arrangement, grid: BeatGrid, evs: Ev[] | null, velocity: number): Note[] {
  const notes: Note[] = []
  for (const e of evs ?? []) {
    const start = unitTime(arr, grid, e.start)
    const end = unitTime(arr, grid, e.end)
    for (const pitch of e.pitches) notes.push({ pitch, start, end, velocity })
  }
  return notes
}
