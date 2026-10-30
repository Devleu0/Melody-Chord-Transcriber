import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { AudioEngine, LoopRange } from '../audio/engine'
import { FUNCTION_COLOR, chordFunction, chordName, pcName, romanNumeral } from '../music/chords'
import { snapTime, stepAt, type BeatGrid } from '../music/grid'
import { scaleSet, type Key } from '../music/key'
import { fmtTime, pitchName } from '../music/format'
import type { Chord, Note, TrackData, TrackState } from '../types'

const KEY_W = 72
const MINI_H = 30
const RULER_H = 24
const CHORD_H = 30
const WAVE_H = 40
const MIN_PITCH = 21 // A0
const MAX_PITCH = 108 // C8
const ROWS = MAX_PITCH - MIN_PITCH + 1
const BLACK = new Set([1, 3, 6, 8, 10])

const isBlack = (p: number) => BLACK.has(p % 12)
const midiHz = (p: number) => 440 * 2 ** ((p - 69) / 12)

const C = {
  bg: '#16181d',
  rowBlack: '#121418',
  rowLine: '#1f2229',
  octLine: '#2f3440',
  sub: '#1c1f26',
  beat: '#22262e',
  bar: '#3a404c',
  ruler: '#1d2027',
  lane: '#191c22',
  rulerText: '#8a93a6',
  playhead: '#ffd166',
  keyWhite: '#d9dce3',
  keyBlack: '#22252c',
  keyText: '#4a5060',
}

interface View {
  x0: number // 화면 왼쪽 시각(s)
  pps: number // px per sec
  scrollY: number // px
  keyH: number // px per semitone
}

type Hover =
  | { kind: 'note'; note: Note; track: string; x: number; y: number }
  | { kind: 'key'; pitch: number; x: number; y: number }
  | { kind: 'chord'; chord: Chord; x: number; y: number }
  | null

type DragMode = 'ruler' | 'loopNew' | 'loopStart' | 'loopEnd' | 'pan' | 'mini' | 'move' | 'resize'

export interface PianoRollHandle {
  zoomTime: (factor: number) => void
  fitPitch: () => void
}

interface Props {
  viewKey: string // 이 값이 바뀔 때만 뷰(스크롤/줌) 초기화
  engine: AudioEngine | null
  tracks: TrackData[]
  states: TrackState[]
  grid: BeatGrid
  duration: number
  follow: boolean
  selected: Note | null
  onSelect: (n: Note | null, trackId: string | null) => void
  scaleKey: Key | null
  nameKey: Key | null // 코드 철자/로마숫자 기준 조
  loop: LoopRange | null
  loopOn: boolean
  onLoopChange: (r: LoopRange | null) => void
  chords: Chord[]
  showChords: boolean
  peaks: Float32Array | null
  peaksRate: number
  showWave: boolean
  editMode: boolean
  editTrack: string | null
  snapDiv: number // 박 분할 (0 = 스냅 끔)
  /** before=null: 추가, after=null: 삭제, 둘 다: 수정 */
  onEditNote: (track: string, before: Note | null, after: Note | null) => void
}

