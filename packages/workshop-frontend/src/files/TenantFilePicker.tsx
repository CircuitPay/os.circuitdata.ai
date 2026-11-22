import { useState } from 'react'
import { Button, Checkbox, Dialog, Input, Radio } from '@cloudflare/kumo'
import type { TenantFile } from '@gadgets/workshop-shared/api'
import TenantFileUpload from './TenantFileUpload'
import { formatBytes } from './formatBytes'
import { acceptsFile, MAX_PICKED_FILES, type TenantFilePickRequest } from './tenantFilePick'
import { useDebouncedValue } from './useDebouncedValue'
import { useTenantFiles } from './useTenantFiles'

type TenantFilePickerProps = TenantFilePickRequest & {
  /** The member confirmed these files (at least one). */
  onConfirm: (files: TenantFile[]) => void
  /** Closed without choosing. */
  onCancel: () => void
}

const fileDetails = (file: TenantFile) => `${formatBytes(file.size)}, added ${file.uploadedAt.toLocaleDateString()}`

/**
 * Lets the member choose files from the workspace's Files for a gatekeeper app, or upload new ones
 * into Files first. Only the member's choice leaves this dialog; the files capability stays here.
 */
const TenantFilePicker = ({ accept, multiple, onConfirm, onCancel }: TenantFilePickerProps) => {
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search.trim(), 250)
  const { view, refresh, loadMore } = useTenantFiles(query)
  const [selected, setSelected] = useState<TenantFile[]>([])
  const [loadFailed, setLoadFailed] = useState(false)
  const limit = multiple ? MAX_PICKED_FILES : 1
  const selectedIds = selected.map(file => file.id)
  const full = selected.length >= limit
  const files = view.status === 'ready' ? view.files : []

  const handleUploaded = (uploaded: TenantFile[]) => {
    refresh()
    const usable = uploaded.filter(file => acceptsFile(accept, file))
    if (usable.length === 0) return
    setSelected(current => multiple
      ? [...current, ...usable.filter(file => !current.some(held => held.id === file.id))].slice(0, limit)
      : usable.slice(-1))
  }

  const handleCheckedIds = (ids: string[]) => {
    // A chosen file may have scrolled out of the listing (another search), so look in both.
    const known = new Map([...selected, ...files].map(file => [file.id, file]))
    setSelected(ids.flatMap(id => known.get(id) ?? []).slice(0, limit))
  }

  const handleLoadMore = () => {
    setLoadFailed(false)
    loadMore().catch(() => setLoadFailed(true))
  }

  const searching = query !== ''
  const typesNote = accept.length > 0 ? ` Only ${accept.join(', ')} files can be chosen.` : ''

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onCancel() }}>
      {/* Above the gatekeeper app's iframe, which may be a full-viewport overlay when this opens. */}
      <Dialog className="!z-[2147483001] flex max-h-[85vh] flex-col gap-4 bg-kumo-base p-6" size="xl">
        <div>
          <Dialog.Title className="text-lg font-semibold text-kumo-default">
            {multiple ? 'Choose files' : 'Choose a file'}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
            From this workspace&apos;s Files.
            {multiple ? ` You can choose up to ${MAX_PICKED_FILES}.` : ''}
            {typesNote} New uploads are added to Files.
          </Dialog.Description>
        </div>

        <Input
          label="Search files"
          placeholder="Search by name"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {view.status === 'loading' && <p role="status" className="m-0 text-sm text-kumo-subtle">Loading files...</p>}
          {view.status === 'unavailable' && (
            <p role="status" className="m-0 text-sm text-kumo-default">
              File storage is not set up for this deployment, so files are unavailable.
            </p>
          )}
          {view.status === 'failed' && (
            <div role="alert" className="space-y-2">
              <p className="m-0 text-sm text-kumo-danger">Something went wrong loading files.</p>
              <Button variant="secondary" onClick={refresh}>Try again</Button>
            </div>
          )}
          {view.status === 'ready' && (
            <>
              <TenantFileUpload api={view.api} accept={accept} multiple={multiple} onUploaded={handleUploaded} />
              {files.length === 0 && (
                <p className="m-0 py-4 text-center text-sm text-kumo-subtle">
                  {searching ? <>No files match &ldquo;{query}&rdquo;.</> : 'There are no files yet.'}
                </p>
              )}
              {files.length > 0 && multiple && (
                <Checkbox.Group legend="Files" value={selectedIds} onValueChange={handleCheckedIds}>
                  {files.map(file => (
                    <Checkbox.Item
                      key={file.id}
                      value={file.id}
                      label={`${file.name} (${fileDetails(file)})`}
                      disabled={!acceptsFile(accept, file) || (full && !selectedIds.includes(file.id))}
                    />
                  ))}
                </Checkbox.Group>
              )}
              {files.length > 0 && !multiple && (
                <Radio.Group legend="Files" value={selectedIds[0] ?? ''} onValueChange={id => handleCheckedIds([id])}>
                  {files.map(file => (
                    <Radio.Item
                      key={file.id}
                      value={file.id}
                      label={file.name}
                      description={fileDetails(file)}
                      disabled={!acceptsFile(accept, file)}
                    />
                  ))}
                </Radio.Group>
              )}
              {view.hasMore && (
                <div className="flex justify-center">
                  <Button variant="secondary" onClick={handleLoadMore}>Load more</Button>
                </div>
              )}
              {loadFailed && <p role="alert" className="m-0 text-sm text-kumo-danger">Could not load more files.</p>}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p aria-live="polite" className="m-0 text-sm text-kumo-subtle">
            {multiple ? `${selected.length} of ${MAX_PICKED_FILES} chosen` : selected[0] ? `${selected[0].name} chosen` : 'Nothing chosen'}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" disabled={selected.length === 0} onClick={() => onConfirm(selected)}>
              {multiple ? 'Use files' : 'Use file'}
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

export default TenantFilePicker
