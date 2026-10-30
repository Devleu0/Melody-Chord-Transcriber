import { api } from '../api'
import type { Job } from '../types'

const STATUS_LABEL: Record<Job['status'], string> = {
  queued: '대기',
  downloading: '다운로드',
  separating: '분리',
  transcribing: '채보',
  chords: '코드 분석',
  finalizing: '마무리',
  done: '완료',
  error: '오류',
}

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
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <b>작업 기록</b>
          <button className="tbtn" onClick={onClose}>
            닫기
          </button>
        </div>
        {jobs.length === 0 && <div className="drawer-empty">아직 작업이 없습니다.</div>}
        {jobs.map((j) => {
          const done = j.status === 'done'
          return (
            <div key={j.id} className={`job ${j.id === current ? 'current' : ''}`}>
              {j.meta?.thumbnail ? <img src={j.meta.thumbnail} alt="" loading="lazy" /> : <div className="thumb" />}
              <div className="job-body">
                <div className="job-title" title={j.meta?.title ?? j.url}>
                  {j.meta?.title ?? j.url}
                </div>
                <div className="job-sub">
                  <span className={`status ${j.status}`}>{STATUS_LABEL[j.status]}</span>
                  <span>{j.separator === 'roformer' ? 'RoFormer' : 'Demucs'}</span>
                  <span>{new Date(j.created_at * 1000).toLocaleString()}</span>
                </div>
                {done && (
                  <div className="job-files">
                    <a href={api.fileUrl(j.id, 'source.wav')} download>
                      원곡
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
                  열기
                </button>
                <button
                  className="tbtn on-red"
                  disabled={!done && j.status !== 'error'}
                  onClick={() => {
                    if (window.confirm(`"${j.meta?.title ?? j.url}" 작업과 모든 파일을 삭제할까요?`)) onDelete(j.id)
                  }}
                >
                  삭제
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
