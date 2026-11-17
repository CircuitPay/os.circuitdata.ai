import type { RpcStub } from 'capnweb'
import type { TenantFile, TenantFilesApi } from '@gadgets/workshop-shared/api'
import { triggerBlobDownload } from '../fileTransfers'

/** Saves the file to the user's device under its own name. */
export const downloadFile = async (api: RpcStub<TenantFilesApi>, file: TenantFile): Promise<void> => {
  const { name, contentType, stream } = await api.downloadFile(file.id)
  triggerBlobDownload(await new Response(stream, { headers: { 'Content-Type': contentType } }).blob(), name)
}

/**
 * Shows a previewable file (an image or a PDF) in a new tab. Only those types reach here: the
 * server delivers everything else as opaque bytes, so a blob made from it can never render as a page
 * in this origin. The tab is opened before the bytes arrive, because a browser allows that only
 * inside the click; if it is blocked, the file downloads instead.
 */
export const openFile = async (api: RpcStub<TenantFilesApi>, file: TenantFile): Promise<void> => {
  const tab = window.open('', '_blank')
  try {
    const { name, contentType, stream } = await api.downloadFile(file.id)
    const blob = await new Response(stream, { headers: { 'Content-Type': contentType } }).blob()
    if (!tab) return triggerBlobDownload(blob, name)
    const url = URL.createObjectURL(blob)
    tab.location.href = url
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (error) {
    tab?.close()
    throw error
  }
}
