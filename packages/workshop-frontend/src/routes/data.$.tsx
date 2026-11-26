import { createFileRoute } from '@tanstack/react-router'
import { DataPage } from '../features/data/DataPage'
import { useDocumentTitle } from '../useDocumentTitle'

/**
 * The organization's Data area. Anything after /data is the Data app's own path, the splat, which
 * may be empty; changing it keeps this match (and the app's iframe) mounted.
 */
export const Route = createFileRoute('/data/$')({
  component: DataRoute,
})

function DataRoute() {
  const { _splat } = Route.useParams()
  useDocumentTitle('Data')
  // A trailing slash names the same place; keep the app from seeing an empty last segment.
  return <DataPage path={`/${(_splat ?? '').replace(/\/+$/, '')}`} />
}
