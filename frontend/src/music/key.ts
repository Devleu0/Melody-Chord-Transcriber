import type { Note } from '../types'

export type Mode = 'major' | 'minor'

export interface Key {
  tonic: number // pitch class 0=C
  mode: Mode
}

const KEY_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

// Krumhansl–Kessler key profiles
const PROFILES: Record<Mode, number[]> = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
}

const SCALES: Record<Mode, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], // natural minor
}

export const keyName = (k: Key) => `${KEY_NAMES[k.tonic]} ${k.mode === 'major' ? 'major' : 'minor'}`
export const keyId = (k: Key) => `${k.tonic}-${k.mode}`
export const parseKeyId = (id: string): Key => {
  const [t, m] = id.split('-')
  return { tonic: Number(t), mode: m as Mode }
}

export const ALL_KEYS: Key[] = (['major', 'minor'] as Mode[]).flatMap((mode) =>
  Array.from({ length: 12 }, (_, tonic) => ({ tonic, mode })),
)

/** Set of pitch classes in this key's scale */
export function scaleSet(k: Key): Set<number> {
  return new Set(SCALES[k.mode].map((i) => (k.tonic + i) % 12))
}

function pearson(a: number[], b: number[]) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length
  const mb = b.reduce((s, x) => s + x, 0) / b.length
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return num / Math.sqrt(da * db || 1)
}

/** Picks the best-correlated of the 24 keys using a duration-weighted pitch class histogram. */
export function detectKey(notes: Note[]): Key | null {
  const hist = new Array(12).fill(0)
  for (const n of notes) hist[n.pitch % 12] += n.end - n.start
  if (hist.every((x) => x === 0)) return null
  let best: Key | null = null
  let bestR = -Infinity
  for (const k of ALL_KEYS) {
    const prof = PROFILES[k.mode]
    const rotated = prof.map((_, i) => prof[(i - k.tonic + 12) % 12])
    const r = pearson(hist, rotated)
    if (r > bestR) {
      bestR = r
      best = k
    }
  }
  return best
}
