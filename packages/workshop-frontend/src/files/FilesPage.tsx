import { useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { useDocumentTitle } from '../useDocumentTitle'
import FilesWorkspace from './FilesWorkspace'
import { useDebouncedValue } from './useDebouncedValue'
import { useTenantFiles } from './useTenantFiles'

/**
 * The Files page: the active workspace's files, which are shared by everyone in it. Switching
 * workspace reconnects, which reloads this page's data from the new workspace.
 */
const FilesPage = () => {
  useDocumentTitle('Files')
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search.trim(), 250)
  const { view, refresh, loadMore } = useTenantFiles(query)

  return (
    <div className="mx-auto w-full max-w-[960px] space-y-6 px-4 py-8 sm:px-8">
      <div>
        <h1 className="text-2xl font-semibold text-kumo-default">Files</h1>
        <p className="mt-1 text-sm text-kumo-subtle">
          Files shared with everyone in this workspace. Whoever added a file, or an organization
          administrator, can remove it.
        </p>
      </div>

      {view.status === 'loading' && <p role="status" className="text-sm text-kumo-subtle">Loading files...</p>}
      {view.status === 'unavailable' && (
        <p role="status" className="rounded-xl border border-kumo-line bg-kumo-elevated p-6 text-sm text-kumo-default">
          File storage is not set up for this deployment, so files are unavailable. Ask your
          administrator to configure it.
        </p>
      )}
      {view.status === 'failed' && (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-kumo-danger">Something went wrong loading files.</p>
          <Button variant="secondary" onClick={refresh}>Try again</Button>
        </div>
      )}
      {view.status === 'ready' && (
        <FilesWorkspace
          api={view.api}
          files={view.files}
          usage={view.usage}
          hasMore={view.hasMore}
          query={search}
          onQueryChange={setSearch}
          onChanged={refresh}
          onLoadMore={loadMore}
        />
      )}
    </div>
  )
}

export default FilesPage
