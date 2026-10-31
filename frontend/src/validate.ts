import type { TFn } from './i18n'
import type { ProbeResult, Separator, ServerInfo } from './types'

export type UrlKind = 'empty' | 'invalid' | 'youtube' | 'youtube-playlist' | 'other'

const YT_HOST = /^(?:[\w-]+\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i

/** Classify a pasted link before asking the server about it */
export function classifyUrl(raw: string): UrlKind {
  const s = raw.trim()
  if (!s) return 'empty'
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return 'invalid'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'invalid'
  if (!YT_HOST.test(u.hostname)) return 'other'
  return u.searchParams.has('list') ? 'youtube-playlist' : 'youtube'
}

export type DurationLevel = 'unknown' | 'short' | 'ok' | 'warn' | 'long'

export function durationLevel(sec: number | null, info: ServerInfo | null): DurationLevel {
  if (sec == null || !Number.isFinite(sec) || sec <= 0 || !info) return 'unknown'
  if (sec < info.min_duration) return 'short'
  if (sec > info.max_duration) return 'long'
  if (sec > info.warn_duration) return 'warn'
  return 'ok'
}

/** Rough GPU processing time in seconds (null on CPU, where it varies too much to promise a number) */
export function estimateSeconds(sec: number, separator: Separator, info: ServerInfo | null): number | null {
  if (!info || info.device !== 'cuda') return null
  return sec * (info.gpu_seconds_per_audio_second[separator] ?? 0.65)
}

/** Read an audio file's length in the browser, without uploading it (null if the browser can't decode it) */
export function readAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio')
    const done = (v: number | null) => {
      URL.revokeObjectURL(url)
      el.removeAttribute('src')
      resolve(v)
    }
    const timer = window.setTimeout(() => done(null), 8000)
    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      window.clearTimeout(timer)
      done(Number.isFinite(el.duration) ? el.duration : null)
    }
    el.onerror = () => {
      window.clearTimeout(timer)
      done(null)
    }
    el.src = url
  })
}

/** What we know about the pending input (link or file) before it is submitted */
export interface Preview {
  kind: 'url' | 'file'
  loading: boolean
  urlKind?: UrlKind
  error?: string | null
  title?: string | null
  uploader?: string | null
  site?: string | null
  thumbnail?: string | null
  duration: number | null
  size?: number
  isLive?: boolean
  duplicates?: ProbeResult['duplicates']
}

export type Level = 'info' | 'warn' | 'error'

/** Messages to show and whether submitting should be blocked */
export function assess(p: Preview, info: ServerInfo | null, separator: Separator, t: TFn) {
  const msgs: { level: Level; text: string }[] = []
  if (p.kind === 'url') {
    if (p.urlKind === 'invalid') msgs.push({ level: 'error', text: t('pv.invalidUrl') })
    if (p.urlKind === 'other' && !p.loading && !p.error) msgs.push({ level: 'info', text: t('pv.otherSite', { site: p.site ?? '?' }) })
    if (p.urlKind === 'youtube-playlist' && !p.error) msgs.push({ level: 'info', text: t('pv.playlist') })
    if (p.error) msgs.push({ level: 'error', text: t('pv.error', { e: p.error }) })
    if (p.isLive) msgs.push({ level: 'error', text: t('pv.live') })
  }
  if (p.kind === 'file' && info && p.size != null && p.size > info.max_upload_bytes) {
    msgs.push({ level: 'error', text: t('pv.tooBig', { max: Math.round(info.max_upload_bytes / 1024 / 1024) }) })
  }
  const level = durationLevel(p.duration, info)
  if (!p.loading && !p.error) {
    if (level === 'short') msgs.push({ level: 'error', text: t('pv.tooShort', { min: info!.min_duration }) })
    if (level === 'long') msgs.push({ level: 'error', text: t('pv.tooLong', { max: Math.round(info!.max_duration / 60) }) })
    if (level === 'warn') msgs.push({ level: 'warn', text: t('pv.longWarn') })
    if (level === 'unknown' && p.kind === 'file') msgs.push({ level: 'info', text: t('pv.unknownDuration') })
    if (level === 'ok' || level === 'warn') {
      const est = estimateSeconds(p.duration!, separator, info)
      if (est != null) {
        const m = est < 60 ? t('pv.underMinute') : t('pv.minutes', { m: Math.ceil(est / 60) })
        msgs.push({ level: 'info', text: t('pv.estimate', { time: m, gpu: info?.gpu ?? 'GPU' }) })
      } else if (info?.device === 'cpu') {
        msgs.push({ level: 'warn', text: t('pv.cpu') })
      }
    }
  }
  const blocked = p.loading ? false : msgs.some((m) => m.level === 'error')
  return { msgs, blocked }
}
