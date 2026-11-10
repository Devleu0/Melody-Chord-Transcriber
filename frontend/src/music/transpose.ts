import type { Chord, Quality } from '../types'
import type { Key } from './key'

export const MAX_TRANSPOSE = 6 // must match MAX_TRANSPOSE in backend/app/main.py
export const MAX_CAPO = 7

const mod12 = (n: number) => ((n % 12) + 12) % 12

export function shiftKey(k: Key | null, semitones: number): Key | null {
  return k && semitones ? { ...k, tonic: mod12(k.tonic + semitones) } : k
}

export function shiftChord(c: Chord, semitones: number): Chord {
  if (!semitones) return c
  return {
    ...c,
    root: mod12(c.root + semitones),
    bass: c.bass == null ? null : mod12(c.bass + semitones),
    pcs: c.pcs.map((pc) => mod12(pc + semitones)),
  }
}

export const shiftChords = (chords: Chord[], semitones: number) =>
  semitones ? chords.map((c) => shiftChord(c, semitones)) : chords

const MINOR_FAMILY = new Set<Quality>(['min', 'min6', 'min7', 'minmaj7'])
const AWKWARD = new Set<Quality>(['dim', 'dim7', 'hdim7', 'aug'])
const OPEN_MAJOR = new Set([0, 2, 4, 7, 9]) // C D E G A
const OPEN_MINOR = new Set([9, 4, 2]) // Am Em Dm

/** How hard a chord shape is on guitar: 0 = open chord, 2 = barre chord */
function shapeCost(root: number, q: Quality): number {
  if (AWKWARD.has(q)) return 1.5
  if (MINOR_FAMILY.has(q)) return OPEN_MINOR.has(root) ? 0 : root === 11 || root === 6 ? 1.5 : 2 // Bm / F♯m are common barres
  if (OPEN_MAJOR.has(root)) return 0
  if (root === 5) return 1 // F: small barre
  if (root === 11 && q === '7') return 0.5 // B7 is an open shape
  return 2
}

/** Capo fret (0..MAX_CAPO) whose chord shapes are easiest overall, weighted by how long each chord lasts */
export function recommendCapo(chords: Chord[]): number {
  if (!chords.length) return 0
  let best = 0
  let bestCost = Infinity
  for (let fret = 0; fret <= MAX_CAPO; fret++) {
    let cost = 0
    for (const c of chords) cost += (c.end - c.start) * (shapeCost(mod12(c.root - fret), c.quality) + 0.12 * fret)
    if (cost < bestCost - 1e-9) {
      bestCost = cost
      best = fret
    }
  }
  return best
}
