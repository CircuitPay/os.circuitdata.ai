import { Dialog } from '@cloudflare/kumo'
import { WorkshopButton } from '../components/WorkshopControls'

export type ConflictChoice = 'replace' | 'keep-both' | 'skip'

type NameConflictDialogProps = {
  /** The names of the chosen files that the workspace already has. */
  names: string[]
  onChoose: (choice: ConflictChoice) => void
  /** Closed without choosing: nothing is uploaded. */
  onCancel: () => void
}

/** Asks what to do with files whose names are taken. One answer applies to all of them. */
const NameConflictDialog = ({ names, onChoose, onCancel }: NameConflictDialogProps) => (
  <Dialog.Root open onOpenChange={open => { if (!open) onCancel() }}>
    <Dialog className="!z-[1000] bg-kumo-base p-6" size="lg">
      <Dialog.Title className="text-lg font-semibold text-kumo-default">
        {names.length === 1 ? 'A file with this name already exists' : 'Files with these names already exist'}
      </Dialog.Title>
      <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
        Replacing deletes the existing file. Keeping both numbers the new one, like &ldquo;name (2)&rdquo;.
        Files that do not clash are uploaded either way.
      </Dialog.Description>
      <ul className="my-4 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-kumo-default">
        {names.map(name => <li key={name} className="break-all">{name}</li>)}
      </ul>
      <div className="flex flex-wrap justify-end gap-2">
        <WorkshopButton onClick={() => onChoose('skip')}>Skip {names.length === 1 ? 'it' : 'these'}</WorkshopButton>
        <WorkshopButton onClick={() => onChoose('keep-both')}>Keep both</WorkshopButton>
        <WorkshopButton tone="primary" onClick={() => onChoose('replace')}>Replace</WorkshopButton>
      </div>
    </Dialog>
  </Dialog.Root>
)

export default NameConflictDialog
