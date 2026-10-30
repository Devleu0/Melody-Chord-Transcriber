import type { Chord, Note, Quality } from '../types'
import type { BeatGrid } from './grid'
import { beatIndex } from './grid'
import { keyName, type Key } from './key'

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']
// 플랫 계열 조 (장조 으뜸음 기준)
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6])

const SUFFIX: Record<Quality, string> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  aug: 'aug',
  min6: 'm6',
  maj6: '6',
  min7: 'm7',
  minmaj7: 'm(maj7)',
  maj7: 'maj7',
  '7': '7',
  dim7: 'dim7',
  hdim7: 'm7♭5',
  sus2: 'sus2',
  sus4: 'sus4',
}

const MINORISH = new Set<Quality>(['min', 'min6', 'min7', 'minmaj7', 'dim', 'dim7', 'hdim7'])
const ROMAN = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♯IV', 'V', '♭VI', 'VI', '♭VII', 'VII']
const ROMAN_SUFFIX: Partial<Record<Quality, string>> = {
  dim: '°',
  dim7: '°7',
  hdim7: 'ø7',
  aug: '+',
  '7': '7',
  maj7: 'M7',
  min7: '7',
  minmaj7: 'M7',
  min6: '6',
  maj6: '6',
  sus2: 'sus2',
  sus4: 'sus4',
}

/** 조에 맞는 철자(♯/♭)로 음이름 */
export function pcName(pc: number, key: Key | null): string {
  if (!key) return FLAT[pc]
  const majorTonic = key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12
  return (FLAT_MAJOR.has(majorTonic) ? FLAT : SHARP)[pc]
}

export function chordName(c: Chord, key: Key | null): string {
  const name = pcName(c.root, key) + SUFFIX[c.quality]
  return c.bass != null ? `${name}/${pcName(c.bass, key)}` : name
}

export function romanNumeral(c: Chord, key: Key | null): string {
  if (!key) return ''
  const deg = (c.root - key.tonic + 12) % 12
  const base = MINORISH.has(c.quality) ? ROMAN[deg].toLowerCase() : ROMAN[deg]
  return base + (ROMAN_SUFFIX[c.quality] ?? '')
}

export type ChordFunction = 'tonic' | 'subdominant' | 'dominant' | 'chromatic'

/** 기능 화성 분류 (근음 도수 기준의 단순화) */
export function chordFunction(c: Chord, key: Key | null): ChordFunction {
  if (!key) return 'chromatic'
  const deg = (c.root - key.tonic + 12) % 12
  const groups =
    key.mode === 'major'
      ? { tonic: [0, 4, 9], subdominant: [2, 5], dominant: [7, 11] }
      : { tonic: [0, 3], subdominant: [2, 5, 8], dominant: [7, 10, 11] }
  if (groups.tonic.includes(deg)) return 'tonic'
  if (groups.subdominant.includes(deg)) return 'subdominant'
  if (groups.dominant.includes(deg)) return 'dominant'
  return 'chromatic'
}

export const FUNCTION_COLOR: Record<ChordFunction, string> = {
  tonic: '#e9c46a',
  subdominant: '#7bc67b',
  dominant: '#f08a6c',
  chromatic: '#b197fc',
}

/** 신스 재생용 보이싱 (백엔드 MIDI 와 동일: 근음 C3 대역, 전위 베이스는 C2 대역) */
export function chordToNotes(chords: Chord[]): Note[] {
  const notes: Note[] = []
  for (const c of chords) {
    const base = 48 + c.root
    for (const pc of c.pcs) notes.push({ pitch: base + ((pc - c.root + 12) % 12), start: c.start, end: c.end, velocity: 70 })
    if (c.bass != null) notes.push({ pitch: 36 + c.bass, start: c.start, end: c.end, velocity: 70 })
  }
  return notes.sort((a, b) => a.start - b.start)
}

/** 마디(4/4)별 코드 텍스트 리드시트 */
export function leadSheet(
  chords: Chord[],
  grid: BeatGrid,
  key: Key | null,
  meta: { title?: string; tempo: number },
): string {
  const lines = [
    meta.title ?? 'Untitled',
    `Key: ${key ? keyName(key) : '?'}   Tempo: ${meta.tempo.toFixed(0)} BPM   (4/4, 마디 = 감지된 비트 4개)`,
    '',
  ]
  const bars: string[] = []
  const startBeat = grid.firstIndex
  for (let b = startBeat; b + 1 < grid.beats.length; b += 4) {
    const names: string[] = []
    for (let k = 0; k < 4 && b + k < grid.beats.length - 1; k++) {
      const t = grid.beats[b + k] + 0.01
      const c = chords.find((ch) => ch.start <= t && t < ch.end)
      const n = c ? chordName(c, key) : 'N.C.'
      if (names[names.length - 1] !== n) names.push(n)
    }
    bars.push(names.join(' '))
  }
  // 마지막의 무코드 마디 제거
  while (bars.length && bars[bars.length - 1] === 'N.C.') bars.pop()
  for (let i = 0; i < bars.length; i += 4) {
    const row = bars.slice(i, i + 4).map((s) => s.padEnd(14))
    lines.push(`${String(i + 1).padStart(3)} | ${row.join('| ')}|`)
  }
  return lines.join('\n') + '\n'
}

/** 화면 표시용: 시각 t 의 마디 번호 (1부터, 픽업은 0 이하) */
export function barNumber(grid: BeatGrid, t: number): number {
  return Math.floor((beatIndex(grid, t) - grid.firstIndex) / 4) + 1
}
