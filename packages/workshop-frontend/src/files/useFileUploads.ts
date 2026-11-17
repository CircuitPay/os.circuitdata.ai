import { useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { FileNameConflict, TenantFilesApi } from '@gadgets/workshop-shared/api'
import { trackedStream } from './uploadStream'

export type UploadItem = {
  id: number
  name: string
  size: number
  sentBytes: number
  state: 'uploading' | 'done' | 'failed'
  /** Why a failed upload failed, in the server's words. */
  error?: string
}

export type UploadEntry = { file: File; onConflict: FileNameConflict }

/**
 * Uploads files one after another and tracks each: progress while it runs, then done or failed with
 * the reason. A failure does not stop the rest of the batch. `onSettled` runs once the batch ends, so
 * the caller can reload its list.
 */
export const useFileUploads = (api: RpcStub<TenantFilesApi>, onSettled: () => void) => {
  const [items, setItems] = useState<UploadItem[]>([])
  const nextId = useRef(0)

  const update = (id: number, change: Partial<UploadItem>) =>
    setItems(current => current.map(item => (item.id === id ? { ...item, ...change } : item)))

  return {
    items,
    busy: items.some(item => item.state === 'uploading'),
    start: async (entries: UploadEntry[]) => {
      const queued = entries.map(({ file, onConflict }) => ({
        file, onConflict,
        item: { id: nextId.current++, name: file.name, size: file.size, sentBytes: 0, state: 'uploading' as const },
      }))
      setItems(current => [...current, ...queued.map(entry => entry.item)])
      for (const { file, onConflict, item } of queued) {
        try {
          await api.uploadFile(
            { name: file.name, size: file.size, contentType: file.type, onConflict },
            trackedStream(file, sentBytes => update(item.id, { sentBytes })))
          update(item.id, { state: 'done', sentBytes: file.size })
        } catch (error) {
          update(item.id, {
            state: 'failed',
            error: error instanceof Error ? error.message : 'The upload failed.',
          })
        }
      }
      onSettled()
    },
    dismiss: (id: number) => setItems(current => current.filter(item => item.id !== id)),
  }
}
