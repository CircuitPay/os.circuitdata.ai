import { Meter } from '@cloudflare/kumo'
import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react'
import { WorkshopIconButton } from '../components/WorkshopControls'
import { formatBytes } from './formatBytes'
import type { UploadItem } from './useFileUploads'

type UploadListProps = {
  items: UploadItem[]
  onDismiss: (id: number) => void
}

/** Progress and outcome of this session's uploads. Announced politely as they change. */
const UploadList = ({ items, onDismiss }: UploadListProps) => (
  <ul aria-label="Uploads" aria-live="polite" className="m-0 list-none space-y-2 p-0">
    {items.map(item => (
      <li key={item.id} className="rounded-lg border border-kumo-line bg-kumo-elevated px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {item.state === 'uploading' && (
              <Meter
                label={`Uploading ${item.name}`}
                customValue={`${formatBytes(item.sentBytes)} of ${formatBytes(item.size)}`}
                value={item.sentBytes}
                max={Math.max(item.size, 1)}
              />
            )}
            {item.state === 'done' && (
              <p className="m-0 flex items-center gap-2 text-sm text-kumo-default">
                <CheckCircle size={16} className="shrink-0 text-kumo-success" aria-hidden />
                <span className="truncate">{item.name} uploaded</span>
              </p>
            )}
            {item.state === 'failed' && (
              <p className="m-0 flex items-start gap-2 text-sm text-kumo-danger">
                <WarningCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
                <span>{item.name} was not uploaded: {item.error}</span>
              </p>
            )}
          </div>
          {item.state !== 'uploading' && (
            <WorkshopIconButton aria-label={`Dismiss ${item.name}`} onClick={() => onDismiss(item.id)}>
              <X size={14} />
            </WorkshopIconButton>
          )}
        </div>
      </li>
    ))}
  </ul>
)

export default UploadList
