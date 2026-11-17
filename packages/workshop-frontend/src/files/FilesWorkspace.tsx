import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { Button, Input, Meter, useKumoToastManager } from '@cloudflare/kumo'
import { Files, UploadSimple } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { TenantFile, TenantFilesApi, TenantFilesUsage } from '@gadgets/workshop-shared/api'
import DeleteConfirmationDialog from '../components/DeleteConfirmationDialog'
import { EmptyState } from '../components/EmptyState'
import FileList from './FileList'
import NameConflictDialog, { type ConflictChoice } from './NameConflictDialog'
import UploadList from './UploadList'
import { formatBytes } from './formatBytes'
import { downloadFile, openFile } from './openFile'
import { useFileUploads, type UploadEntry } from './useFileUploads'

type FilesWorkspaceProps = {
  api: RpcStub<TenantFilesApi>
  files: TenantFile[]
  usage: TenantFilesUsage
  hasMore: boolean
  query: string
  onQueryChange: (query: string) => void
  /** Uploads or removals changed what the workspace holds. */
  onChanged: () => void
  onLoadMore: () => Promise<void>
}

const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

/** The workspace's files with everything a member does to them: add, find, open, save, remove. */
const FilesWorkspace = ({
  api, files, usage, hasMore, query, onQueryChange, onChanged, onLoadMore,
}: FilesWorkspaceProps) => {
  const toasts = useKumoToastManager()
  const uploads = useFileUploads(api, onChanged)
  const picker = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [clashing, setClashing] = useState<{ files: File[]; taken: string[] }>()
  const [removing, setRemoving] = useState<{ file: TenantFile; busy: boolean }>()

  const fail = (error: unknown, fallback: string) =>
    toasts.add({ title: messageOf(error, fallback), variant: 'error' })

  const choose = async (chosen: File[]) => {
    if (chosen.length === 0) return
    try {
      const taken = await api.findExisting(chosen.map(file => file.name))
      if (taken.length === 0) {
        void uploads.start(chosen.map(file => ({ file, onConflict: 'reject' })))
      } else {
        setClashing({ files: chosen, taken })
      }
    } catch (error) {
      fail(error, 'Could not check the file names.')
    }
  }

  const resolveClash = (choice: ConflictChoice) => {
    if (!clashing) return
    const { files: chosen, taken } = clashing
    setClashing(undefined)
    const entries = chosen.flatMap((file): UploadEntry[] => {
      if (!taken.includes(file.name.trim())) return [{ file, onConflict: 'reject' }]
      return choice === 'skip' ? [] : [{ file, onConflict: choice }]
    })
    if (entries.length > 0) void uploads.start(entries)
  }

  const handleChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.target.files ?? [])]
    event.target.value = ''
    void choose(chosen)
  }

  const handleDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    void choose([...event.dataTransfer.files])
  }

  const remove = async () => {
    if (!removing) return
    setRemoving({ ...removing, busy: true })
    try {
      await api.removeFile(removing.file.id)
      toasts.add({ title: `Removed ${removing.file.name}`, variant: 'success' })
    } catch (error) {
      fail(error, 'Could not remove the file.')
    } finally {
      setRemoving(undefined)
      // Whatever happened, the list may be out of date: someone else may have removed it already.
      onChanged()
    }
  }

  const searching = query.trim() !== ''

  return (
    <div
      className={`space-y-5 rounded-xl ${dragging ? 'outline-2 outline-dashed outline-kumo-brand' : ''}`}
      onDragOver={event => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-5">
        <Meter
          label="Storage used"
          customValue={`${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)}`}
          value={usage.usedBytes}
          max={usage.quotaBytes}
        />
        <p className="mb-0 mt-2 text-xs text-kumo-subtle">
          {usage.fileCount} {usage.fileCount === 1 ? 'file' : 'files'}. Each file can be up to {formatBytes(usage.maxFileBytes)}.
        </p>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full sm:w-72">
          <Input
            label="Search files"
            placeholder="Search by name"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
          />
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          aria-label="Choose files to upload"
          className="hidden"
          onChange={handleChosen}
        />
        <Button variant="primary" icon={UploadSimple} onClick={() => picker.current?.click()}>
          Upload files
        </Button>
      </div>

      {uploads.items.length > 0 && <UploadList items={uploads.items} onDismiss={uploads.dismiss} />}

      {files.length === 0 ? (
        searching
          ? <p className="py-8 text-center text-sm text-kumo-subtle">No files match &ldquo;{query.trim()}&rdquo;.</p>
          : (
            <EmptyState
              icon={Files}
              title="No files yet"
              description="Add files here to share them with everyone in this workspace. You can also drag them onto this page."
              actionLabel="Upload files"
              onAction={() => picker.current?.click()}
            />
          )
      ) : (
        <FileList
          files={files}
          onOpen={file => openFile(api, file).catch(error => fail(error, 'Could not open the file.'))}
          onDownload={file => downloadFile(api, file).catch(error => fail(error, 'Could not download the file.'))}
          onRemove={file => setRemoving({ file, busy: false })}
        />
      )}

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => onLoadMore().catch(error => fail(error, 'Could not load more files.'))}>
            Load more
          </Button>
        </div>
      )}

      {clashing && (
        <NameConflictDialog
          names={clashing.taken}
          onChoose={resolveClash}
          onCancel={() => setClashing(undefined)}
        />
      )}

      <DeleteConfirmationDialog
        open={removing !== undefined}
        title="Remove this file?"
        description={removing && `${removing.file.name} will be removed for everyone in this workspace. This cannot be undone.`}
        confirmLabel="Remove"
        confirmingLabel="Removing..."
        isDeleting={removing?.busy}
        onOpenChange={open => { if (!open) setRemoving(undefined) }}
        onConfirm={remove}
      />
    </div>
  )
}

export default FilesWorkspace
