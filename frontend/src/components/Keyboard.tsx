import { useEffect, useRef } from 'react'
import type { AudioEngine } from '../audio/engine'
import { pcName } from '../music/chords'
import type { Key } from '../music/key'
import type { Note } from '../types'

interface Props {
  engine: AudioEngine | null
  rh: Note[] // sorted by start
  lh: Note[]
  rhColor: string
  lhColor: string
  nameKey: Key | null
}

const BLACK = new Set([1, 3, 6, 8, 10])
const isBlack = (p: number) => BLACK.has(p % 12)

/** Notes sounding at `now`, and the next ones to come (the nearest later onset) */
function around(notes: Note[], now: number) {
  const on: number[] = []
  const next: number[] = []
  let nextAt = Infinity
  for (const n of notes) {
    if (n.start <= now) {
      if (now < n.end) on.push(n.pitch)
    } else if (n.start <= nextAt + 1e-6) {
      nextAt = n.start
      next.push(n.pitch)
    } else break
  }
  return { on, next }
}

/** Piano keyboard that lights up the keys to press now (filled) and next (outlined), per hand */
export function Keyboard(p: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const propsRef = useRef(p)
  propsRef.current = p
  const layout = useRef<{ lo: number; whiteW: number; whites: number[] }>({ lo: 48, whiteW: 20, whites: [] })

  useEffect(() => {
    let raf = 0
    let lastSig = ''
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const el = canvasRef.current
      if (!el) return
      const P = propsRef.current
      const now = P.engine?.currentTime ?? 0
      const r = around(P.rh, now)
      const l = around(P.lh, now)
      const W = el.clientWidth
      const H = el.clientHeight
      const sig = `${W}x${H}|${r.on}|${r.next}|${l.on}|${l.next}|${P.rh.length}|${P.lh.length}|${P.nameKey?.tonic}`
      if (sig === lastSig) return
      lastSig = sig

      // range: whole octaves around everything the arrangement uses
      let min = Infinity
      let max = -Infinity
      for (const n of P.rh) {
        if (n.pitch < min) min = n.pitch
        if (n.pitch > max) max = n.pitch
      }
      for (const n of P.lh) {
        if (n.pitch < min) min = n.pitch
        if (n.pitch > max) max = n.pitch
      }
      if (min > max) {
        min = 48
        max = 72
      }
      let lo = Math.floor(min / 12) * 12
      let hi = Math.ceil((max + 1) / 12) * 12 // a C, inclusive
      while (hi - lo < 36) {
        if (lo > 24) lo -= 12
        if (hi - lo < 36) hi += 12
      }
      const whites: number[] = []
      for (let q = lo; q <= hi; q++) if (!isBlack(q)) whites.push(q)
      const whiteW = W / whites.length
      layout.current = { lo, whiteW, whites }

      const dpr = window.devicePixelRatio || 1
      if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) {
        el.width = Math.round(W * dpr)
        el.height = Math.round(H * dpr)
      }
      const g = el.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)

      const state = new Map<number, { color: string; on: boolean }>()
      for (const q of l.next) state.set(q, { color: P.lhColor, on: false })
      for (const q of r.next) state.set(q, { color: P.rhColor, on: false })
      for (const q of l.on) state.set(q, { color: P.lhColor, on: true })
      for (const q of r.on) state.set(q, { color: P.rhColor, on: true })

      const blackW = whiteW * 0.62
      const blackH = H * 0.62
      const label = (q: number, x: number, w: number, y: number, dark: boolean) => {
        const name = pcName(q % 12, P.nameKey)
        g.font = `600 ${Math.max(9, Math.min(12, w - 2))}px system-ui, sans-serif`
        g.textAlign = 'center'
        g.fillStyle = dark ? '#14161a' : '#fff'
        g.fillText(name, x + w / 2, y)
      }
      whites.forEach((q, i) => {
        const x = i * whiteW
        const st = state.get(q)
        g.fillStyle = st?.on ? st.color : '#e6e8ee'
        g.fillRect(x, 0, whiteW - 1, H)
        if (st && !st.on) {
          g.strokeStyle = st.color
          g.lineWidth = 3
          g.strokeRect(x + 2, H * 0.66, whiteW - 5, H * 0.34 - 2)
        }
        if (st) label(q, x, whiteW - 1, H - 7, true)
        else if (q % 12 === 0 && whiteW >= 14) {
          g.font = '10px system-ui, sans-serif'
          g.textAlign = 'center'
          g.fillStyle = '#8a93a6'
          g.fillText(`C${q / 12 - 1}`, x + whiteW / 2, H - 7)
        }
      })
      whites.forEach((q, i) => {
        const b = q + 1
        if (!isBlack(b) || b > hi) return
        const x = (i + 1) * whiteW - blackW / 2
        const st = state.get(b)
        g.fillStyle = st?.on ? st.color : '#1b1d23'
        g.fillRect(x, 0, blackW, blackH)
        if (st && !st.on) {
          g.strokeStyle = st.color
          g.lineWidth = 3
          g.strokeRect(x + 1.5, 1.5, blackW - 3, blackH - 3)
        }
        if (st && blackW >= 12) label(b, x, blackW, blackH - 6, st.on)
      })
      g.textAlign = 'start'
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  function onPointerDown(e: React.PointerEvent) {
    const el = canvasRef.current!
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const { whiteW, whites } = layout.current
    if (!whites.length) return
    const i = Math.max(0, Math.min(whites.length - 1, Math.floor(x / whiteW)))
    let pitch = whites[i]
    if (y < rect.height * 0.62) {
      // upper part: a black key if the pointer is over one
      const frac = x / whiteW - i
      if (frac > 0.69 && isBlack(pitch + 1)) pitch += 1
      else if (frac < 0.31 && isBlack(pitch - 1)) pitch -= 1
    }
    propsRef.current.engine?.preview(pitch)
  }

  return <canvas ref={canvasRef} className="keyboard" onPointerDown={onPointerDown} />
}
