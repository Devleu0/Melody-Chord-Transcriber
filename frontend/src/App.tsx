import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { AudioEngine, type LoopRange } from './audio/engine'
import { HistoryPanel } from './components/HistoryPanel'
import { InputPreview } from './components/InputPreview'
import { PianoRoll, type PianoRollHandle } from './components/PianoRoll'
import { TrackPanel } from './components/TrackPanel'
import { useI18n, type MsgKey } from './i18n'
import { chordToNotes, leadSheet } from './music/chords'
import { fmtTime, pitchName } from './music/format'
import { beatIndex, makeGrid, snapTime, stepAt } from './music/grid'
import { ALL_KEYS, detectKey, keyId, keyName, parseKeyId } from './music/key'
import type { Job, Note, Result, Separator, ServerInfo, TrackData, TrackState } from './types'
import { assess, classifyUrl, readAudioDuration, type Preview } from './validate'

const TRACK_COLORS: Record<string, string> = {
  mix: '#adb5bd',
  chords: '#b197fc',
  vocals: '#ff6b8b',
  accompaniment: '#4dabf7',
  bass: '#ffd43b',
  other: '#69db7c',
  drums: '#868e96',
}
// Draw order in the piano roll, bottom to top (vocals on top)
const ORDER = ['mix', 'chords', 'drums', 'accompaniment', 'bass', 'other', 'vocals']

const STAGES: Job['status'][] = ['queued', 'downloading', 'separating', 'transcribing', 'chords', 'finalizing', 'done']