export const PianoRoll = forwardRef<PianoRollHandle, Props>(function PianoRoll(props, ref) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const propsRef = useRef(props)
  const view = useRef<View>({ x0: 0, pps: 120, scrollY: 0, keyH: 14 })
  const dirty = useRef(true)
  // 룰러 드래그 중인 반복 구간 (놓을 때 onLoopChange 로 확정)
  const loopDraft = useRef<LoopRange | null>(null)
  // 편집 드래그 중인 노트 (놓을 때 onEditNote 로 확정)
  const editDraft = useRef<{ track: string; orig: Note; cur: Note; grab: number } | null>(null)
  const hover = useRef<Hover>(null)
  const drag = useRef<{ mode: DragMode; x: number; y: number; x0: number; sy: number } | null>(null)
  propsRef.current = props
  dirty.current = true

  // --- 레이아웃 ---
  function lay() {
    const { showChords, chords, showWave, peaks } = propsRef.current
    const rulerTop = MINI_H
    const chordTop = rulerTop + RULER_H
    const hasChords = showChords && chords.length > 0
    const waveTop = chordTop + (hasChords ? CHORD_H : 0)
    const hasWave = showWave && !!peaks
    const gridTop = waveTop + (hasWave ? WAVE_H : 0)
    return { rulerTop, chordTop, hasChords, waveTop, hasWave, gridTop }
  }

  // 좌표 변환
  const tx = (t: number) => KEY_W + (t - view.current.x0) * view.current.pps
  const xToT = (x: number) => view.current.x0 + (x - KEY_W) / view.current.pps
  const py = (p: number) => lay().gridTop + (MAX_PITCH - p) * view.current.keyH - view.current.scrollY
  const yToP = (y: number) => MAX_PITCH - Math.floor((y - lay().gridTop + view.current.scrollY) / view.current.keyH)
  const miniX = (t: number, W: number) => KEY_W + (t / Math.max(1, propsRef.current.duration)) * (W - KEY_W)

  function clampView() {
    const el = canvasRef.current
    if (!el) return
    const v = view.current
    const gridH = el.clientHeight - lay().gridTop
    v.keyH = Math.max(6, Math.min(40, v.keyH))
    v.scrollY = Math.max(0, Math.min(ROWS * v.keyH - gridH, v.scrollY))
    v.pps = Math.max(3, Math.min(2000, v.pps))
    const span = (el.clientWidth - KEY_W) / v.pps
    v.x0 = Math.max(0, Math.min(Math.max(0, propsRef.current.duration - span * 0.5), v.x0))
  }

  function fitPitch() {
    const el = canvasRef.current
    if (!el) return
    const { tracks, states } = propsRef.current
    const v = view.current
    const t0 = v.x0
    const t1 = xToT(el.clientWidth)
    let lo = Infinity
    let hi = -Infinity
    for (const pass of [true, false]) {
      for (const st of states) {
        if (!st.showNotes) continue
        for (const n of tracks.find((d) => d.id === st.id)?.notes ?? []) {
          if (pass && (n.end < t0 || n.start > t1)) continue
          lo = Math.min(lo, n.pitch)
          hi = Math.max(hi, n.pitch)
        }
      }
      if (lo <= hi) break // 화면 안에 노트가 없으면 곡 전체 기준
    }
    if (lo > hi) return
    const gridH = el.clientHeight - lay().gridTop
    v.keyH = gridH / (hi - lo + 5)
    clampView()
    v.scrollY = (MAX_PITCH - hi - 2) * v.keyH
    clampView()
    dirty.current = true
  }

  useImperativeHandle(ref, () => ({
    zoomTime(factor: number) {
      const el = canvasRef.current
      if (!el) return
      const v = view.current
      const now = propsRef.current.engine?.currentTime ?? 0
      const W = el.clientWidth
      // 재생 헤드가 화면 안이면 그 위치 기준, 아니면 화면 중앙 기준
      const anchorX = tx(now) >= KEY_W && tx(now) <= W ? tx(now) : (KEY_W + W) / 2
      const t = xToT(anchorX)
      v.pps *= factor
      clampView()
      v.x0 = t - (anchorX - KEY_W) / v.pps
      clampView()
      dirty.current = true
    },
    fitPitch,
  }))

  // 새 작업이 로드되면 보컬 음역대 중심으로 스크롤
  useEffect(() => {
    const vocal = props.tracks.find((t) => t.id === 'vocals')?.notes ?? []
    const ps = vocal.map((n) => n.pitch).sort((a, b) => a - b)
    const center = ps.length ? ps[Math.floor(ps.length / 2)] : 60
    const el = canvasRef.current
    const h = el?.clientHeight ?? 600
    const v = view.current
    v.x0 = 0
    v.pps = 120
    v.scrollY = (MAX_PITCH - center) * v.keyH - (h - lay().gridTop) / 2
    clampView()
    dirty.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.viewKey])

  function hitNote(x: number, y: number): { note: Note; track: string; edge: boolean } | null {
    const t = xToT(x)
    const p = yToP(y)
    const { tracks, states, editMode, editTrack } = propsRef.current
    // 편집 모드에서는 편집 대상 트랙만, 아니면 위에 그려진(나중 순서) 트랙부터
    const order = editMode && editTrack ? states.filter((s) => s.id === editTrack) : [...states].reverse()
    for (const st of order) {
      if (!st.showNotes) continue
      const notes = tracks.find((d) => d.id === st.id)?.notes
      const hit = notes?.find((n) => n.pitch === p && n.start <= t && t <= n.end)
      if (hit) {
        const w = (hit.end - hit.start) * view.current.pps
        return { note: hit, track: st.id, edge: w > 10 && tx(hit.end) - x < 6 }
      }
    }
    return null
  }

  function hitChord(x: number): Chord | null {
    const t = xToT(x)
    return propsRef.current.chords.find((c) => c.start <= t && t < c.end) ?? null
  }

  function draw() {
    const el = canvasRef.current
    if (!el) return
    const dpr = window.devicePixelRatio || 1
    const W = el.clientWidth
    const H = el.clientHeight
    if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) {
      el.width = Math.round(W * dpr)
      el.height = Math.round(H * dpr)
    }
    const g = el.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const P = propsRef.current
    const { engine, tracks, states, grid, follow, selected, scaleKey, nameKey, loopOn, chords, peaks, peaksRate } = P
    const L = lay()
    const loop = loopDraft.current ?? P.loop
    const scale = scaleKey ? scaleSet(scaleKey) : null
    const v = view.current
    const now = engine?.currentTime ?? 0
    const hv = hover.current
    const draft = editDraft.current

    // 재생 중 자동 스크롤
    if (engine?.isPlaying && follow && !drag.current) {
      const span = (W - KEY_W) / v.pps
      if (now > v.x0 + span * 0.85 || now < v.x0) v.x0 = Math.max(0, now - span * 0.1)
    }
    const t0 = v.x0
    const t1 = xToT(W)
    const kh = v.keyH
    const GT = L.gridTop

    // --- 그리드 배경 ---
    g.fillStyle = C.bg
    g.fillRect(0, 0, W, H)
    const pTop = Math.min(MAX_PITCH, yToP(GT))
    const pBot = Math.max(MIN_PITCH, yToP(H))
    for (let p = pBot; p <= pTop; p++) {
      const y = py(p)
      if (isBlack(p)) {
        g.fillStyle = C.rowBlack
        g.fillRect(KEY_W, y, W - KEY_W, kh)
      }
      if (scale) {
        // 스케일 밖 음은 어둡게, 으뜸음은 은은하게 강조
        if (!scale.has(p % 12)) {
          g.fillStyle = 'rgba(0,0,0,0.32)'
          g.fillRect(KEY_W, y, W - KEY_W, kh)
        } else if (p % 12 === scaleKey!.tonic) {
          g.fillStyle = 'rgba(255,209,102,0.06)'
          g.fillRect(KEY_W, y, W - KEY_W, kh)
        }
      }
      g.fillStyle = p % 12 === 0 ? C.octLine : C.rowLine
      g.fillRect(KEY_W, y + kh - 1, W - KEY_W, 1)
    }

    // --- 비트/마디/분할 선 ---
    const bars: { t: number; bar: number }[] = []
    grid.beats.forEach((b, i) => {
      if (b < t0 - 1 || b > t1 + 1) return
      const rel = i - grid.firstIndex
      const isBar = ((rel % 4) + 4) % 4 === 0
      if (isBar && rel >= 0) bars.push({ t: b, bar: rel / 4 + 1 })
      // 편집 모드: 스냅 격자 표시
      if (P.editMode && P.snapDiv > 1 && v.pps * grid.period / P.snapDiv > 8) {
        const next = grid.beats[i + 1] ?? b + grid.period
        g.fillStyle = C.sub
        for (let k = 1; k < P.snapDiv; k++) g.fillRect(Math.round(tx(b + ((next - b) * k) / P.snapDiv)), GT, 1, H - GT)
      }
      if (!isBar && v.pps < 40) return
      g.fillStyle = isBar ? C.bar : C.beat
      g.fillRect(Math.round(tx(b)), GT, 1, H - GT)
    })

    // --- 반복 구간 (그리드) ---
    const lx0 = loop ? Math.max(KEY_W, tx(loop.start)) : 0
    const lx1 = loop ? tx(loop.end) : 0
    if (loop && lx1 > KEY_W) {
      g.fillStyle = loopOn ? 'rgba(255,209,102,0.06)' : 'rgba(255,255,255,0.025)'
      g.fillRect(lx0, GT, lx1 - lx0, H - GT)
      g.fillStyle = loopOn ? 'rgba(255,209,102,0.5)' : 'rgba(255,255,255,0.15)'
      if (tx(loop.start) >= KEY_W) g.fillRect(lx0, GT, 1, H - GT)
      g.fillRect(lx1, GT, 1, H - GT)
    }

    // --- 노트 & 피치 곡선 ---
    const sounding = new Map<number, string>()
    for (const st of states) {
      if (!st.showNotes) continue
      const data = tracks.find((d) => d.id === st.id)
      if (!data?.notes) continue
      const dim = P.editMode && P.editTrack && P.editTrack !== st.id // 편집 대상 외 트랙은 흐리게
      const curve = data.pitch_curve
      if (curve && v.pps >= 30 && !dim) {
        g.strokeStyle = st.color + '66'
        g.lineWidth = 1.5
        g.beginPath()
        const i0 = Math.max(0, Math.floor(t0 * curve.fps))
        const i1 = Math.min(curve.values.length - 1, Math.ceil(t1 * curve.fps))
        let prev: number | null = null
        for (let i = i0; i <= i1; i++) {
          const m = curve.values[i]
          if (m == null) {
            prev = null
            continue
          }
          const x = tx(i / curve.fps)
          // 연속 피치값이므로 반음 사이도 그대로 표현 (행 중앙 = 정확한 음)
          const y = py(m) + kh / 2
          if (prev == null || Math.abs(prev - m) > 1.5) g.moveTo(x, y)
          else g.lineTo(x, y)
          prev = m
        }
        g.stroke()
      }
      for (const orig of data.notes) {
        const n = draft && draft.track === st.id && draft.orig === orig ? draft.cur : orig
        if (n.end < t0 || n.start > t1 || n.pitch < pBot - 1 || n.pitch > pTop + 1) continue
        const x = tx(n.start)
        const w = Math.max(2, (n.end - n.start) * v.pps)
        const y = py(n.pitch)
        g.globalAlpha = (dim ? 0.25 : 1) * (0.45 + 0.55 * (n.velocity / 127))
        g.fillStyle = st.color
        g.fillRect(x, y + 1, w, kh - 2)
        g.globalAlpha = dim ? 0.25 : 1
        g.fillStyle = 'rgba(0,0,0,0.35)'
        g.fillRect(x, y + 1, 2, kh - 2)
        if (scale && !scale.has(n.pitch % 12)) {
          // 스케일 밖 노트 표시 (채보 오류 후보)
          g.fillStyle = '#ff4d4f'
          g.fillRect(x, y + kh - 3, w, 2)
        }
        const isSel = orig === selected || (draft?.orig === orig)
        if (isSel || (hv?.kind === 'note' && hv.note === orig)) {
          g.strokeStyle = isSel ? '#fff' : 'rgba(255,255,255,0.6)'
          g.lineWidth = isSel ? 2 : 1
          g.strokeRect(x, y + 1, w, kh - 2)
        }
        if (w > 34 && kh >= 12) {
          g.fillStyle = 'rgba(0,0,0,0.7)'
          g.font = '10px system-ui, sans-serif'
          g.fillText(pitchName(n.pitch), x + 4, y + kh / 2 + 3.5)
        }
        g.globalAlpha = 1
        if (n.start <= now && now < n.end && !dim) sounding.set(n.pitch, st.color)
      }
    }

    // --- 재생 헤드 (그리드) ---
    const phx = tx(now)
    if (phx >= KEY_W) {
      g.fillStyle = C.playhead
      g.fillRect(Math.round(phx), GT, 1.5, H - GT)
    }

    // --- 파형 레인 ---
    if (L.hasWave && peaks) {
      const top = L.waveTop
      g.fillStyle = C.lane
      g.fillRect(KEY_W, top, W - KEY_W, WAVE_H)
      const mid = top + WAVE_H / 2
      const amp = WAVE_H / 2 - 3
      for (let x = KEY_W; x < W; x++) {
        const a = xToT(x)
        const b = xToT(x + 1)
        if (b < 0 || a > P.duration) continue
        const i0 = Math.max(0, Math.floor(a * peaksRate))
        const i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil(b * peaksRate)))
        let m = 0
        for (let i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i]
        const h = Math.max(1, m * amp)
        g.fillStyle = a < now ? '#8d97ab' : '#4c5566'
        g.fillRect(x, mid - h, 1, h * 2)
      }
      if (loop && lx1 > KEY_W) {
        g.fillStyle = loopOn ? 'rgba(255,209,102,0.12)' : 'rgba(255,255,255,0.04)'
        g.fillRect(lx0, top, lx1 - lx0, WAVE_H)
      }
      if (phx >= KEY_W) {
        g.fillStyle = C.playhead
        g.fillRect(Math.round(phx), top, 1.5, WAVE_H)
      }
      g.fillStyle = C.octLine
      g.fillRect(KEY_W, top + WAVE_H - 1, W - KEY_W, 1)
    }

    // --- 코드 레인 ---
    if (L.hasChords) {
      const top = L.chordTop
      g.fillStyle = C.lane
      g.fillRect(KEY_W, top, W - KEY_W, CHORD_H)
      for (const c of chords) {
        if (c.end < t0 || c.start > t1) continue
        const x = Math.max(KEY_W, tx(c.start))
        const x1 = Math.min(W, tx(c.end))
        const w = x1 - x
        if (w <= 0) continue
        const color = FUNCTION_COLOR[chordFunction(c, nameKey)]
        const isHover = hv?.kind === 'chord' && hv.chord === c
        const isNow = c.start <= now && now < c.end
        g.globalAlpha = isHover ? 0.95 : isNow ? 0.8 : 0.55
        g.fillStyle = color
        g.fillRect(x + 1, top + 3, w - 2, CHORD_H - 6)
        g.globalAlpha = 1
        if (isNow) {
          g.strokeStyle = '#fff'
          g.lineWidth = 1.5
          g.strokeRect(x + 1, top + 3, w - 2, CHORD_H - 6)
        }
        if (w > 22) {
          g.save()
          g.beginPath()
          g.rect(x + 1, top, w - 3, CHORD_H)
          g.clip()
          g.fillStyle = '#14161a'
          g.font = '600 12px system-ui, sans-serif'
          const name = chordName(c, nameKey)
          g.fillText(name, x + 5, top + CHORD_H / 2 + 4)
          const roman = romanNumeral(c, nameKey)
          if (roman && w > g.measureText(name).width + 34) {
            g.font = '10px system-ui, sans-serif'
            g.fillStyle = 'rgba(20,22,26,0.65)'
            g.fillText(roman, x + 9 + g.measureText(name).width + 6, top + CHORD_H / 2 + 4)
          }
          g.restore()
        }
      }
      if (loop && lx1 > KEY_W) {
        g.fillStyle = loopOn ? 'rgba(255,209,102,0.5)' : 'rgba(255,255,255,0.15)'
        if (tx(loop.start) >= KEY_W) g.fillRect(lx0, top, 1, CHORD_H)
        g.fillRect(lx1, top, 1, CHORD_H)
      }
      if (phx >= KEY_W) {
        g.fillStyle = C.playhead
        g.fillRect(Math.round(phx), top, 1.5, CHORD_H)
      }
      g.fillStyle = C.octLine
      g.fillRect(KEY_W, top + CHORD_H - 1, W - KEY_W, 1)
    }

    // --- 룰러 ---
    const RT = L.rulerTop
    g.fillStyle = C.ruler
    g.fillRect(KEY_W, RT, W - KEY_W, RULER_H)
    g.fillStyle = C.octLine
    g.fillRect(KEY_W, RT + RULER_H - 1, W - KEY_W, 1)
    if (loop && lx1 > KEY_W) {
      g.fillStyle = loopOn ? 'rgba(255,209,102,0.55)' : 'rgba(255,255,255,0.12)'
      g.fillRect(lx0, RT, lx1 - lx0, RULER_H - 1)
    }
    g.font = '11px system-ui, sans-serif'
    g.fillStyle = C.rulerText
    let lastX = -Infinity
    for (const { t, bar } of bars) {
      const x = tx(t)
      if (x < KEY_W) continue
      g.fillStyle = C.rulerText
      g.fillRect(Math.round(x), RT + RULER_H - 9, 1, 9)
      if (x - lastX >= 36) {
        g.fillText(String(bar), x + 3, RT + 11)
        lastX = x
      }
    }
    // 초 단위 보조 눈금
    const step = v.pps > 80 ? 1 : v.pps > 20 ? 5 : v.pps > 8 ? 15 : 30
    g.font = '9px system-ui, sans-serif'
    for (let s = Math.ceil(t0 / step) * step; s <= t1; s += step) {
      const x = tx(s)
      if (x < KEY_W) continue
      g.fillStyle = '#5d6577'
      g.fillRect(Math.round(x), RT + RULER_H - 4, 1, 4)
      g.fillText(fmtTime(s), x + 2, RT + RULER_H - 5)
    }
    if (phx >= KEY_W) {
      g.fillStyle = C.playhead
      g.beginPath()
      g.moveTo(phx - 6, RT)
      g.lineTo(phx + 6, RT)
      g.lineTo(phx, RT + 9)
      g.fill()
    }

    // --- 미니맵 (곡 전체) ---
    g.fillStyle = '#121418'
    g.fillRect(0, 0, W, MINI_H)
    for (const st of states) {
      if (!st.showNotes) continue
      g.fillStyle = st.color
      g.globalAlpha = 0.7
      for (const n of tracks.find((d) => d.id === st.id)?.notes ?? []) {
        const y = 2 + (1 - (n.pitch - MIN_PITCH) / (MAX_PITCH - MIN_PITCH)) * (MINI_H - 5)
        g.fillRect(miniX(n.start, W), y, Math.max(1, miniX(n.end, W) - miniX(n.start, W)), 1.5)
      }
    }
    g.globalAlpha = 1
    if (loop) {
      g.fillStyle = loopOn ? 'rgba(255,209,102,0.25)' : 'rgba(255,255,255,0.08)'
      g.fillRect(miniX(loop.start, W), 0, Math.max(1, miniX(loop.end, W) - miniX(loop.start, W)), MINI_H)
    }
    const vx0 = miniX(t0, W)
    const vx1 = Math.min(W - 1, miniX(t1, W))
    g.fillStyle = 'rgba(255,255,255,0.07)'
    g.fillRect(vx0, 0, vx1 - vx0, MINI_H)
    g.strokeStyle = 'rgba(255,255,255,0.45)'
    g.lineWidth = 1
    g.strokeRect(vx0 + 0.5, 0.5, Math.max(2, vx1 - vx0 - 1), MINI_H - 1)
    g.fillStyle = C.playhead
    g.fillRect(miniX(now, W), 0, 1.5, MINI_H)
    g.fillStyle = '#000'
    g.fillRect(0, MINI_H - 1, W, 1)

    // --- 세로 건반 ---
    const chordTones = hv?.kind === 'chord' ? new Set(hv.chord.pcs) : null
    g.fillStyle = C.keyWhite
    g.fillRect(0, GT, KEY_W, H - GT)
    for (let p = pBot; p <= pTop; p++) {
      const y = py(p)
      const hl = sounding.get(p) ?? (chordTones?.has(p % 12) ? '#b197fc' : undefined)
      if (scale && !scale.has(p % 12) && !hl && !isBlack(p)) {
        // 스케일 밖 흰건반은 회색 처리
        g.fillStyle = '#a9aeb8'
        g.fillRect(0, y, KEY_W, kh)
      }
      if (isBlack(p)) {
        g.fillStyle = hl ?? (scale && !scale.has(p % 12) ? '#3a3e47' : C.keyBlack)
        g.fillRect(0, y, KEY_W * 0.62, kh)
      } else {
        if (hl) {
          g.fillStyle = hl
          g.fillRect(0, y, KEY_W, kh)
        }
        // 흰건반 경계: B-C, E-F 사이 또는 검은건반 중앙
        g.fillStyle = '#9aa0ad'
        const pc = p % 12
        if (pc === 0 || pc === 5) g.fillRect(0, y + kh - 1, KEY_W, 1)
        else g.fillRect(KEY_W * 0.62, y + kh - 1, KEY_W * 0.38, 1)
      }
      if (p % 12 === 0 && kh >= 9) {
        g.fillStyle = C.keyText
        g.font = `${Math.min(11, kh - 2)}px system-ui, sans-serif`
        g.fillText(pitchName(p), KEY_W - 26, y + kh / 2 + 4)
      }
    }
    g.fillStyle = '#000'
    g.fillRect(KEY_W - 1, GT, 1, H - GT)

    // 왼쪽 열 레인 라벨
    g.fillStyle = C.ruler
    g.fillRect(0, MINI_H, KEY_W - 1, GT - MINI_H)
    g.fillStyle = '#5d6577'
    g.font = '10px system-ui, sans-serif'
    g.fillText('마디', 8, RT + 15)
    if (L.hasChords) g.fillText('코드', 8, L.chordTop + CHORD_H / 2 + 4)
    if (L.hasWave) g.fillText('파형', 8, L.waveTop + WAVE_H / 2 + 4)
    g.fillStyle = C.octLine
    g.fillRect(0, GT - 1, KEY_W, 1)

    // --- 호버 툴팁 ---
    if (hv && !drag.current) {
      let lines: string[]
      if (hv.kind === 'chord') {
        const c = hv.chord
        const roman = romanNumeral(c, nameKey)
        lines = [
          `${chordName(c, nameKey)}${roman ? `  ·  ${roman}` : ''}`,
          `구성음: ${c.pcs.map((pc) => pcName(pc, nameKey)).join(' ')}`,
          `${fmtTime(c.start)} – ${fmtTime(c.end)}  ·  클릭: 구간 반복`,
        ]
      } else {
        const p = hv.kind === 'note' ? hv.note.pitch : hv.pitch
        // 호버한 음의 행을 건반과 그리드에 은은하게 표시
        g.fillStyle = 'rgba(255,255,255,0.05)'
        g.fillRect(KEY_W, py(p), W - KEY_W, kh)
        g.fillStyle = 'rgba(255,209,102,0.45)'
        g.fillRect(0, py(p), KEY_W - 1, kh)
        lines =
          hv.kind === 'note'
            ? [
                `${pitchName(p)}  ·  ${states.find((s) => s.id === hv.track)?.label ?? hv.track}`,
                `${hv.note.start.toFixed(2)}s – ${hv.note.end.toFixed(2)}s  (${(hv.note.end - hv.note.start).toFixed(2)}s)`,
                `MIDI ${p}  ·  vel ${hv.note.velocity}  ·  ${midiHz(p).toFixed(1)} Hz`,
              ]
            : [`${pitchName(p)}  ·  MIDI ${p}  ·  ${midiHz(p).toFixed(1)} Hz`]
      }
      g.font = '12px system-ui, sans-serif'
      const tw = Math.max(...lines.map((l) => g.measureText(l).width)) + 16
      const th = lines.length * 16 + 10
      let bx = hv.x + 14
      let by = hv.y + 16
      if (bx + tw > W - 4) bx = hv.x - tw - 10
      if (by + th > H - 4) by = hv.y - th - 8
      g.fillStyle = 'rgba(12,14,18,0.94)'
      g.strokeStyle = '#3a404c'
      g.lineWidth = 1
      g.beginPath()
      g.roundRect(bx, by, tw, th, 5)
      g.fill()
      g.stroke()
      lines.forEach((l, i) => {
        g.fillStyle = i === 0 ? '#fff' : C.rulerText
        g.font = i === 0 ? '600 12px system-ui, sans-serif' : '11px system-ui, sans-serif'
        g.fillText(l, bx + 8, by + 17 + i * 16)
      })
    }
  }

  // 렌더 루프: 재생 중이거나 상태가 바뀐 경우에만 다시 그림
  useEffect(() => {
    let raf = 0
    const loop = () => {
      if (dirty.current || propsRef.current.engine?.isPlaying) {
        dirty.current = false
        draw()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const ro = new ResizeObserver(() => {
      clampView()
      dirty.current = true
    })
    ro.observe(wrapRef.current!)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 휠: 세로 스크롤 / Shift 가로 / Ctrl 가로 줌 / Alt 세로 줌
  useEffect(() => {
    const el = canvasRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = view.current
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const GT = lay().gridTop
      if (e.ctrlKey || e.metaKey) {
        const t = xToT(mx)
        v.pps *= Math.exp(-e.deltaY * 0.0015)
        clampView()
        v.x0 = t - (mx - KEY_W) / v.pps
      } else if (e.altKey) {
        const rowPos = (my - GT + v.scrollY) / v.keyH
        v.keyH *= Math.exp(-e.deltaY * 0.0015)
        clampView()
        v.scrollY = rowPos * v.keyH - (my - GT)
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || my < GT) {
        // 레인(미니맵/룰러/코드/파형) 위에서는 세로 휠도 가로 이동
        v.x0 += (e.shiftKey || my < GT ? e.deltaY : e.deltaX) / v.pps
      } else {
        v.scrollY += e.deltaY
      }
      clampView()
      dirty.current = true
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 박자 스냅. 반복 구간은 박 단위, 노트 편집은 snapDiv 단위. Shift = 자유 */
  function snap(t: number, free: boolean, div: number) {
    const { grid, duration } = propsRef.current
    t = Math.max(0, Math.min(duration, t))
    return free ? t : snapTime(grid, t, div)
  }

  function centerMini(x: number) {
    const el = canvasRef.current!
    const v = view.current
    const span = (el.clientWidth - KEY_W) / v.pps
    const t = ((x - KEY_W) / (el.clientWidth - KEY_W)) * propsRef.current.duration
    v.x0 = t - span / 2
    clampView()
  }

  function pos(e: React.PointerEvent | React.MouseEvent) {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return
    const { x, y } = pos(e)
    const P = propsRef.current
    const L = lay()
    const start = (mode: DragMode) => {
      drag.current = { mode, x, y, x0: view.current.x0, sy: view.current.scrollY }
    }
    if (e.button === 1) {
      start('pan')
    } else if (y < MINI_H && x > KEY_W) {
      centerMini(x)
      start('mini')
    } else if (y < L.rulerTop + RULER_H && x > KEY_W) {
      // 반복 구간 가장자리 → 크기 조절, 그 외 → 클릭(이동) 또는 드래그(새 구간)
      const lp = P.loop
      const edge = lp && Math.abs(tx(lp.start) - x) < 6 ? 'loopStart' : lp && Math.abs(tx(lp.end) - x) < 6 ? 'loopEnd' : null
      if (edge && lp) loopDraft.current = { ...lp }
      start(edge ?? 'ruler')
    } else if (L.hasChords && y < L.chordTop + CHORD_H && x > KEY_W) {
      const c = hitChord(x)
      if (c) {
        P.onLoopChange({ start: c.start, end: c.end })
        P.engine?.seek(c.start)
      }
    } else if (y < L.gridTop && x > KEY_W) {
      // 파형 레인 클릭 = 이동
      P.engine?.seek(Math.max(0, xToT(x)))
      start('ruler')
    } else if (x < KEY_W && y > L.gridTop) {
      P.engine?.preview(yToP(y))
    } else if (y > L.gridTop) {
      const hit = hitNote(x, y)
      if (hit) {
        P.onSelect(hit.note, hit.track)
        P.engine?.preview(hit.note.pitch, Math.min(1, hit.note.end - hit.note.start))
        if (P.editMode && hit.track === P.editTrack) {
          editDraft.current = { track: hit.track, orig: hit.note, cur: hit.note, grab: xToT(x) - hit.note.start }
          start(hit.edge ? 'resize' : 'move')
        }
      } else {
        P.onSelect(null, null)
        start('pan')
      }
    }
    canvasRef.current!.setPointerCapture(e.pointerId)
    dirty.current = true
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current
    const el = canvasRef.current!
    const { x, y } = pos(e)
    const P = propsRef.current
    const L = lay()
    if (!d) {
      const prev = hover.current
      const inGrid = y > L.gridTop && x > KEY_W
      const hit = inGrid ? hitNote(x, y) : null
      const chord = L.hasChords && y >= L.chordTop && y < L.chordTop + CHORD_H && x > KEY_W ? hitChord(x) : null
      if (hit) hover.current = { kind: 'note', note: hit.note, track: hit.track, x, y }
      else if (chord) hover.current = { kind: 'chord', chord, x, y }
      else if (x < KEY_W && y > L.gridTop) hover.current = { kind: 'key', pitch: yToP(y), x, y }
      else hover.current = null
      if (prev || hover.current) dirty.current = true
      const lp = P.loop
      const inRuler = y >= L.rulerTop && y < L.rulerTop + RULER_H
      const onEdge = !!lp && inRuler && (Math.abs(tx(lp.start) - x) < 6 || Math.abs(tx(lp.end) - x) < 6)
      const editable = hit && P.editMode && hit.track === P.editTrack
      el.style.cursor = onEdge || (editable && hit.edge)
        ? 'ew-resize'
        : editable
          ? 'move'
          : y < MINI_H
            ? 'pointer'
            : y < L.gridTop
              ? chord ? 'pointer' : 'text'
              : x < KEY_W || hit
                ? 'pointer'
                : 'grab'
      return
    }
    hover.current = null
    const free = e.shiftKey
    if (d.mode === 'ruler' && Math.abs(x - d.x) > 4 && d.y < L.rulerTop + RULER_H) d.mode = 'loopNew'
    if (d.mode === 'mini') {
      centerMini(x)
    } else if (d.mode === 'loopNew') {
      const a = snap(xToT(d.x), free, 1)
      const b = snap(xToT(x), free, 1)
      loopDraft.current = { start: Math.min(a, b), end: Math.max(a, b) }
    } else if (d.mode === 'loopStart' || d.mode === 'loopEnd') {
      const t = snap(xToT(x), free, 1)
      const cur = loopDraft.current!
      const other = d.mode === 'loopStart' ? cur.end : cur.start
      loopDraft.current = { start: Math.min(t, other), end: Math.max(t, other) }
      d.mode = t <= other ? 'loopStart' : 'loopEnd'
    } else if ((d.mode === 'move' || d.mode === 'resize') && editDraft.current) {
      const ed = editDraft.current
      const div = P.snapDiv
      if (d.mode === 'move') {
        const len = ed.orig.end - ed.orig.start
        const start = Math.max(0, snap(xToT(x) - ed.grab, free || !div, div))
        const pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, yToP(y)))
        if (pitch !== ed.cur.pitch) P.engine?.preview(pitch, 0.25)
        ed.cur = { ...ed.orig, start, end: start + len, pitch }
      } else {
        const minLen = div ? stepAt(P.grid, ed.orig.start, div) : 0.03
        const end = Math.max(ed.orig.start + minLen, snap(xToT(x), free || !div, div))
        ed.cur = { ...ed.orig, end }
      }
      el.style.cursor = d.mode === 'move' ? 'move' : 'ew-resize'
    } else if (d.mode === 'pan') {
      view.current.x0 = d.x0 - (x - d.x) / view.current.pps
      view.current.scrollY = d.sy - (y - d.y)
      clampView()
      el.style.cursor = 'grabbing'
    }
    dirty.current = true
  }

  function onPointerUp() {
    const d = drag.current
    drag.current = null
    if (!d) return
    const P = propsRef.current
    if (d.mode === 'ruler' && d.y < lay().rulerTop + RULER_H) {
      P.engine?.seek(Math.max(0, xToT(d.x)))
    } else if ((d.mode === 'loopNew' || d.mode === 'loopStart' || d.mode === 'loopEnd') && loopDraft.current) {
      const r = loopDraft.current
      P.onLoopChange(r.end - r.start >= 0.1 ? r : null)
    } else if ((d.mode === 'move' || d.mode === 'resize') && editDraft.current) {
      const ed = editDraft.current
      const o = ed.orig
      const n = ed.cur
      if (n.start !== o.start || n.end !== o.end || n.pitch !== o.pitch) P.onEditNote(ed.track, o, n)
    }
    loopDraft.current = null
    editDraft.current = null
    dirty.current = true
  }

  function onPointerLeave() {
    if (drag.current) return
    hover.current = null
    dirty.current = true
  }

  // 편집 모드: 빈 곳 더블클릭 = 노트 추가 (1박 길이)
  function onDoubleClick(e: React.MouseEvent) {
    const P = propsRef.current
    const { x, y } = pos(e)
    if (!P.editMode || !P.editTrack || y <= lay().gridTop || x <= KEY_W || hitNote(x, y)) return
    const start = snap(xToT(x), e.shiftKey || !P.snapDiv, P.snapDiv || 1)
    const note: Note = { pitch: yToP(y), start, end: start + stepAt(P.grid, start, 1), velocity: 100 }
    P.onEditNote(P.editTrack, null, note)
    P.engine?.preview(note.pitch, 0.3)
  }

  // 편집 모드: 노트 우클릭 = 삭제
  function onContextMenu(e: React.MouseEvent) {
    const P = propsRef.current
    if (!P.editMode) return
    e.preventDefault()
    const { x, y } = pos(e)
    const hit = y > lay().gridTop ? hitNote(x, y) : null
    if (hit && hit.track === P.editTrack) {
      P.onEditNote(hit.track, hit.note, null)
      hover.current = null
    }
  }

  return (
    <div ref={wrapRef} className="pianoroll">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
    </div>
  )
})
