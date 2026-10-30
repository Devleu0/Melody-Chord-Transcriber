import type { Job, Result, Separator } from './types'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export const api = {
  createJob: (url: string, separator: Separator) =>
    fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, separator }),
    }).then(json<Job>),
  listJobs: () => fetch('/api/jobs').then(json<Job[]>),
  getJob: (id: string) => fetch(`/api/jobs/${id}`).then(json<Job>),
  getResult: (id: string) => fetch(`/api/jobs/${id}/result`).then(json<Result>),
  fileUrl: (jobId: string, path: string) => `/files/${jobId}/${path}`,
}
