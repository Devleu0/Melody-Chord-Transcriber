import { useEffect, useRef } from 'react'
import type { AudioEngine } from '../audio/engine'
import type { Note, TrackData, TrackState } from '../types'

const KEY_W = 72
const RULER_H = 30
const MIN_PITCH = 21 // A0
const MAX_PITCH = 108 // C8
const ROWS = MAX_PITCH - MIN_PITCH + 1
const BLACK = new Set([1, 3, 6, 8, 10])
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const pitchName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`
const isBlack = (p: number) => BLACK.has(p % 12)

const C = {
  bg: '#16181d',
  rowBlack: '#121418',
  rowLine: '#1f2229',
  octLine: '#2f3440',
  beat: '#22262e',
  bar: '#3a404c',
  ruler: '#1d2027',
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

interface Props {
  engine: AudioEngine | null
  tracks: TrackData[]
  states: TrackState[]
  beats: number[]
  duration: number
  follow: boolean
  selected: Note | null
  onSelect: (n: Note | null, trackId: string | null) => void
}

export function PianoRoll(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const propsRef = useRef(props)
  const view = useRef<View>({ x0: 0, pps: 120, scrollY: 0, keyH: 14 })
  const dirty = useRef(true)
  propsRef.current = props
  dirty.current = true

  // 새 결과가 로드되면 보컬 음역대 중심으로 스크롤
  useEffect(() => {
    const vocal = props.tracks.find((t) => t.id === 'vocals')?.notes ?? []
    const ps = vocal.map((n) => n.pitch).sort((a, b) => a - b)
    const center = ps.length ? ps[Math.floor(ps.length / 2)] : 60
    const h = canvasRef.current?.clientHeight ?? 600
    const v = view.current
    v.x0 = 0
    v.scrollY = (MAX_PITCH - center) * v.keyH - (h - RULER_H) / 2
    clampView()
    dirty.current = true
  }, [props.tracks])

  function clampView() {
    const el = canvasRef.current
    if (!el) return
    const v = view.current
    const gridH = el.clientHeight - RULER_H
    v.keyH = Math.max(6, Math.min(40, v.keyH))
    v.scrollY = Math.max(0, Math.min(ROWS * v.keyH - gridH, v.scrollY))
    v.pps = Math.max(5, Math.min(2000, v.pps))
    const span = (el.clientWidth - KEY_W) / v.pps
    v.x0 = Math.max(0, Math.min(Math.max(0, propsRef.current.duration - span * 0.5), v.x0))
  }

  // 좌표 변환
  const tx = (t: number) => KEY_W + (t - view.current.x0) * view.current.pps
  const py = (p: number) => RULER_H + (MAX_PITCH - p) * view.current.keyH - view.current.scrollY
  const xToT = (x: number) => view.current.x0 + (x - KEY_W) / view.current.pps
  const yToP = (y: number) => MAX_PITCH - Math.floor((y - RULER_H + view.current.scrollY) / view.current.keyH)

  function hitNote(x: number, y: number): { note: Note; track: string } | null {
    const t = xToT(x)
    const p = yToP(y)
    const { tracks, states } = propsRef.current
    // 위에 그려진(나중 순서) 트랙부터 검사
    for (const st of [...states].reverse()) {
      if (!st.showNotes) continue
      const notes = tracks.find((d) => d.id === st.id)?.notes
      const hit = notes?.find((n) => n.pitch === p && n.start <= t && t <= n.end)
      if (hit) return { note: hit, track: st.id }
    }
    return null
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
    const { engine, tracks, states, beats, follow, selected } = propsRef.current
    const v = view.current
    const now = engine?.currentTime ?? 0

    // 재생 중 자동 스크롤
    if (engine?.isPlaying && follow) {
      const span = (W - KEY_W) / v.pps
      if (now > v.x0 + span * 0.85 || now < v.x0) {
        v.x0 = Math.max(0, now - span * 0.1)
      }
    }
    const t0 = v.x0
    const t1 = xToT(W)
    const kh = v.keyH

    // --- 그리드 배경 ---
    g.fillStyle = C.bg
    g.fillRect(0, 0, W, H)
    const pTop = Math.min(MAX_PITCH, yToP(RULER_H))
    const pBot = Math.max(MIN_PITCH, yToP(H))
    for (let p = pBot; p <= pTop; p++) {
      const y = py(p)
      if (isBlack(p)) {
        g.fillStyle = C.rowBlack
        g.fillRect(KEY_W, y, W - KEY_W, kh)
      }
      g.fillStyle = p % 12 === 0 ? C.octLine : C.rowLine
      g.fillRect(KEY_W, y + kh - 1, W - KEY_W, 1)
    }

    // --- 비트/마디 선 ---
    const barIdx: { t: number; bar: number }[] = []
    if (beats.length > 1) {
      beats.forEach((b, i) => {
        if (b < t0 - 1 || b > t1 + 1) return
        const isBar = i % 4 === 0
        if (isBar) barIdx.push({ t: b, bar: i / 4 + 1 })
        // 줌 아웃 시 비트선 생략
        if (!isBar && v.pps < 40) return
        g.fillStyle = isBar ? C.bar : C.beat
        g.fillRect(Math.round(tx(b)), RULER_H, 1, H - RULER_H)
      })
    } else {
      for (let s = Math.floor(t0); s <= t1; s++) {
        g.fillStyle = s % 5 === 0 ? C.bar : C.beat
        g.fillRect(Math.round(tx(s)), RULER_H, 1, H - RULER_H)
      }
    }

    // --- 노트 & 피치 곡선 ---
    const sounding = new Map<number, string>()
    for (const st of states) {
      if (!st.showNotes) continue
      const data = tracks.find((d) => d.id === st.id)
      if (!data?.notes) continue
      const curve = data.pitch_curve
      if (curve && v.pps >= 30) {
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
      for (const n of data.notes) {
        if (n.end < t0 || n.start > t1 || n.pitch < pBot - 1 || n.pitch > pTop + 1) continue
        const x = tx(n.start)
        const w = Math.max(2, (n.end - n.start) * v.pps)
        const y = py(n.pitch)
        g.globalAlpha = 0.45 + 0.55 * (n.velocity / 127)
        g.fillStyle = st.color
        g.fillRect(x, y + 1, w, kh - 2)
        g.globalAlpha = 1
        g.fillStyle = 'rgba(0,0,0,0.35)'
        g.fillRect(x, y + 1, 2, kh - 2)
        if (n === selected) {
          g.strokeStyle = '#fff'
          g.lineWidth = 2
          g.strokeRect(x, y + 1, w, kh - 2)
        }
        if (w > 34 && kh >= 12) {
          g.fillStyle = 'rgba(0,0,0,0.7)'
          g.font = '10px system-ui, sans-serif'
          g.fillText(pitchName(n.pitch), x + 4, y + kh / 2 + 3.5)
        }
        if (n.start <= now && now < n.end) sounding.set(n.pitch, st.color)
      }
    }

    // --- 재생 헤드 ---
    const phx = tx(now)
    if (phx >= KEY_W) {
      g.fillStyle = C.playhead
      g.fillRect(Math.round(phx), RULER_H, 1.5, H - RULER_H)
    }

    // --- 룰러 ---
    g.fillStyle = C.ruler
    g.fillRect(KEY_W, 0, W - KEY_W, RULER_H)
    g.fillStyle = C.octLine
    g.fillRect(KEY_W, RULER_H - 1, W - KEY_W, 1)
    g.font = '11px system-ui, sans-serif'
    g.fillStyle = C.rulerText
    if (barIdx.length) {
      const minGap = 36
      let lastX = -Infinity
      for (const { t, bar } of barIdx) {
        const x = tx(t)
        if (x < KEY_W) continue
        g.fillRect(Math.round(x), RULER_H - 10, 1, 10)
        if (x - lastX >= minGap) {
          g.fillText(String(bar), x + 3, 13)
          lastX = x
        }
      }
    }
    // 초 단위 보조 눈금
    const step = v.pps > 80 ? 1 : v.pps > 20 ? 5 : 15
    for (let s = Math.ceil(t0 / step) * step; s <= t1; s += step) {
      const x = tx(s)
      if (x < KEY_W) continue
      g.fillStyle = '#5d6577'
      g.fillRect(Math.round(x), RULER_H - 4, 1, 4)
      g.font = '9px system-ui, sans-serif'
      g.fillText(fmtTime(s), x + 2, RULER_H - 5)
    }
    if (phx >= KEY_W) {
      g.fillStyle = C.playhead
      g.beginPath()
      g.moveTo(phx - 6, 0)
      g.lineTo(phx + 6, 0)
      g.lineTo(phx, 9)
      g.fill()
    }

    // --- 세로 건반 ---
    g.fillStyle = C.keyWhite
    g.fillRect(0, RULER_H, KEY_W, H - RULER_H)
    for (let p = pBot; p <= pTop; p++) {
      const y = py(p)
      const hl = sounding.get(p)
      if (isBlack(p)) {
        g.fillStyle = hl ?? C.keyBlack
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
    g.fillRect(KEY_W - 1, RULER_H, 1, H - RULER_H)
    g.fillStyle = C.ruler
    g.fillRect(0, 0, KEY_W, RULER_H)
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
      if (e.ctrlKey || e.metaKey) {
        const t = xToT(mx)
        v.pps *= Math.exp(-e.deltaY * 0.0015)
        clampView()
        v.x0 = t - (mx - KEY_W) / v.pps
      } else if (e.altKey) {
        const rowPos = (my - RULER_H + v.scrollY) / v.keyH
        v.keyH *= Math.exp(-e.deltaY * 0.0015)
        clampView()
        v.scrollY = rowPos * v.keyH - (my - RULER_H)
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        v.x0 += (e.shiftKey ? e.deltaY : e.deltaX) / v.pps
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

  const drag = useRef<{ mode: 'seek' | 'pan'; x: number; y: number; x0: number; sy: number } | null>(null)

  function onPointerDown(e: React.PointerEvent) {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const { engine, onSelect } = propsRef.current
    if (y < RULER_H && x > KEY_W) {
      engine?.seek(Math.max(0, xToT(x)))
      drag.current = { mode: 'seek', x, y, x0: 0, sy: 0 }
    } else if (x < KEY_W && y > RULER_H) {
      engine?.preview(yToP(y))
    } else if (y > RULER_H) {
      const hit = hitNote(x, y)
      if (hit) {
        onSelect(hit.note, hit.track)
        engine?.preview(hit.note.pitch, Math.min(1, hit.note.end - hit.note.start))
      } else {
        onSelect(null, null)
        drag.current = { mode: 'pan', x, y, x0: view.current.x0, sy: view.current.scrollY }
      }
    }
    canvasRef.current!.setPointerCapture(e.pointerId)
    dirty.current = true
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current
    const el = canvasRef.current!
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (!d) {
      el.style.cursor = y < RULER_H ? 'col-resize' : x < KEY_W ? 'pointer' : hitNote(x, y) ? 'pointer' : 'grab'
      return
    }
    if (d.mode === 'seek') {
      propsRef.current.engine?.seek(Math.max(0, xToT(x)))
    } else {
      view.current.x0 = d.x0 - (x - d.x) / view.current.pps
      view.current.scrollY = d.sy - (y - d.y)
      clampView()
      el.style.cursor = 'grabbing'
    }
    dirty.current = true
  }

  function onPointerUp() {
    drag.current = null
  }

  return (
    <div ref={wrapRef} className="pianoroll">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  )
}

export function fmtTime(s: number) {
  const total = Math.floor(s)
  const m = Math.floor(total / 60)
  const sec = total % 60
  return `${m}:${sec < 10 ? '0' : ''}${sec}`
}
