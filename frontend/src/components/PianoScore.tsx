import { renderAbc } from 'abcjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEngine, LoopRange } from '../audio/engine'
import { useI18n, type MsgKey } from '../i18n'
import { toAbc, type Atom } from '../music/abc'
import { BAR, PATTERNS, arrange, handNotes, unitTime, type ArrangeOpts, type Pattern } from '../music/arrange'
import { chordName } from '../music/chords'
import type { BeatGrid } from '../music/grid'
import { keyName, type Key } from '../music/key'
import type { Chord, TrackData } from '../types'
import { Keyboard } from './Keyboard'

export interface PianoPrefs extends ArrangeOpts {
  symbols: boolean
  keys: boolean
  listen: boolean
}

// eslint-disable-next-line react-refresh/only-export-components
export const PIANO_DEFAULTS: PianoPrefs = {
  rh: 'vocals',
  lh: 'chords',
  pattern: 'block',
  rhOct: 0,
  lhOct: 0,
  quant: 2,
  symbols: true,
  keys: true,
  listen: true,
}

const RH_COLOR = '#ff6b8b'
const LH_COLOR = '#4dabf7'
const OCTAVES = [-2, -1, 0, 1, 2]

interface Props {
  engine: AudioEngine | null
  title: string
  tracks: TrackData[] // as they sound (already transposed)
  chords: Chord[]
  soundKey: Key | null
  grid: BeatGrid
  follow: boolean
  loop: LoopRange | null
  onLoopChange: (r: LoopRange | null) => void
  trackLabel: (id: string) => string
  prefs: PianoPrefs
  onPrefs: (p: PianoPrefs) => void
}

