import { useState } from 'react'
import { useI18n, type MsgKey } from '../i18n'
import type { ChordResult, TrackData, TrackState } from '../types'

interface ParamDef {
  key: string
  min: number
  max: number
  step: number
}

const VOCAL_PARAMS: ParamDef[] = [
  { key: 'conf_threshold', min: 0.05, max: 0.9, step: 0.05 },
  { key: 'min_note_sec', min: 0.03, max: 0.4, step: 0.01 },
  { key: 'silence_db', min: -70, max: -15, step: 1 },
]
const POLY_PARAMS: ParamDef[] = [
  { key: 'onset_threshold', min: 0.1, max: 0.9, step: 0.05 },
  { key: 'frame_threshold', min: 0.1, max: 0.9, step: 0.05 },
  { key: 'minimum_note_length', min: 30, max: 300, step: 10 },
]
const CHORD_PARAMS: ParamDef[] = [{ key: 'change_penalty', min: 0.5, max: 10, step: 0.5 }]
const VOCAL_DEFAULT = { conf_threshold: 0.3, min_note_sec: 0.08, silence_db: -40 }
const POLY_DEFAULT = { onset_threshold: 0.5, frame_threshold: 0.3, minimum_note_length: 80 }

interface Props {
  states: TrackState[]
  tracks: TrackData[]
  onChange: (id: string, patch: Partial<TrackState>) => void
  midiUrl: (path: string) => string
  editMode: boolean
  editTrack: string | null
  onEditTrack: (id: string) => void
  busy: string | null // track id currently being re-transcribed / re-analyzed
  onRetranscribe: (track: string, params: Record<string, number>) => void
  chords: ChordResult | null
  onReanalyzeChords: (penalty: number) => void
}

function ParamPanel({
  defs,
  initial,
  defaults,
  busy,
  onRun,
  runLabel,
}: {
  defs: ParamDef[]
  initial: Record<string, number>
  defaults: Record<string, number>
  busy: boolean
  onRun: (p: Record<string, number>) => void
  runLabel: string
}) {
  const { t } = useI18n()
  const [vals, setVals] = useState<Record<string, number>>({ ...defaults, ...initial })
  return (
    <div className="params">
      {defs.map((d) => (
        <label key={d.key} className="param">
          <span>
            {t(`tr.p.${d.key}` as MsgKey)} <b>{vals[d.key]}</b>
          </span>
          <input
            type="range"
            min={d.min}
            max={d.max}
            step={d.step}
            value={vals[d.key]}
            onChange={(e) => setVals((v) => ({ ...v, [d.key]: Number(e.target.value) }))}
          />
        </label>
      ))}
      <div className="param-btns">
        <button className="tbtn" onClick={() => setVals({ ...defaults })} disabled={busy}>
          {t('tr.defaults')}
        </button>
        <button className="tbtn on" onClick={() => onRun(vals)} disabled={busy}>
          {busy ? t('tr.busy') : runLabel}
        </button>
      </div>
    </div>
  )
}

export function TrackPanel(p: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState<string | null>(null)
  return (
    <aside className="tracks">
      <div className="tracks-head">{t('tr.head')}</div>
      {p.states.map((s) => {
        const data = p.tracks.find((tr) => tr.id === s.id)
        const isChord = s.id === 'chords'
        const isTarget = p.editMode && p.editTrack === s.id
        return (
          <div key={s.id} className={`track ${isTarget ? 'target' : ''}`} style={{ borderLeftColor: s.color }}>
            <div className="track-top">
              <span className="track-name">
                {s.label}
                {data?.edited && <span className="badge">{t('tr.edited')}</span>}
              </span>
              {s.hasNotes && <span className="track-count">{t('tr.notes', { n: data?.notes?.length ?? 0 })}</span>}
              {isChord && p.chords && (
                <span className="track-count">
                  {t('tr.chords', { n: p.chords.chords.length, engine: t(`tr.engine.${p.chords.engine}` as MsgKey) })}
                </span>
              )}
            </div>
            <div className="track-btns">
              {!isChord && (
                <>
                  <button
                    className={`tbtn ${!s.audioOn ? 'on-red' : ''}`}
                    title={t('tr.mute')}
                    onClick={() => p.onChange(s.id, { audioOn: !s.audioOn })}
                  >
                    M
                  </button>
                  <button
                    className={`tbtn ${s.solo ? 'on-yellow' : ''}`}
                    title={t('tr.solo')}
                    onClick={() => p.onChange(s.id, { solo: !s.solo })}
                  >
                    S
                  </button>
                </>
              )}
              {(s.hasNotes || isChord) && (
                <>
                  <button
                    className={`tbtn wide ${s.showNotes ? 'on' : ''}`}
                    title={isChord ? t('tr.lane.title') : t('tr.showNotes.title')}
                    onClick={() => p.onChange(s.id, { showNotes: !s.showNotes })}
                  >
                    {isChord ? t('tr.lane') : t('tr.showNotes')}
                  </button>
                  <button
                    className={`tbtn wide ${s.synthOn ? 'on' : ''}`}
                    title={isChord ? t('tr.synth.chordTitle') : t('tr.synth.title')}
                    onClick={() => p.onChange(s.id, { synthOn: !s.synthOn })}
                  >
                    {t('tr.synth')}
                  </button>
                </>
              )}
              {s.hasNotes && p.editMode && (
                <button
                  className={`tbtn ${isTarget ? 'on-yellow' : ''}`}
                  title={t('tr.target')}
                  onClick={() => p.onEditTrack(s.id)}
                >
                  ✎
                </button>
              )}
              {(s.hasNotes || (isChord && p.chords)) && (
                <button
                  className={`tbtn ${open === s.id ? 'on' : ''}`}
                  title={isChord ? t('tr.settings.chord') : t('tr.settings')}
                  onClick={() => setOpen(open === s.id ? null : s.id)}
                >
                  ⚙
                </button>
              )}
            </div>
            <div className="track-bottom">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={s.volume}
                aria-label={`${s.label} volume`}
                onChange={(e) => p.onChange(s.id, { volume: Number(e.target.value) })}
              />
              {data?.midi && (
                <a className="midi-link" href={p.midiUrl(data.midi)} download={`${s.id}.mid`}>
                  .mid
                </a>
              )}
            </div>
            {open === s.id && s.hasNotes && (
              <ParamPanel
                defs={s.id === 'vocals' ? VOCAL_PARAMS : POLY_PARAMS}
                defaults={s.id === 'vocals' ? VOCAL_DEFAULT : POLY_DEFAULT}
                initial={data?.params ?? {}}
                busy={p.busy === s.id}
                runLabel={t('tr.retranscribe')}
                onRun={(params) => p.onRetranscribe(s.id, params)}
              />
            )}
            {open === s.id && isChord && p.chords && (
              <ParamPanel
                defs={CHORD_PARAMS}
                defaults={{ change_penalty: 3 }}
                initial={p.chords.change_penalty != null ? { change_penalty: p.chords.change_penalty } : {}}
                busy={p.busy === 'chords'}
                runLabel={t('tr.reanalyze')}
                onRun={(params) => p.onReanalyzeChords(params.change_penalty)}
              />
            )}
            {open === s.id && data?.edited && <div className="param-warn">{t('tr.warnEdited')}</div>}
          </div>
        )
      })}
    </aside>
  )
}
