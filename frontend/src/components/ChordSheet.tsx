import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEngine, LoopRange } from '../audio/engine'
import { useI18n } from '../i18n'
import { chordBars, chordName, romanNumeral, sameChord } from '../music/chords'
import type { BeatGrid } from '../music/grid'
import { keyName, type Key } from '../music/key'
import type { Chord } from '../types'

interface Props {
  engine: AudioEngine | null
  title: string
  tempo: number
  chords: Chord[] // as they sound (already transposed)
  shapes: Chord[] // as fingered (capo applied); same order as chords
  soundKey: Key | null
  shapeKey: Key | null
  capo: number
  grid: BeatGrid
  follow: boolean
  loop: LoopRange | null
  loopOn: boolean
  onLoopChange: (r: LoopRange | null) => void
  size: number
  onSize: (n: number) => void
}

const SIZES = [15, 18, 22, 27, 33]

/** Chord chart for playing along: 4 bars per row, the current bar lit up, click to jump */
export function ChordSheet(p: Props) {
  const { t } = useI18n()
  const [roman, setRoman] = useState(false)
  const [pos, setPos] = useState({ bar: -1, beat: 0 })
  const scrollRef = useRef<HTMLDivElement>(null)
  const bars = useMemo(() => chordBars(p.shapes, p.grid), [p.shapes, p.grid])
  // roman numerals are relative to the key, so the sounding chord and key give the same result
  const sounding = useMemo(() => new Map(p.shapes.map((c, i) => [c, p.chords[i]])), [p.shapes, p.chords])

  // follow the playhead (only re-render when the beat changes)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const now = p.engine?.currentTime ?? 0
      const bar = bars.findIndex((b) => now >= b.start && now < b.end)
      const beat = bar < 0 ? 0 : Math.min(3, Math.floor(((now - bars[bar].start) / (bars[bar].end - bars[bar].start)) * 4))
      setPos((prev) => (prev.bar === bar && prev.beat === beat ? prev : { bar, beat }))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [p.engine, bars])

  useEffect(() => {
    if (!p.follow || pos.bar < 0) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-bar="${pos.bar}"]`)
    const box = scrollRef.current
    if (!el || !box) return
    const top = el.offsetTop - box.scrollTop
    if (top < 40 || top + el.offsetHeight > box.clientHeight - 40) box.scrollTo({ top: el.offsetTop - box.clientHeight * 0.3, behavior: 'smooth' })
  }, [pos.bar, p.follow])

  function clickBar(i: number, shift: boolean) {
    const bar = bars[i]
    if (shift) {
      // loop from the bar under the playhead (or the loop start) through this bar
      const from = bars[pos.bar >= 0 ? pos.bar : i]
      const start = Math.min(from.start, bar.start, p.loop?.start ?? Infinity)
      const end = Math.max(from.end, bar.end)
      p.onLoopChange({ start: Math.max(0, start), end })
    } else p.engine?.seek(Math.max(0, bar.start))
  }

  const si = Math.max(0, Math.min(SIZES.length - 1, p.size))
  return (
    <div className="sheet">
      <div className="sheet-bar">
        <span className="chip">
          {t('cs.key')} <b>{p.soundKey ? keyName(p.soundKey) : '?'}</b>
        </span>
        {p.capo > 0 && (
          <span className="chip capo">
            {t('cs.capo', { n: p.capo })} · <b>{p.shapeKey ? t('cs.shapes', { key: keyName(p.shapeKey) }) : ''}</b>
          </span>
        )}
        <span className="chip">♩ {p.tempo.toFixed(0)}</span>
        <label className="chip check">
          <input type="checkbox" checked={roman} onChange={(e) => setRoman(e.target.checked)} /> {t('cs.roman')}
        </label>
        <span className="chip sizer">
          <button onClick={() => p.onSize(si - 1)} disabled={si === 0} aria-label={t('cs.smaller')} title={t('cs.smaller')}>
            A−
          </button>
          <button onClick={() => p.onSize(si + 1)} disabled={si === SIZES.length - 1} aria-label={t('cs.larger')} title={t('cs.larger')}>
            A+
          </button>
        </span>
        <button className="chip btn" onClick={() => window.print()}>
          {t('sheet.print')}
        </button>
        <span className="hint">{t('sheet.hint')}</span>
      </div>
      <div className="sheet-scroll" ref={scrollRef}>
        <div className="sheet-page printable" style={{ fontSize: SIZES[si] }}>
          <h2 className="sheet-title">{p.title}</h2>
          <div className="sheet-sub">
            {p.soundKey ? keyName(p.soundKey) : ''}
            {p.capo > 0 && p.shapeKey ? ` · ${t('cs.capo', { n: p.capo })} (${t('cs.shapes', { key: keyName(p.shapeKey) })})` : ''} · ♩ ={' '}
            {p.tempo.toFixed(0)}
          </div>
          {bars.length === 0 && <div className="sheet-empty">{t('cs.empty')}</div>}
          <div className="cs-grid">
            {bars.map((bar, i) => {
              const prevLast = i > 0 ? bars[i - 1].segs[bars[i - 1].segs.length - 1].chord : null
              const inLoop = !!p.loop && bar.start >= p.loop.start - 0.01 && bar.end <= p.loop.end + 0.01
              return (
                <button
                  key={bar.beat}
                  data-bar={i}
                  className={`cs-bar ${i === pos.bar ? 'cur' : ''} ${inLoop ? (p.loopOn ? 'loop on' : 'loop') : ''}`}
                  onClick={(e) => clickBar(i, e.shiftKey)}
                >
                  <span className="cs-num">{bar.number > 0 ? bar.number : ''}</span>
                  <span className="cs-beats">
                    {bar.segs.map((s) => {
                      const held = s.beat === 0 && sameChord(s.chord, prevLast)
                      const active = i === pos.bar && pos.beat >= s.beat && pos.beat < s.beat + s.len
                      return (
                        <span
                          key={s.beat}
                          className={`cs-chord ${held ? 'held' : ''} ${active ? 'active' : ''}`}
                          style={{ gridColumn: `${s.beat + 1} / span ${s.len}` }}
                        >
                          {s.chord ? chordName(s.chord, p.shapeKey) : s.beat === 0 && bar.segs.length === 1 ? '–' : ''}
                          {roman && s.chord && <small>{romanNumeral(sounding.get(s.chord) ?? s.chord, p.soundKey)}</small>}
                        </span>
                      )
                    })}
                  </span>
                  {i === pos.bar && <span className="cs-tick" style={{ left: `${(pos.beat / 4) * 100}%` }} />}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
