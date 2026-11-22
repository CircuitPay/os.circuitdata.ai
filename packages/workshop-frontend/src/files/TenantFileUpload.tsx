import { useRef, useState, type ChangeEvent } from 'react'
import { Button } from '@cloudflare/kumo'
import { UploadSimple } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { TenantFile, TenantFilesApi } from '@gadgets/workshop-shared/api'
import UploadList from './UploadList'
import { acceptsFile } from './tenantFilePick'
import { useFileUploads } from './useFileUploads'

type TenantFileUploadProps = {
  api: RpcStub<TenantFilesApi>
  /** Lower-case extensions and MIME types a file must match; empty accepts any. */
  accept: string[]
  multiple: boolean
  /** The batch ended; `files` are the ones now stored in Files. */
  onUploaded: (files: TenantFile[]) => void
}

/**
 * Adds files from the member's device to Files, so they count against the Files quota like any other
 * upload. A name that is taken keeps both files rather than replacing one from inside a picker.
 */
const TenantFileUpload = ({ api, accept, multiple, onUploaded }: TenantFileUploadProps) => {
  const uploads = useFileUploads(api, onUploaded)
  const input = useRef<HTMLInputElement>(null)
  const [refused, setRefused] = useState<string[]>([])

  const handleChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.target.files ?? [])]
    event.target.value = ''
    const accepted = chosen.filter(file => acceptsFile(accept, { name: file.name, contentType: file.type }))
    setRefused(chosen.filter(file => !accepted.includes(file)).map(file => file.name))
    if (accepted.length > 0) void uploads.start(accepted.map(file => ({ file, onConflict: 'keep-both' })))
  }

  return (
    <div className="space-y-3">
      <input
        ref={input}
        type="file"
        multiple={multiple}
        accept={accept.length > 0 ? accept.join(',') : undefined}
        aria-label={multiple ? 'Choose files to upload' : 'Choose a file to upload'}
        className="hidden"
        onChange={handleChosen}
      />
      <Button variant="secondary" icon={UploadSimple} onClick={() => input.current?.click()}>
        {multiple ? 'Upload files' : 'Upload a file'}
      </Button>
      {refused.length > 0 && (
        <p role="alert" className="m-0 text-sm text-kumo-danger">
          Not uploaded, because only {accept.join(', ')} files can be used here: {refused.join(', ')}
        </p>
      )}
      {uploads.items.length > 0 && <UploadList items={uploads.items} onDismiss={uploads.dismiss} />}
    </div>
  )
}

export default TenantFileUpload