/** Index of the last value <= t in a sorted array (-1 if none) */
function lastAtOrBefore(xs: number[], t: number) {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

interface Rendered {
  hand: 'rh' | 'lh'
  atoms: Atom[]
  times: number[] // start time of each atom
  elems: SVGElement[][] // rendered elements of each atom
}

/** Grand-staff piano arrangement (melody + chord accompaniment by default) with a play-along keyboard */
export function PianoScore(p: Props) {
  const { t } = useI18n()
  const { engine, grid, prefs } = p
  const boxRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<HTMLDivElement>(null)
  const rendered = useRef<Rendered[]>([])
  const lit = useRef<SVGElement[]>([])
  const propsRef = useRef(p)
  propsRef.current = p
  const shiftDown = useRef(false) // abcjs' click callback does not pass the mouse event
  const [width, setWidth] = useState(0)
  const set = (patch: Partial<PianoPrefs>) => p.onPrefs({ ...prefs, ...patch })

  const noteTracks = useMemo(() => p.tracks.filter((tr) => tr.notes), [p.tracks])
  // a saved choice may name a track this job does not have (e.g. bass with the 2-stem separator)
  const valid = (src: string, fallback: string) =>
    src === 'none' || src === 'chords' || noteTracks.some((tr) => tr.id === src) ? src : fallback
  const rhSrc = valid(prefs.rh, noteTracks.some((tr) => tr.id === 'vocals') ? 'vocals' : 'none')
  const lhSrc = valid(prefs.lh, 'chords')

  const arr = useMemo(
    () =>
      arrange(noteTracks, p.chords, grid, {
        rh: rhSrc,
        lh: lhSrc,
        pattern: prefs.pattern,
        rhOct: prefs.rhOct,
        lhOct: prefs.lhOct,
        quant: prefs.quant,
      }),
    [noteTracks, p.chords, grid, rhSrc, lhSrc, prefs.pattern, prefs.rhOct, prefs.lhOct, prefs.quant],
  )
  const rhNotes = useMemo(() => (arr ? handNotes(arr, grid, arr.rh, 90) : []), [arr, grid])
  const lhNotes = useMemo(() => (arr ? handNotes(arr, grid, arr.lh, 64) : []), [arr, grid])
  /** Every moment a new note starts in either hand (for stepping through the piece) */
  const onsets = useMemo(
    () => [...new Set([...rhNotes, ...lhNotes].map((n) => +n.start.toFixed(4)))].sort((a, b) => a - b),
    [rhNotes, lhNotes],
  )

  const barsPerLine = Math.max(1, Math.min(4, Math.floor((width - 80) / (prefs.quant === 1 ? 270 : 210))))
  const score = useMemo(
    () =>
      arr && width > 0
        ? toAbc(arr, p.soundKey, { barsPerLine, symbols: prefs.symbols, chordLabel: (c) => chordName(c, p.soundKey) })
        : null,
    [arr, p.soundKey, barsPerLine, prefs.symbols, width],
  )

  // the arrangement is its own pair of synth tracks, audible only while this view is open
  useEffect(() => {
    engine?.setNotes('arr.rh', rhNotes)
    engine?.setNotes('arr.lh', lhNotes)
  }, [engine, rhNotes, lhNotes])
  useEffect(() => {
    engine?.setSynthGain('arr.rh', prefs.listen ? 0.9 : 0)
    engine?.setSynthGain('arr.lh', prefs.listen ? 0.7 : 0)
    return () => {
      engine?.setSynthGain('arr.rh', 0)
      engine?.setSynthGain('arr.lh', 0)
    }
  }, [engine, prefs.listen, rhNotes, lhNotes])

  useEffect(() => {
    const el = boxRef.current!
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth / 20) * 20))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // engrave, and remember which rendered element belongs to which moment
  useEffect(() => {
    const paper = paperRef.current!
    rendered.current = []
    lit.current = []
    if (!score || !arr) {
      paper.innerHTML = ''
      return
    }
    const byElem = new Map<object, { staff: number; idx: number }>()
    const tune = renderAbc(paper, score.abc, {
      add_classes: true,
      staffwidth: width - 70,
      paddingleft: 20,
      paddingright: 20,
      paddingtop: 10,
      paddingbottom: 20,
      selectionColor: 'currentColor',
      clickListener: (abcElem) => {
        const hit = byElem.get(abcElem)
        if (!hit) return
        const r = rendered.current[hit.staff]
        const P = propsRef.current
        if (shiftDown.current) {
          // loop from the bar under the playhead through the clicked bar
          const barOf = (time: number) => {
            const i = Math.max(0, lastAtOrBefore(r.times, time + 1e-3))
            return Math.floor(r.atoms[i].start / BAR)
          }
          const a = barOf(P.engine?.currentTime ?? 0)
          const b = Math.floor(r.atoms[hit.idx].start / BAR)
          P.onLoopChange({
            start: Math.max(0, unitTime(arr, P.grid, Math.min(a, b) * BAR)),
            end: unitTime(arr, P.grid, (Math.max(a, b) + 1) * BAR),
          })
        } else P.engine?.seek(Math.max(0, r.times[hit.idx]))
      },
    })[0]
    rendered.current = score.staves.map((st, s) => {
      const elems: SVGElement[][] = []
      for (const line of tune.lines) {
        for (const el of line.staff?.[s]?.voices?.[0] ?? []) {
          if (el.el_type !== 'note') continue
          byElem.set(el, { staff: s, idx: elems.length })
          // set by the renderer; missing from abcjs' type for notes
          elems.push((el as { abselem?: { elemset?: SVGElement[] } }).abselem?.elemset ?? [])
        }
      }
      return { hand: st.hand, atoms: st.atoms, elems, times: st.atoms.map((a) => unitTime(arr, grid, a.start)) }
    })
  }, [score, arr, grid, width])

  // light up what is sounding and keep it in view
  useEffect(() => {
    let raf = 0
    let last = ''
    let lastNow = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const P = propsRef.current
      const now = P.engine?.currentTime ?? 0
      const cur = rendered.current.map((r) => {
        const i = lastAtOrBefore(r.times, now + 1e-3)
        return i >= 0 && i < r.elems.length ? i : -1
      })
      const sig = cur.join(',')
      const jumped = Math.abs(now - lastNow) > 0.5
      lastNow = now
      if (sig === last) return
      last = sig
      for (const el of lit.current) el.classList.remove('now', 'rh', 'lh')
      lit.current = []
      rendered.current.forEach((r, s) => {
        if (cur[s] < 0) return
        for (const el of r.elems[cur[s]]) {
          el.classList.add('now', r.hand)
          lit.current.push(el)
        }
      })
      const box = boxRef.current
      const first = lit.current[0]
      if (box && first && P.follow && (P.engine?.isPlaying || jumped)) {
        const rect = first.getBoundingClientRect()
        const view = box.getBoundingClientRect()
        if (rect.top < view.top + 60 || rect.bottom > view.bottom - 110)
          box.scrollTo({ top: box.scrollTop + rect.top - view.top - 90, behavior: 'smooth' })
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const step = (dir: 1 | -1) => {
    if (!engine || !onsets.length) return
    const now = engine.currentTime
    const target = dir > 0 ? onsets.find((x) => x > now + 0.02) : onsets[lastAtOrBefore(onsets, now - 0.02)]
    if (target == null) return
    engine.seek(target)
    if (!engine.isPlaying)
      for (const n of [...rhNotes, ...lhNotes]) if (Math.abs(n.start - target) < 1e-3) engine.preview(n.pitch, 0.5)
  }
  const stepRef = useRef(step)
  stepRef.current = step
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName) || e.ctrlKey || e.metaKey) return
      if (e.key === '.' || e.key === '>') stepRef.current(1)
      else if (e.key === ',' || e.key === '<') stepRef.current(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const sourceOptions = (hand: 'rh' | 'lh') => (
    <>
      {noteTracks.map((tr) => (
        <option key={tr.id} value={tr.id}>
          {tr.id === 'vocals'
            ? t('ps.src.melody', { track: p.trackLabel(tr.id) })
            : t(hand === 'rh' ? 'ps.src.upper' : 'ps.src.lower', { track: p.trackLabel(tr.id) })}
        </option>
      ))}
      <option value="chords">{t('ps.src.chords')}</option>
      <option value="none">{t('ps.src.none')}</option>
    </>
  )
  const octaveSelect = (value: number, onChange: (n: number) => void, label: string) => (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} title={label}>
      {OCTAVES.map((o) => (
        <option key={o} value={o}>
          {o === 0 ? t('ps.oct.auto') : `${o > 0 ? '+' : ''}${o} ${t('ps.oct')}`}
        </option>
      ))}
    </select>
  )
  const usesChords = rhSrc === 'chords' || lhSrc === 'chords'

  return (
    <div className="sheet">
      <div className="sheet-bar">
        <span className="chip hand rh">
          {t('ps.rh')}
          <select value={rhSrc} onChange={(e) => set({ rh: e.target.value })}>
            {sourceOptions('rh')}
          </select>
          {rhSrc !== 'none' && octaveSelect(prefs.rhOct, (n) => set({ rhOct: n }), t('ps.oct.title'))}
        </span>
        <span className="chip hand lh">
          {t('ps.lh')}
          <select value={lhSrc} onChange={(e) => set({ lh: e.target.value })}>
            {sourceOptions('lh')}
          </select>
          {lhSrc !== 'none' && octaveSelect(prefs.lhOct, (n) => set({ lhOct: n }), t('ps.oct.title'))}
        </span>
        <button
          className="chip btn"
          title={t('ps.swap.title')}
          onClick={() => set({ rh: lhSrc, lh: rhSrc, rhOct: 0, lhOct: 0 })}
          disabled={rhSrc === lhSrc}
        >
          ⇄ {t('ps.swap')}
        </button>
        {usesChords && (
          <label className="chip" title={t('ps.pattern.title')}>
            {t('ps.pattern')}{' '}
            <select value={prefs.pattern} onChange={(e) => set({ pattern: e.target.value as Pattern })}>
              {PATTERNS.map((pt) => (
                <option key={pt} value={pt}>
                  {t(`ps.pattern.${pt}` as MsgKey)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="chip" title={t('ps.quant.title')}>
          {t('ps.quant')}{' '}
          <select value={prefs.quant} onChange={(e) => set({ quant: Number(e.target.value) as 1 | 2 })}>
            <option value={2}>{t('ps.quant.8')}</option>
            <option value={1}>{t('ps.quant.16')}</option>
          </select>
        </label>
        <label className="chip check">
          <input type="checkbox" checked={prefs.symbols} onChange={(e) => set({ symbols: e.target.checked })} /> {t('ps.symbols')}
        </label>
        <label className="chip check">
          <input type="checkbox" checked={prefs.keys} onChange={(e) => set({ keys: e.target.checked })} /> {t('ps.keys')}
        </label>
        <label className="chip check" title={t('ps.listen.title')}>
          <input type="checkbox" checked={prefs.listen} onChange={(e) => set({ listen: e.target.checked })} /> {t('ps.listen')}
        </label>
        <span className="chip sizer" title={t('ps.step.title')}>
          <button onClick={() => step(-1)} aria-label={t('ps.step.prev')}>
            ◀
          </button>
          {t('ps.step')}
          <button onClick={() => step(1)} aria-label={t('ps.step.next')}>
            ▶
          </button>
        </span>
        <button className="chip btn" onClick={() => window.print()}>
          {t('sheet.print')}
        </button>
        <span className="hint">{t('sheet.hint')}</span>
      </div>
      <div className="sheet-scroll" ref={boxRef}>
        <div className="sheet-page score printable">
          <h2 className="sheet-title">{p.title}</h2>
          <div className="sheet-sub">
            {p.soundKey ? keyName(p.soundKey) : ''} · {t('ps.caption')}
          </div>
          {!arr && <div className="sheet-empty">{t('ps.empty')}</div>}
          <div ref={paperRef} className="score-paper" onPointerDownCapture={(e) => (shiftDown.current = e.shiftKey)} />
        </div>
      </div>
      {prefs.keys && arr && (
        <div className="keys-panel">
          <div className="keys-legend">
            <span style={{ color: RH_COLOR }}>■ {t('ps.rh')}</span>
            <span style={{ color: LH_COLOR }}>■ {t('ps.lh')}</span>
            <span>{t('ps.keys.legend')}</span>
          </div>
          <Keyboard engine={engine} rh={rhNotes} lh={lhNotes} rhColor={RH_COLOR} lhColor={LH_COLOR} nameKey={p.soundKey} />
        </div>
      )}
    </div>
  )
}
