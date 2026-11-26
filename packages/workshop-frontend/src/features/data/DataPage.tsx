import { Empty, Loader } from '@cloudflare/kumo'
import { Database } from '@phosphor-icons/react'
import GatekeeperAppPage from '../../GatekeeperAppPage'
import { DATA_VENDOR_ID, useDataArea } from './dataArea'
import { DataIntro } from './DataIntro'

const DataNotice = ({ title }: { title: string }) => (
  <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-16">
    <Empty icon={<Database size={40} className="text-kumo-subtle" aria-hidden />} title={title} />
  </div>
)

/**
 * The organization's Data area. Before Data is turned on the Workshop explains it itself, because the
 * kernel serves the retail app only to an organization that has enabled it; afterwards this hosts
 * that app at `path`.
 */
export const DataPage = ({ path }: { path: string }) => {
  const area = useDataArea()
  switch (area.state) {
    case 'loading':
      return (
        <div className="flex h-full items-center justify-center py-16">
          <Loader size="lg" />
        </div>
      )
    case 'absent':
      return <DataNotice title="Data is not available on this deployment." />
    case 'unavailable':
      return <DataNotice title="Data is turned off on this deployment." />
    case 'off':
      return <DataIntro area={area} />
    case 'on':
      return <GatekeeperAppPage appId={DATA_VENDOR_ID} path={path} />
  }
}
