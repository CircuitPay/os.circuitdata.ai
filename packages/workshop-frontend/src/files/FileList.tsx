import { Table } from '@cloudflare/kumo'
import { DownloadSimple, Eye, Trash } from '@phosphor-icons/react'
import type { TenantFile } from '@gadgets/workshop-shared/api'
import { WorkshopIconButton } from '../components/WorkshopControls'
import { formatBytes } from './formatBytes'

type FileListProps = {
  files: TenantFile[]
  onOpen: (file: TenantFile) => void
  onDownload: (file: TenantFile) => void
  onRemove: (file: TenantFile) => void
}

const uploaderLabel = (file: TenantFile) =>
  file.uploader.isMe ? 'You' : file.uploader.name ?? 'Former member'

/** The tenant's files, one row each, with the actions the caller may take on it. */
const FileList = ({ files, onOpen, onDownload, onRemove }: FileListProps) => (
  <Table>
    <Table.Header>
      <Table.Row>
        <Table.Head>Name</Table.Head>
        <Table.Head>Size</Table.Head>
        <Table.Head>Added by</Table.Head>
        <Table.Head>Added</Table.Head>
        <Table.Head><span className="sr-only">Actions</span></Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {files.map(file => (
        <Table.Row key={file.id}>
          <Table.Cell className="max-w-[320px] truncate font-medium text-kumo-default" title={file.name}>
            {file.name}
          </Table.Cell>
          <Table.Cell>{formatBytes(file.size)}</Table.Cell>
          <Table.Cell>{uploaderLabel(file)}</Table.Cell>
          <Table.Cell>{file.uploadedAt.toLocaleString()}</Table.Cell>
          <Table.Cell>
            <div className="flex justify-end gap-1">
              {file.previewable && (
                <WorkshopIconButton aria-label={`Open ${file.name}`} onClick={() => onOpen(file)}>
                  <Eye size={16} />
                </WorkshopIconButton>
              )}
              <WorkshopIconButton aria-label={`Download ${file.name}`} onClick={() => onDownload(file)}>
                <DownloadSimple size={16} />
              </WorkshopIconButton>
              {file.mayRemove && (
                <WorkshopIconButton danger aria-label={`Remove ${file.name}`} onClick={() => onRemove(file)}>
                  <Trash size={16} />
                </WorkshopIconButton>
              )}
            </div>
          </Table.Cell>
        </Table.Row>
      ))}
    </Table.Body>
  </Table>
)

export default FileList
