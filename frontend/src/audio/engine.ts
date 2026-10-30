import type { Note } from '../types'

const LOOKAHEAD = 0.15 // 노트 스케줄 선행 시간(s)

interface AudioTrack {
  buffer: AudioBuffer
  gain: GainNode
  source?: AudioBufferSourceNode
}

interface SynthTrack {
  notes: Note[]
  gain: GainNode
  cursor: number
}

const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12)

/**
 * 여러 stem 을 샘플 단위로 동기 재생하고, 채보된 노트를 간단한 신스로 함께 재생한다.
 */
export class AudioEngine {
  readonly ctx = new AudioContext()
  private master = this.ctx.createGain()
  private audio = new Map<string, AudioTrack>()
  private synth = new Map<string, SynthTrack>()
  private playing = false
  private startCtxTime = 0
  private offset = 0
  private timer: number | undefined
  duration = 0
  onEnded?: () => void

  constructor() {
    this.master.connect(this.ctx.destination)
  }

  async loadAudio(id: string, url: string) {
    const data = await fetch(url).then((r) => r.arrayBuffer())
    const buffer = await this.ctx.decodeAudioData(data)
    const gain = this.ctx.createGain()
    gain.connect(this.master)
    this.audio.set(id, { buffer, gain })
    this.duration = Math.max(this.duration, buffer.duration)
  }

  setNotes(id: string, notes: Note[]) {
    const gain = this.ctx.createGain()
    gain.gain.value = 0
    gain.connect(this.master)
    this.synth.set(id, { notes: [...notes].sort((a, b) => a.start - b.start), gain, cursor: 0 })
  }

  setAudioGain(id: string, v: number) {
    const t = this.audio.get(id)
    t?.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  setSynthGain(id: string, v: number) {
    const t = this.synth.get(id)
    t?.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  get isPlaying() {
    return this.playing
  }

  get currentTime() {
    if (!this.playing) return this.offset
    return Math.min(this.duration, this.offset + (this.ctx.currentTime - this.startCtxTime))
  }

  async play() {
    if (this.playing) return
    await this.ctx.resume()
    if (this.offset >= this.duration) this.offset = 0
    const when = this.ctx.currentTime + 0.05
    this.startCtxTime = when
    for (const t of this.audio.values()) {
      const src = this.ctx.createBufferSource()
      src.buffer = t.buffer
      src.connect(t.gain)
      src.start(when, this.offset)
      t.source = src
    }
    for (const s of this.synth.values()) {
      s.cursor = s.notes.findIndex((n) => n.start >= this.offset)
      if (s.cursor < 0) s.cursor = s.notes.length
    }
    this.playing = true
    this.timer = window.setInterval(() => this.tick(), 25)
  }

  pause() {
    if (!this.playing) return
    this.offset = this.currentTime
    this.stopSources()
  }

  seek(time: number) {
    const wasPlaying = this.playing
    if (wasPlaying) this.stopSources()
    this.offset = Math.max(0, Math.min(time, this.duration))
    if (wasPlaying) void this.play()
  }

  private stopSources() {
    for (const t of this.audio.values()) {
      t.source?.stop()
      t.source?.disconnect()
      t.source = undefined
    }
    window.clearInterval(this.timer)
    this.playing = false
  }

  private tick() {
    const now = this.currentTime
    if (now >= this.duration) {
      this.pause()
      this.offset = this.duration
      this.onEnded?.()
      return
    }
    const horizon = now + LOOKAHEAD
    for (const s of this.synth.values()) {
      while (s.cursor < s.notes.length && s.notes[s.cursor].start < horizon) {
        const n = s.notes[s.cursor++]
        if (n.end <= now) continue
        const at = this.startCtxTime + (n.start - this.offset)
        this.voice(n.pitch, Math.max(at, this.ctx.currentTime), n.end - Math.max(n.start, now), n.velocity, s.gain)
      }
    }
  }

  /** 신스 한 음 (트라이앵글 + 짧은 엔벨로프) */
  private voice(pitch: number, at: number, dur: number, velocity: number, out: AudioNode) {
    const osc = this.ctx.createOscillator()
    const env = this.ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = midiToHz(pitch)
    const peak = 0.25 * (velocity / 127)
    const end = at + Math.max(0.05, dur)
    env.gain.setValueAtTime(0, at)
    env.gain.linearRampToValueAtTime(peak, at + 0.01)
    env.gain.setTargetAtTime(peak * 0.6, at + 0.01, 0.1)
    env.gain.setTargetAtTime(0, end, 0.03)
    osc.connect(env).connect(out)
    osc.start(at)
    osc.stop(end + 0.2)
  }

  /** 건반/노트 클릭 미리듣기 */
  preview(pitch: number, dur = 0.4) {
    void this.ctx.resume()
    this.voice(pitch, this.ctx.currentTime, dur, 100, this.master)
  }

  dispose() {
    this.stopSources()
    void this.ctx.close()
  }
}
