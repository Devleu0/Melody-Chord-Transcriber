import type { Note } from '../types'

const LOOKAHEAD = 0.15 // scheduling lookahead (s, audio clock)
const START_DELAY = 0.05

export interface LoopRange {
  start: number
  end: number
}

interface AudioTrack {
  buffer: AudioBuffer
  gain: GainNode
}

interface SynthTrack {
  notes: Note[] // sorted by start
  gain: GainNode
}

/** Playback segment: plays song time song0..songEnd starting at audio clock ctx0 */
interface Segment {
  ctx0: number
  song0: number
  songEnd: number
  loops: boolean // whether it jumps back to the loop start at songEnd
  sources: AudioBufferSourceNode[]
  schedUntil: number // song time up to which synth notes are scheduled
}

const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12)

/** Index of the first note with start >= t */
function lowerBound(notes: Note[], t: number) {
  let lo = 0
  let hi = notes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (notes[mid].start < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Plays multiple stems sample-synchronously, along with transcribed notes on a simple synth.
 * - Looping: the next segment is pre-scheduled on the audio clock so it rewinds gaplessly.
 * - Speed: uses pitch-preserving buffers from the server, mapping song time = buffer time × rate.
 */
export class AudioEngine {
  readonly ctx = new AudioContext()
  private master = this.ctx.createGain()
  private audio = new Map<string, AudioTrack>()
  private synth = new Map<string, SynthTrack>()
  private segs: Segment[] = []
  private offset = 0 // song time while stopped
  private timer: number | undefined
  private rate = 1
  private loopRange: LoopRange | null = null
  duration = 0
  onEnded?: () => void

  constructor() {
    this.master.connect(this.ctx.destination)
  }

  private async fetchBuffer(url: string) {
    const data = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Failed to load audio: ${url}`)
      return r.arrayBuffer()
    })
    return this.ctx.decodeAudioData(data)
  }

  async loadAudio(id: string, url: string) {
    const buffer = await this.fetchBuffer(url)
    const gain = this.ctx.createGain()
    gain.connect(this.master)
    this.audio.set(id, { buffer, gain })
    this.duration = Math.max(this.duration, buffer.duration)
  }

  /** Change playback speed. urls are each track's audio converted to that speed */
  async setRate(rate: number, urls: Map<string, string>) {
    if (rate === this.rate) return
    const wasPlaying = this.isPlaying
    const buffers = await Promise.all([...urls].map(async ([id, url]) => [id, await this.fetchBuffer(url)] as const))
    const pos = this.currentTime
    if (wasPlaying) this.stopAll()
    for (const [id, buffer] of buffers) {
      const t = this.audio.get(id)
      if (t) t.buffer = buffer
    }
    this.rate = rate
    this.offset = pos
    if (wasPlaying) void this.play()
  }

  get playbackRate() {
    return this.rate
  }

  /** Set synth track notes. Gain (volume/mute) is kept when called again after edits. */
  setNotes(id: string, notes: Note[]) {
    let gain = this.synth.get(id)?.gain
    if (!gain) {
      gain = this.ctx.createGain()
      gain.gain.value = 0
      gain.connect(this.master)
    }
    // even during playback, new notes apply from the not-yet-scheduled range (after schedUntil)
    this.synth.set(id, { notes: [...notes].sort((a, b) => a.start - b.start), gain })
  }

  /** Max |sample| for the waveform display (rate per second), from the original buffer as loaded */
  peaks(id: string, rate = 200): Float32Array | null {
    const t = this.audio.get(id)
    if (!t) return null
    const buf = t.buffer
    const size = Math.max(1, Math.floor(buf.sampleRate / rate))
    const out = new Float32Array(Math.ceil(buf.length / size))
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c)
      for (let i = 0; i < out.length; i++) {
        let m = out[i]
        const end = Math.min(data.length, (i + 1) * size)
        for (let j = i * size; j < end; j++) {
          const v = data[j] < 0 ? -data[j] : data[j]
          if (v > m) m = v
        }
        out[i] = m
      }
    }
    return out
  }

  setAudioGain(id: string, v: number) {
    this.audio.get(id)?.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  setSynthGain(id: string, v: number) {
    this.synth.get(id)?.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  setMasterVolume(v: number) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  /** Set/clear the loop range. Reschedules from the current position if playing. */
  setLoop(range: LoopRange | null) {
    this.loopRange = range && range.end - range.start >= 0.1 ? range : null
    if (this.isPlaying) this.seek(this.currentTime)
  }

  get loop() {
    return this.loopRange
  }

  get isPlaying() {
    return this.segs.length > 0
  }

  get currentTime() {
    if (!this.isPlaying) return this.offset
    const now = this.ctx.currentTime
    // based on the latest segment that has already started
    let seg = this.segs[0]
    for (const s of this.segs) if (s.ctx0 <= now) seg = s
    const t = seg.song0 + Math.max(0, now - seg.ctx0) * this.rate
    return Math.min(seg.songEnd, t)
  }

  async play() {
    if (this.isPlaying) return
    await this.ctx.resume()
    if (this.offset >= this.duration - 0.01) this.offset = this.loopRange?.start ?? 0
    this.startSegment(this.ctx.currentTime + START_DELAY, this.offset)
    this.timer = window.setInterval(() => this.tick(), 25)
  }

  pause() {
    if (!this.isPlaying) return
    this.offset = this.currentTime
    this.stopAll()
  }

  seek(time: number) {
    const wasPlaying = this.isPlaying
    if (wasPlaying) this.stopAll()
    this.offset = Math.max(0, Math.min(time, this.duration))
    if (wasPlaying) void this.play()
  }

  private startSegment(ctx0: number, song0: number) {
    const loop = this.loopRange
    // starting before the loop end rewinds there; starting after it plays to the end of the song
    const loops = !!loop && song0 < loop.end - 0.01
    const seg: Segment = {
      ctx0,
      song0,
      songEnd: loops ? loop!.end : this.duration,
      loops,
      sources: [],
      schedUntil: song0,
    }
    for (const t of this.audio.values()) {
      const src = this.ctx.createBufferSource()
      src.buffer = t.buffer
      src.connect(t.gain)
      src.start(ctx0, song0 / this.rate)
      seg.sources.push(src)
    }
    // notes that should already be sounding at the segment start
    for (const s of this.synth.values()) {
      for (const n of s.notes) {
        if (n.start >= song0) break
        if (n.end > song0) this.voice(n.pitch, ctx0, (Math.min(n.end, seg.songEnd) - song0) / this.rate, n.velocity, s.gain)
      }
    }
    this.segs.push(seg)
    return seg
  }

  private stopAll() {
    for (const seg of this.segs) {
      for (const src of seg.sources) {
        try {
          src.stop()
        } catch {
          /* source not started yet */
        }
        src.disconnect()
      }
    }
    this.segs = []
    window.clearInterval(this.timer)
  }

  private tick() {
    const now = this.ctx.currentTime
    // clean up finished segments
    while (this.segs.length > 1 && this.segs[1].ctx0 <= now) {
      this.segs.shift()
    }
    const cur = this.segs[0]
    const endCtx = cur.ctx0 + (cur.songEnd - cur.song0) / this.rate

    if (!cur.loops && now >= endCtx) {
      this.stopAll()
      this.offset = this.duration
      this.onEnded?.()
      return
    }
    // as the loop end approaches, schedule the next segment at the exact time
    if (cur.loops && this.segs.length === 1 && endCtx - now < LOOKAHEAD && this.loopRange) {
      for (const src of cur.sources) src.stop(endCtx)
      this.startSegment(endCtx, this.loopRange.start)
    }

    for (const seg of this.segs) {
      const horizon = Math.min(seg.songEnd, seg.song0 + (now + LOOKAHEAD - seg.ctx0) * this.rate)
      if (horizon <= seg.schedUntil) continue
      for (const s of this.synth.values()) {
        for (let i = lowerBound(s.notes, seg.schedUntil); i < s.notes.length && s.notes[i].start < horizon; i++) {
          const n = s.notes[i]
          const at = seg.ctx0 + (n.start - seg.song0) / this.rate
          const dur = (Math.min(n.end, seg.songEnd) - n.start) / this.rate
          this.voice(n.pitch, Math.max(at, now), dur, n.velocity, s.gain)
        }
      }
      seg.schedUntil = horizon
    }
  }

  /** One synth note (triangle + short envelope) */
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

  /** Preview on key/note click */
  preview(pitch: number, dur = 0.4) {
    void this.ctx.resume()
    this.voice(pitch, this.ctx.currentTime, dur, 100, this.master)
  }

  dispose() {
    this.stopAll()
    void this.ctx.close()
  }
}
