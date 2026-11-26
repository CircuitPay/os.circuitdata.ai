import { useState } from 'react'
import { Banner, Button, Empty, Text } from '@cloudflare/kumo'
import { Database } from '@phosphor-icons/react'
import type { DataArea } from './dataArea'

/**
 * What Data is for, shown while the organization has not turned it on. An administrator turns it on
 * here; the kernel re-checks their role, so a refusal arrives as an error and is shown as such.
 */
export const DataIntro = ({ area }: { area: Extract<DataArea, { state: 'off' }> }) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleTurnOn = async () => {
    setBusy(true)
    setError(null)
    try {
      await area.enable()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-16">
      <Empty
        size="lg"
        icon={<Database size={40} className="text-kumo-subtle" aria-hidden />}
        title="Data"
        description="Upload sales exports from your point of sale, or connect Square or Stripe. Then browse your orders, products and customers here, and use them in Dashboards, Reports and chats."
        contents={
          <div className="flex w-full flex-col items-center gap-4">
            {error && (
              <Banner variant="error" title="Data could not be turned on" description={error} className="w-full" />
            )}
            {area.mayManage ? (
              <Button variant="primary" loading={busy} onClick={() => { void handleTurnOn() }}>
                Turn on Data
              </Button>
            ) : (
              <Text variant="secondary">An administrator of your organization needs to turn Data on.</Text>
            )}
          </div>
        }
      />
    </div>
  )
}
