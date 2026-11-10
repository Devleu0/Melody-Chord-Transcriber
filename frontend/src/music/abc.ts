import type { Chord } from '../types'
import { BAR, type Arrangement, type Ev } from './arrange'
import { sameChord } from './chords'
import type { Key } from './key'

/** One notehead group or rest as engraved (a long note may be several tied atoms) */
export interface Atom {
  start: number // 16th units from the first bar
  end: number
  rest: boolean
}

export interface AbcStaff {
  hand: 'rh' | 'lh'
  atoms: Atom[] // in the order they appear in the ABC voice
}

export interface AbcScore {
  abc: string
  staves: AbcStaff[]
}

const LETTERS = 'CDEFGAB'
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11]
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
const MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const SHARP_SPELL = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]]
const FLAT_SPELL = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]]

interface Spelling {
  name: string // ABC key name (always the major key with this signature)
  spell: number[][] // pitch class -> [letter index, accidental]
  sig: number[] // letter index -> accidental from the key signature
}

function spelling(key: Key | null): Spelling {
  const tonic = key ? (key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12) : 0
  const name = MAJOR_KEYS[tonic]
  const flat = name.includes('b') || name === 'F'
  const spell = (flat ? FLAT_SPELL : SHARP_SPELL).map((s) => [...s])
  const sig = [0, 0, 0, 0, 0, 0, 0]
  const first = LETTERS.indexOf(name[0])
  MAJOR_SCALE.forEach((iv, i) => {
    const letter = (first + i) % 7
    const pc = (tonic + iv) % 12
    const acc = ((pc - LETTER_PC[letter] + 18) % 12) - 6
    spell[pc] = [letter, acc]
    sig[letter] = acc
  })
  return { name, spell, sig }
}

/** Split a duration starting at `pos` within a bar into engravable note values that keep the beats readable */
function chunks(pos: number, len: number): number[] {
  const out: number[] = []
  while (len > 0) {
    const inBeat = pos % 4
    let d: number
    if (inBeat === 0) {
      d = [16, 12, 8, 6, 4, 3, 2, 1].find((v) => v <= len)!
    } else if (inBeat === 2 && len >= 4 && pos % 8 === 2) {
      d = 4 // off-beat quarter (8th - quarter - 8th syncopation)
    } else {
      d = Math.min(len, 4 - inBeat)
    }
    out.push(d)
    pos += d
    len -= d
  }
  return out
}

const ACC_ABC: Record<string, string> = { '-2': '__', '-1': '_', '0': '=', '1': '^', '2': '^^' }

/**
 * Arrangement -> ABC notation (rendered by abcjs) plus, per staff, the engraved atoms in order,
 * so the rendered elements can be mapped back to song time.
 */
export function toAbc(
  arr: Arrangement,
  key: Key | null,
  opts: { barsPerLine: number; symbols: boolean; chordLabel: (c: Chord) => string },
): AbcScore {
  const sp = spelling(key)
  const total = arr.bars * BAR
  const hands = (['rh', 'lh'] as const).filter((h) => arr[h])

  // chord symbols go above the top staff, on the beat where the chord changes
  const symbols = new Map<number, string>()
  if (opts.symbols) {
    arr.chordAt.forEach((c, b) => {
      if (c && !sameChord(c, b > 0 ? arr.chordAt[b - 1] : null))
        symbols.set(b * 4, opts.chordLabel(c).replace(/♯/g, '#').replace(/♭/g, 'b').replace(/"/g, ''))
    })
  }

  function voice(evs: Ev[], withSymbols: boolean): { bars: string[]; atoms: Atom[] } {
    const atoms: Atom[] = []
    const bars: string[] = Array.from({ length: arr.bars }, () => '')
    let accState = new Map<string, number>()
    let curBar = -1

    const pitchAbc = (midi: number) => {
      const [letter, acc] = sp.spell[midi % 12]
      const natural = midi - acc
      const octave = Math.floor(natural / 12) - 1
      const id = `${letter}${octave}`
      const inEffect = accState.get(id) ?? sp.sig[letter]
      let s = ''
      if (inEffect !== acc) {
        s = ACC_ABC[String(acc)]
        accState.set(id, acc)
      }
      const l = LETTERS[letter]
      return s + (octave >= 5 ? l.toLowerCase() + "'".repeat(octave - 5) : l + ','.repeat(4 - octave))
    }

    /** Emit one span (a note/chord or a rest) that lies within a single bar */
    const emit = (start: number, end: number, pitches: number[] | null, tieOut: boolean) => {
      const bar = Math.floor(start / BAR)
      if (bar !== curBar) {
        curBar = bar
        accState = new Map()
      }
      let pos = start - bar * BAR
      const parts = chunks(pos, end - start)
      parts.forEach((d, i) => {
        const at = bar * BAR + pos
        let tok = pos % 4 === 0 && bars[bar] ? ' ' : ''
        const sym = withSymbols ? symbols.get(at) : undefined
        if (sym) tok += `"${sym}"`
        if (!pitches) tok += 'z'
        else if (pitches.length === 1) tok += pitchAbc(pitches[0])
        else tok += `[${pitches.map(pitchAbc).join('')}]`
        if (d > 1) tok += d
        if (pitches && (i < parts.length - 1 || tieOut)) tok += '-'
        bars[bar] += tok
        atoms.push({ start: at, end: at + d, rest: !pitches })
        pos += d
      })
    }

    /** Cut a span at bar lines and at chord-symbol positions, then emit the pieces */
    const span = (start: number, end: number, pitches: number[] | null) => {
      let a = start
      while (a < end) {
        let b = Math.min(end, (Math.floor(a / BAR) + 1) * BAR)
        if (withSymbols) for (let u = (Math.floor(a / 4) + 1) * 4; u < b; u += 4) if (symbols.has(u)) b = u
        emit(a, b, pitches, b < end)
        a = b
      }
    }

    let t = 0
    for (const e of evs) {
      if (e.start >= total) break
      const start = Math.max(e.start, t)
      const end = Math.min(e.end, total)
      if (end <= start) continue
      if (start > t) span(t, start, null)
      span(start, end, e.pitches)
      t = end
    }
    if (t < total) span(t, total, null)
    return { bars, atoms }
  }

  const voices = hands.map((h, i) => ({ hand: h, ...voice(arr[h]!, i === 0) }))
  const lines = ['X:1', 'M:4/4', 'L:1/16', '%%barnumbers 0'] // bar number at the start of each system
  if (arr.firstBar > 1) lines.push(`%%setbarnb ${arr.firstBar}`)
  if (voices.length > 1) lines.push('%%staves {1 2}')
  voices.forEach((v, i) => lines.push(`V:${i + 1} clef=${v.hand === 'rh' ? 'treble' : 'bass'}`))
  lines.push(`K:${sp.name}`)
  for (let b = 0; b < arr.bars; b += opts.barsPerLine) {
    const last = b + opts.barsPerLine >= arr.bars
    voices.forEach((v, i) => {
      lines.push(`V:${i + 1}`)
      lines.push(v.bars.slice(b, b + opts.barsPerLine).join(' | ') + (last ? ' |]' : ' |'))
    })
  }
  return { abc: lines.join('\n'), staves: voices.map((v) => ({ hand: v.hand, atoms: v.atoms })) }
}
