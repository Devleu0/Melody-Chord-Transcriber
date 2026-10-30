import type { ChordResult, Job, Note, Result, Separator, TrackData } from './types'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

const post = (url: string, body: unknown, method = 'POST') =>
  fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const api = {
  createJob: (url: string, separator: Separator) => post('/api/jobs', { url, separator }).then(json<Job>),
  listJobs: () => fetch('/api/jobs').then(json<Job[]>),
  getJob: (id: string) => fetch(`/api/jobs/${id}`).then(json<Job>),
  deleteJob: (id: string) => fetch(`/api/jobs/${id}`, { method: 'DELETE' }).then(json<{ ok: boolean }>),
  getResult: (id: string) => fetch(`/api/jobs/${id}/result`).then(json<Result>),
  saveNotes: (id: string, track: string, notes: Note[]) =>
    post(`/api/jobs/${id}/tracks/${track}/notes`, { notes }, 'PUT').then(json<{ ok: boolean }>),
  retranscribe: (id: string, track: string, params: Record<string, number>) =>
    post(`/api/jobs/${id}/tracks/${track}/retranscribe`, { params }).then(json<TrackData>),
  reanalyzeChords: (id: string, changePenalty: number) =>
    post(`/api/jobs/${id}/chords`, { change_penalty: changePenalty }).then(json<ChordResult>),
  fileUrl: (jobId: string, path: string) => `/files/${jobId}/${path}`,
  stretchUrl: (jobId: string, path: string, speed: number) =>
    `/api/jobs/${jobId}/audio?path=${encodeURIComponent(path)}&speed=${speed}`,
  musicxmlUrl: (jobId: string, track: string) => `/api/jobs/${jobId}/musicxml?track=${track}`,
}