// Must match UPLOAD_EXTS in backend/app/config.py
const UPLOAD_EXTS = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wma', '.aif', '.aiff', '.webm', '.mp4', '.mkv', '.mov']
const fileExt = (name: string) => (name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()
const fmtSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const SPEEDS = [0.5, 0.6, 0.75, 0.9, 1]
const SNAPS = [0, 1, 2, 4]
const PEAKS_RATE = 200

function loadPref<T>(key: string, fallback: T): T {
  try {
    // 'yt-amt.' is the prefix used before the project was renamed
    const raw = localStorage.getItem(`mct.${key}`) ?? localStorage.getItem(`yt-amt.${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`mct.${key}`, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

type SaveState = 'saved' | 'pending' | 'saving' | 'error'

export default function App() {
  const { t, lang, setLang } = useI18n()
  const trackLabel = useCallback((id: string) => t(`track.${id}` as MsgKey) ?? id, [t])
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [info, setInfo] = useState<ServerInfo | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [separator, setSeparator] = useState<Separator>('roformer')
  const [jobs, setJobs] = useState<Job[]>([])
  const [jobId, setJobId] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const resultRef = useRef<Result | null>(null)
  resultRef.current = result
  const [states, setStates] = useState<TrackState[]>([])
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [follow, setFollow] = useState(true)
  const [selected, setSelected] = useState<{ note: Note; track: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const engineRef = useRef<AudioEngine | null>(null)
  const [engine, setEngine] = useState<AudioEngine | null>(null)
  const rollRef = useRef<PianoRollHandle>(null)
  const [loop, setLoop] = useState<LoopRange | null>(null)
  const [loopOn, setLoopOn] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [speedLoading, setSpeedLoading] = useState(false)
  const [master, setMaster] = useState(() => loadPref('master', 0.8))
  const [showWave, setShowWave] = useState(() => loadPref('showWave', true))
  const [keyChoice, setKeyChoice] = useState<string>('auto') // 'auto' | 'off' | keyId
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // Editing
  const [editMode, setEditMode] = useState(false)
  const [editTrack, setEditTrack] = useState<string | null>('vocals')
  const [snapDiv, setSnapDiv] = useState(() => loadPref('snapDiv', 4))
  const undoStack = useRef<{ track: string; notes: Note[] }[]>([])
  const redoStack = useRef<{ track: string; notes: Note[] }[]>([])
  const [, setStackVersion] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const pendingSave = useRef(new Set<string>())
  const saveTimer = useRef<number | undefined>(undefined)

  const job = jobs.find((j) => j.id === jobId) ?? null
  const running = !!job && job.status !== 'done' && job.status !== 'error'
  const chords = result?.chords?.chords ?? []

  const grid = useMemo(() => makeGrid(result?.beats ?? [], duration || 1), [result?.beats, duration])
  // Estimate the key from every transcribed note
  const detectedKey = useMemo(
    () => (result ? detectKey(result.tracks.flatMap((tr) => tr.notes ?? [])) : null),
    [result],
  )
  const scaleKey = keyChoice === 'off' ? null : keyChoice === 'auto' ? detectedKey : parseKeyId(keyChoice)
  const nameKey = scaleKey ?? detectedKey

  const refreshJobs = useCallback(() => api.listJobs().then(setJobs).catch(() => {}), [])

  useEffect(() => {
    void refreshJobs()
    api.info().then(setInfo).catch(() => {})
  }, [refreshJobs])

  // Check a pasted link (debounced): format first, then title / length / duplicates from the server
  useEffect(() => {
    if (file) return
    const kind = classifyUrl(url)
    if (kind === 'empty') {
      setPreview(null)
      return
    }
    if (kind === 'invalid') {
      setPreview({ kind: 'url', urlKind: kind, loading: false, duration: null })
      return
    }
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => {
      setPreview({ kind: 'url', urlKind: kind, loading: true, duration: null })
      api
        .probe(url.trim(), ctrl.signal)
        .then((r) =>
          setPreview({
            kind: 'url',
            urlKind: kind,
            loading: false,
            title: r.title,
            uploader: r.uploader,
            site: r.site,
            thumbnail: r.thumbnail,
            duration: r.duration || null,
            isLive: r.is_live,
            duplicates: r.duplicates,
          }),
        )
        .catch((e: Error) => {
          if (e.name !== 'AbortError') setPreview({ kind: 'url', urlKind: kind, loading: false, duration: null, error: e.message })
        })
    }, 600)
    return () => {
      window.clearTimeout(timer)
      ctrl.abort()
    }
  }, [url, file])

  // Poll while a job is running
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(refreshJobs, 1000)
    return () => window.clearInterval(timer)
  }, [running, refreshJobs])

  // --- Autosave after edits ---
  const flushSave = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    const r = resultRef.current
    if (!r || pendingSave.current.size === 0) return
    const tracks = [...pendingSave.current]
    pendingSave.current.clear()
    setSaveState('saving')
    try {
      for (const id of tracks) {
        const notes = r.tracks.find((tr) => tr.id === id)?.notes
        if (notes) await api.saveNotes(r.job_id, id, notes)
      }
      setSaveState(pendingSave.current.size ? 'pending' : 'saved')
    } catch (e) {
      tracks.forEach((id) => pendingSave.current.add(id))
      setSaveState('error')
      setError(t('err.save', { e: String(e) }))
    }
  }, [t])

  const scheduleSave = useCallback(
    (track: string) => {
      pendingSave.current.add(track)
      setSaveState('pending')
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => void flushSave(), 600)
    },
    [flushSave],
  )

  /** Replace a track's data (and record it for undo) */
  const replaceTrack = useCallback((track: string, patch: Partial<TrackData>, record = true) => {
    const r = resultRef.current
    if (!r) return
    const prev = r.tracks.find((tr) => tr.id === track)
    if (!prev?.notes) return
    if (record) {
      undoStack.current.push({ track, notes: prev.notes })
      if (undoStack.current.length > 200) undoStack.current.shift()
      redoStack.current = []
    }
    const next = { ...r, tracks: r.tracks.map((tr) => (tr.id === track ? { ...tr, ...patch } : tr)) }
    resultRef.current = next
    setResult(next)
    setStackVersion((v) => v + 1)
  }, [])

  const editNotes = useCallback(
    (track: string, notes: Note[]) => {
      replaceTrack(track, { notes: [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch), edited: true })
      scheduleSave(track)
    },
    [replaceTrack, scheduleSave],
  )

  const onEditNote = useCallback(
    (track: string, before: Note | null, after: Note | null) => {
      const notes = resultRef.current?.tracks.find((tr) => tr.id === track)?.notes
      if (!notes) return
      const next = before ? notes.filter((n) => n !== before) : [...notes]
      if (after) next.push(after)
      editNotes(track, next)
      setSelected(after ? { note: after, track } : null)
    },
    [editNotes],
  )

  const undoRedo = useCallback(
    (dir: 'undo' | 'redo') => {
      const from = dir === 'undo' ? undoStack.current : redoStack.current
      const to = dir === 'undo' ? redoStack.current : undoStack.current
      const entry = from.pop()
      const r = resultRef.current
      if (!entry || !r) return
      const cur = r.tracks.find((tr) => tr.id === entry.track)?.notes ?? []
      to.push({ track: entry.track, notes: cur })
      replaceTrack(entry.track, { notes: entry.notes, edited: true }, false)
      scheduleSave(entry.track)
      setSelected(null)
    },
    [replaceTrack, scheduleSave],
  )

  const quantize = useCallback(() => {
    const r = resultRef.current
    const notes = r?.tracks.find((tr) => tr.id === editTrack)?.notes
    if (!editTrack || !notes || !snapDiv) return
    editNotes(
      editTrack,
      notes.map((n) => {
        const start = Math.max(0, snapTime(grid, n.start, snapDiv))
        let end = snapTime(grid, n.end, snapDiv)
        if (end <= start + 1e-3) end = start + stepAt(grid, start, snapDiv)
        return { ...n, start: +start.toFixed(3), end: +end.toFixed(3) }
      }),
    )
    setSelected(null)
  }, [editTrack, snapDiv, grid, editNotes])

  // --- Load a finished job ---
  useEffect(() => {
    if (!job || job.status !== 'done' || result?.job_id === job.id) return
    let cancelled = false
    ;(async () => {
      await flushSave()
      const res = await api.getResult(job.id)
      if (cancelled) return
      engineRef.current?.dispose()
      const eng = new AudioEngine()
      eng.onEnded = () => setPlaying(false)
      engineRef.current = eng
      setEngine(eng)
      setResult(res)
      setSelected(null)
      setTime(0)
      setPlaying(false)
      setLoop(null)
      setLoopOn(false)
      setSpeed(1)
      setKeyChoice('auto')
      setPeaks(null)
      setDuration(res.meta.duration ?? 0)
      setEditMode(false)
      undoStack.current = []
      redoStack.current = []
      const ids = ['chords', ...res.tracks.map((tr) => tr.id)]
      const sorted = ids.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
      setStates(
        sorted.map((id) => {
          const tr = res.tracks.find((d) => d.id === id)
          return {
            id,
            label: id,
            color: TRACK_COLORS[id] ?? '#ced4da',
            hasNotes: !!tr?.notes,
            showNotes: id === 'chords' || !!tr?.notes,
            audioOn: id === 'mix',
            solo: false,
            volume: id === 'chords' ? 0.6 : 0.9,
            synthOn: false,
          }
        }),
      )
      setLoadingAudio(true)
      try {
        await Promise.all(res.tracks.map((tr) => eng.loadAudio(tr.id, api.fileUrl(res.job_id, tr.audio))))
        if (cancelled) return
        setDuration(eng.duration)
        setPeaks(eng.peaks('mix', PEAKS_RATE))
      } finally {
        if (!cancelled) setLoadingAudio(false)
      }
    })().catch((e) => setError(String(e)))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status])

  // Transcribed notes and chords -> engine synth tracks
  useEffect(() => {
    if (!engine || !result) return
    for (const tr of result.tracks) if (tr.notes) engine.setNotes(tr.id, tr.notes)
    engine.setNotes('chords', chordToNotes(result.chords?.chords ?? []))
  }, [engine, result])

  // Mixer state -> engine gains
  useEffect(() => {
    if (!engine || loadingAudio) return
    const anySolo = states.some((s) => s.solo)
    for (const s of states) {
      const audible = anySolo ? s.solo : s.audioOn
      engine.setAudioGain(s.id, audible ? s.volume : 0)
      engine.setSynthGain(s.id, s.synthOn && (!anySolo || s.solo) ? s.volume : 0)
    }
  }, [states, engine, loadingAudio])

  useEffect(() => {
    engine?.setLoop(loopOn ? loop : null)
  }, [engine, loop, loopOn])

  useEffect(() => {
    engine?.setMasterVolume(master)
    savePref('master', master)
  }, [engine, master])

  useEffect(() => savePref('showWave', showWave), [showWave])
  useEffect(() => savePref('snapDiv', snapDiv), [snapDiv])

  async function changeSpeed(next: number) {
    const eng = engineRef.current
    if (!eng || !result) return
    setSpeedLoading(true)
    setError(null)
    try {
      const urls = new Map(
        result.tracks.map((tr) => [
          tr.id,
          next === 1 ? api.fileUrl(result.job_id, tr.audio) : api.stretchUrl(result.job_id, tr.audio, next),
        ]),
      )
      await eng.setRate(next, urls)
      setSpeed(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setSpeedLoading(false)
    }
  }

  async function retranscribe(track: string, params: Record<string, number>) {
    const r = resultRef.current
    if (!r) return
    setBusy(track)
    setError(null)
    try {
      await flushSave()
      const data = await api.retranscribe(r.job_id, track, params)
      replaceTrack(track, { notes: data.notes, pitch_curve: data.pitch_curve, params: data.params, edited: false })
      setSelected(null)
    } catch (e) {
      setError(t('err.retranscribe', { e: String(e) }))
    } finally {
      setBusy(null)
    }
  }

  async function reanalyzeChords(penalty: number) {
    const r = resultRef.current
    if (!r) return
    setBusy('chords')
    setError(null)
    try {
      const c = await api.reanalyzeChords(r.job_id, penalty)
      const next = { ...(resultRef.current ?? r), chords: c }
      resultRef.current = next
      setResult(next)
    } catch (e) {
      setError(t('err.chords', { e: String(e) }))
    } finally {
      setBusy(null)
    }
  }

  async function deleteJob(id: string) {
    try {
      await api.deleteJob(id)
      if (id === jobId) {
        engineRef.current?.dispose()
        engineRef.current = null
        setEngine(null)
        setResult(null)
        setJobId(null)
      }
      await refreshJobs()
    } catch (e) {
      setError(t('err.delete', { e: String(e) }))
    }
  }

  const changeLoop = useCallback((r: LoopRange | null) => {
    setLoop(r)
    setLoopOn(!!r)
  }, [])

  // Refresh the time readout while playing
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => setTime(engineRef.current?.currentTime ?? 0), 100)
    return () => window.clearInterval(timer)
  }, [playing])

  const togglePlay = useCallback(() => {
    const eng = engineRef.current
    if (!eng || loadingAudio) return
    if (eng.isPlaying) {
      eng.pause()
      setPlaying(false)
    } else {
      void eng.play()
      setPlaying(true)
    }
    setTime(eng.currentTime)
  }, [loadingAudio])

  const seekTo = useCallback((sec: number) => {
    engineRef.current?.seek(sec)
    setTime(engineRef.current?.currentTime ?? sec)
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return
      const ctrl = e.ctrlKey || e.metaKey
      const eng = engineRef.current
      if (ctrl && e.code === 'KeyZ') {
        e.preventDefault()
        undoRedo(e.shiftKey ? 'redo' : 'undo')
      } else if (ctrl && e.code === 'KeyY') {
        e.preventDefault()
        undoRedo('redo')
      } else if (ctrl) {
        return
      } else if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'Home') {
        seekTo(loopOn && loop ? loop.start : 0)
      } else if (e.code === 'KeyL' && loop) {
        setLoopOn((v) => !v)
      } else if (e.code === 'Escape') {
        if (selected) setSelected(null)
        else changeLoop(null)
      } else if (e.code === 'KeyE' && result) {
        setEditMode((v) => !v)
      } else if (e.code === 'KeyQ' && editMode) {
        quantize()
      } else if ((e.code === 'Delete' || e.code === 'Backspace') && editMode && selected && selected.track === editTrack) {
        e.preventDefault()
        onEditNote(selected.track, selected.note, null)
      } else if (e.code === 'KeyF') {
        rollRef.current?.fitPitch()
      } else if (e.key === '+' || e.key === '=') {
        rollRef.current?.zoomTime(1.4)
      } else if (e.key === '-' || e.key === '_') {
        rollRef.current?.zoomTime(1 / 1.4)
      } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && eng) {
        // ← → move by one bar (4 beats)
        e.preventDefault()
        const i = beatIndex(grid, eng.currentTime + 0.01)
        const target = grid.beats[Math.max(0, i + (e.code === 'ArrowRight' ? 4 : -4))] ?? 0
        seekTo(Math.max(0, target))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, seekTo, loop, loopOn, selected, editMode, editTrack, result, grid, undoRedo, quantize, onEditNote, changeLoop])

  const pickFile = useCallback(
    (f: File | undefined) => {
      if (!f) return
      if (!UPLOAD_EXTS.includes(fileExt(f.name))) {
        setError(t('err.fileType', { ext: fileExt(f.name) || f.name }))
        return
      }
      setError(null)
      setFile(f)
      // Read the length locally so long / short files are caught before uploading
      setPreview({ kind: 'file', loading: true, title: f.name, size: f.size, duration: null })
      void readAudioDuration(f).then((d) =>
        setPreview((p) => (p?.kind === 'file' && p.title === f.name ? { ...p, loading: false, duration: d } : p)),
      )
    },
    [t],
  )

  // Drag and drop an audio file anywhere on the page
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDragging(false)
      pickFile(e.dataTransfer?.files[0])
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [pickFile])

  const check = preview ? assess(preview, info, separator, t) : null
  const blocked = !!check?.blocked

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (blocked) return
    setError(null)
    try {
      let j: Job
      if (file) {
        setUploadPct(0)
        j = await api.uploadJob(file, separator, setUploadPct)
        setFile(null)
      } else {
        j = await api.createJob(url.trim(), separator)
        setUrl('')
      }
      setPreview(null)
      setJobs((js) => [j, ...js])
      setJobId(j.id)
    } catch (err) {
      setError(String(err))
    } finally {
      setUploadPct(null)
    }
  }

  const patchTrack = (id: string, patch: Partial<TrackState>) =>
    setStates((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  // Track labels follow the current language
  const labeledStates = useMemo(() => states.map((s) => ({ ...s, label: trackLabel(s.id) })), [states, trackLabel])
  const chordState = states.find((s) => s.id === 'chords')
  const editable = result?.tracks.filter((tr) => tr.notes) ?? []
  const saveLabel: Record<SaveState, MsgKey> = {
    saved: 'ed.saved',
    saving: 'ed.saving',
    pending: 'ed.pending',
    error: 'ed.saveError',
  }
  const jobMessage = (j: Job) => {
    if (j.status === 'error') return t('msg.error', { error: j.error ?? '' })
    if (j.status === 'done') return ''
    if (j.status === 'downloading' && j.source === 'file') return t('msg.importing')
    const detail = j.status === 'transcribing' && j.detail ? trackLabel(j.detail) : j.detail ?? ''
    return t(`msg.${j.status}` as MsgKey, { detail })
  }
  const stageLabel = (j: Job, s: Job['status']) =>
    s === 'downloading' && j.source === 'file' ? t('stage.importing') : t(`stage.${s}` as MsgKey)

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">♪ Melody Chord Transcriber</div>
        <form className="url-form" onSubmit={submit}>
          {file ? (
            <div className="file-chip" title={file.name}>
              <span>🎵 {file.name}</span>
              <small>{fmtSize(file.size)}</small>
              <button
                type="button"
                onClick={() => {
                  setFile(null)
                  setPreview(null)
                }}
                title={t('app.file.remove')}
                aria-label={t('app.file.remove')}
              >
                ✕
              </button>
            </div>
          ) : (
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('app.placeholder')} required />
          )}
          <button
            type="button"
            className="file-btn"
            onClick={() => fileInput.current?.click()}
            title={t('app.file.pick')}
            aria-label={t('app.file.pick')}
          >
            📎
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept={['audio/*', 'video/*', ...UPLOAD_EXTS].join(',')}
            onChange={(e) => {
              pickFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <div className="seg">
            <button type="button" className={separator === 'roformer' ? 'on' : ''} onClick={() => setSeparator('roformer')}>
              RoFormer <small>{t('app.sep.roformer')}</small>
            </button>
            <button type="button" className={separator === 'demucs' ? 'on' : ''} onClick={() => setSeparator('demucs')}>
              Demucs <small>{t('app.sep.demucs')}</small>
            </button>
          </div>
          <button className="primary" disabled={running || uploadPct !== null || blocked}>
            {uploadPct !== null ? t('app.uploading', { pct: Math.round(uploadPct * 100) }) : t('app.start')}
          </button>
        </form>
        <button className="history-btn" onClick={() => setHistoryOpen(true)}>
          📁 {t('app.history')} <span>{jobs.length}</span>
        </button>
        <div className="seg lang" role="group" aria-label="Language">
          <button className={lang === 'ko' ? 'on' : ''} onClick={() => setLang('ko')}>
            한국어
          </button>
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>
            EN
          </button>
        </div>
      </header>

      {preview && (
        <InputPreview
          preview={preview}
          info={info}
          separator={separator}
          onOpenJob={(id) => {
            setJobId(id)
            setUrl('')
            setPreview(null)
          }}
        />
      )}

      {error && (
        <div className="banner error" onClick={() => setError(null)} title={t('app.dismiss')}>
          {error}
        </div>
      )}

      {job && job.status !== 'done' && (
        <div className={`banner ${job.status === 'error' ? 'error' : ''}`}>
          <div className="stages">
            {STAGES.map((s) => (
              <span
                key={s}
                className={`stage ${STAGES.indexOf(s) < STAGES.indexOf(job.status) ? 'past' : ''} ${s === job.status ? 'cur' : ''}`}
              >
                {stageLabel(job, s)}
              </span>
            ))}
          </div>
          <div className="progress">
            <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <div className="msg">{jobMessage(job)}</div>
        </div>
      )}

      <div className="transport">
        <button className="play" onClick={togglePlay} disabled={!engine || loadingAudio} aria-label="Play/Pause">
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="time">
          {fmtTime(time)} / {fmtTime(duration)}
        </span>
        {result && <span className="chip">♩ {result.tempo.toFixed(1)} BPM</span>}
        <button
          className={`chip btn ${loopOn ? 'active' : ''}`}
          disabled={!loop}
          title={t('tp.loop.title')}
          onClick={() => setLoopOn((v) => !v)}
        >
          {t('tp.loop')}
          {loop ? ` ${fmtTime(loop.start)}–${fmtTime(loop.end)}` : ''}
        </button>
        <label className="chip" title={t('tp.speed.title')}>
          {t('tp.speed')}{' '}
          <select
            value={speed}
            disabled={!engine || loadingAudio || speedLoading}
            onChange={(e) => void changeSpeed(Number(e.target.value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          {speedLoading && ' …'}
        </label>
        <label className="chip" title={t('tp.key.title')}>
          {t('tp.key')}{' '}
          <select value={keyChoice} onChange={(e) => setKeyChoice(e.target.value)} disabled={!result}>
            <option value="auto">
              {t('tp.key.auto')}
              {detectedKey ? `: ${keyName(detectedKey)}` : ''}
            </option>
            <option value="off">{t('tp.key.off')}</option>
            {ALL_KEYS.map((k) => (
              <option key={keyId(k)} value={keyId(k)}>
                {keyName(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="chip check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {t('tp.follow')}
        </label>
        <label className="chip check">
          <input type="checkbox" checked={showWave} onChange={(e) => setShowWave(e.target.checked)} /> {t('tp.wave')}
        </label>
        <button className="chip btn" disabled={!result} onClick={() => rollRef.current?.fitPitch()} title={t('tp.fit.title')}>
          {t('tp.fit')}
        </button>
        <button
          className={`chip btn ${editMode ? 'active' : ''}`}
          disabled={!result}
          onClick={() => setEditMode((v) => !v)}
          title={t('tp.edit.title')}
        >
          {t('tp.edit')}
        </button>
        <label className="chip master" title={t('tp.master')}>
          🔊
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={master}
            onChange={(e) => setMaster(Number(e.target.value))}
          />
          <span>{Math.round(master * 100)}%</span>
        </label>
        {loadingAudio && <span className="chip">{t('tp.loadingAudio')}</span>}
        <div className="spacer" />
        {result && (
          <>
            <span className="title" title={result.meta.title}>
              {result.meta.title}
            </span>
            <details className="export">
              <summary className="chip btn">{t('tp.export')}</summary>
              <div className="menu">
                <a href={api.fileUrl(result.job_id, 'midi/all.mid')} download="all.mid">
                  {t('ex.allMidi')}
                </a>
                <a href={api.fileUrl(result.job_id, 'midi/chords.mid')} download="chords.mid">
                  {t('ex.chordMidi')}
                </a>
                <button
                  onClick={() =>
                    download(
                      'leadsheet.txt',
                      leadSheet(chords, grid, nameKey, { title: result.meta.title, tempo: result.tempo }),
                    )
                  }
                >
                  {t('ex.leadSheet')}
                </button>
                {editable.map((tr) => (
                  <a key={tr.id} href={api.musicxmlUrl(result.job_id, tr.id)} download={`${tr.id}.musicxml`}>
                    {t('ex.musicxml', { track: trackLabel(tr.id) })}
                  </a>
                ))}
              </div>
            </details>
          </>
        )}
      </div>

      {editMode && result && (
        <div className="editbar">
          <span className="chip">
            {t('ed.target')}
            <select value={editTrack ?? ''} onChange={(e) => setEditTrack(e.target.value)}>
              {editable.map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {trackLabel(tr.id)}
                </option>
              ))}
            </select>
          </span>
          <span className="chip">
            {t('ed.grid')}
            <select value={snapDiv} onChange={(e) => setSnapDiv(Number(e.target.value))}>
              {SNAPS.map((div) => (
                <option key={div} value={div}>
                  {t(`ed.snap.${div}` as MsgKey)}
                </option>
              ))}
            </select>
          </span>
          <button className="chip btn" disabled={!snapDiv} onClick={quantize} title={t('ed.quantize.title')}>
            {t('ed.quantize')}
          </button>
          <button className="chip btn" disabled={!undoStack.current.length} onClick={() => undoRedo('undo')} title="Ctrl+Z">
            {t('ed.undo')}
          </button>
          <button className="chip btn" disabled={!redoStack.current.length} onClick={() => undoRedo('redo')} title="Ctrl+Shift+Z">
            {t('ed.redo')}
          </button>
          <span className={`chip save ${saveState}`}>{t(saveLabel[saveState])}</span>
          <span className="hint">{t('ed.hint')}</span>
        </div>
      )}

      {selected && (
        <div className="selbar">
          {pitchName(selected.note.pitch)} · {selected.note.start.toFixed(2)}s ~ {selected.note.end.toFixed(2)}s · vel{' '}
          {selected.note.velocity} · {trackLabel(selected.track)}
        </div>
      )}

      <main className="workspace">
        {result ? (
          <>
            <TrackPanel
              states={labeledStates}
              tracks={result.tracks}
              onChange={patchTrack}
              midiUrl={(p) => api.fileUrl(result.job_id, p)}
              editMode={editMode}
              editTrack={editTrack}
              onEditTrack={setEditTrack}
              busy={busy}
              onRetranscribe={(tr, p) => void retranscribe(tr, p)}
              chords={result.chords ?? null}
              onReanalyzeChords={(p) => void reanalyzeChords(p)}
            />
            <PianoRoll
              ref={rollRef}
              viewKey={result.job_id}
              engine={engine}
              tracks={result.tracks}
              states={labeledStates.filter((s) => s.id !== 'chords')}
              grid={grid}
              duration={duration}
              follow={follow}
              selected={selected?.note ?? null}
              onSelect={(note, track) => setSelected(note && track ? { note, track } : null)}
              scaleKey={scaleKey}
              nameKey={nameKey}
              loop={loop}
              loopOn={loopOn}
              onLoopChange={changeLoop}
              chords={chords}
              showChords={chordState?.showNotes ?? true}
              peaks={peaks}
              peaksRate={PEAKS_RATE}
              showWave={showWave}
              editMode={editMode}
              editTrack={editTrack}
              snapDiv={snapDiv}
              onEditNote={onEditNote}
            />
          </>
        ) : (
          <div className="empty">
            <p dangerouslySetInnerHTML={{ __html: t('app.empty.1') }} />
            <p className="sub">{t('app.empty.2')}</p>
            {jobs.some((j) => j.status === 'done') && (
              <button className="tbtn on" onClick={() => setHistoryOpen(true)}>
                {t('app.empty.open')}
              </button>
            )}
          </div>
        )}
      </main>

      <footer className="statusbar">{t('app.shortcuts')}</footer>

      {dragging && (
        <div className="drop-overlay">
          <div>🎵 {t('app.drop')}</div>
        </div>
      )}

      {historyOpen && (
        <HistoryPanel
          jobs={jobs}
          current={jobId}
          onOpen={(id) => {
            setJobId(id)
            setHistoryOpen(false)
          }}
          onDelete={(id) => void deleteJob(id)}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  )
}
