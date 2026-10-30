import { api } from '../api'
import { useI18n, type MsgKey } from '../i18n'
import type { Job } from '../types'

const STEMS: Record<Job['separator'], string[]> = {
  roformer: ['vocals', 'accompaniment'],
  demucs: ['vocals', 'bass', 'other', 'drums', 'accompaniment'],
}

interface Props {
  jobs: Job[]
  current: string | null
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}

export function HistoryPanel({ jobs, current, onOpen, onDelete, onClose }: Props) {
  const { t, lang } = useI18n()
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" role="dialog" aria-label={t('hist.title')} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <b>{t('hist.title')}</b>
          <button className="tbtn" onClick={onClose}>
            {t('hist.close')}
          </button>
        </div>
        {jobs.length === 0 && <div className="drawer-empty">{t('hist.empty')}</div>}
        {jobs.map((j) => {
          const done = j.status === 'done'
          const title = j.meta?.title ?? j.url
          return (
            <div key={j.id} className={`job ${j.id === current ? 'current' : ''}`}>
              {j.meta?.thumbnail ? (
                <img src={j.meta.thumbnail} alt="" loading="lazy" />
              ) : (
                <div className="thumb">{j.source === 'file' ? '🎵' : ''}</div>
              )}
              <div className="job-body">
                <div className="job-title" title={title}>
                  {title}
                </div>
                <div className="job-sub">
                  <span className={`status ${j.status}`}>
                    {j.status === 'downloading' && j.source === 'file' ? t('stage.importing') : t(`stage.${j.status}` as MsgKey)}
                  </span>
                  <span>{j.separator === 'roformer' ? 'RoFormer' : 'Demucs'}</span>
                  {j.source === 'file' && <span>📎 {j.url}</span>}
                  <span>{new Date(j.created_at * 1000).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US')}</span>
                </div>
                {done && (
                  <div className="job-files">
                    <a href={api.fileUrl(j.id, 'source.wav')} download>
                      {t('hist.source')}
                    </a>
                    {STEMS[j.separator].map((s) => (
                      <a key={s} href={api.fileUrl(j.id, `stems/${s}.wav`)} download={`${s}.wav`}>
                        {s}
                      </a>
                    ))}
                  </div>
                )}
                {j.status === 'error' && <div className="job-err">{j.error}</div>}
              </div>
              <div className="job-actions">
                <button className="tbtn on" disabled={!done} onClick={() => onOpen(j.id)}>
                  {t('hist.open')}
                </button>
                <button
                  className="tbtn on-red"
                  disabled={!done && j.status !== 'error'}
                  onClick={() => {
                    if (window.confirm(t('hist.confirm', { title }))) onDelete(j.id)
                  }}
                >
                  {t('hist.delete')}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
