import { useEffect, useState } from 'react'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { TenantGatekeeperInfo, TenantGatekeepersApi } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { SectionEyebrow } from '../../components/SectionEyebrow'
import { logRpcFailure } from '../../rpcErrors'
import { refreshGatekeeperApps } from '../../useGatekeeperApps'
import { refreshDataArea } from '../data/dataArea'

// The capability is wrapped, because useState would call a bare stub (every stub is callable).
type Capability = { api: RpcStub<TenantGatekeepersApi> }

const describeState = (gatekeeper: TenantGatekeeperInfo) => {
  if (gatekeeper.mode === 'disabled') return 'Unavailable — disabled by the operator'
  if (gatekeeper.enabled) return 'Enabled for your organization'
  return gatekeeper.mayManage ? 'Not enabled for your organization' : 'Not enabled — ask an administrator'
}

/**
 * Tenant-scoped gatekeepers, which an organization administrator turns on once for every member.
 * Renders nothing on deployments without Clerk or when no such gatekeeper is bound.
 */
export const TenantGatekeepersSection = () => {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [capability, setCapability] = useState<Capability>()
  const [gatekeepers, setGatekeepers] = useState<TenantGatekeeperInfo[]>([])
  const [busyVendorId, setBusyVendorId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let stub: RpcStub<TenantGatekeepersApi> | null = null
    setCapability(undefined)
    setGatekeepers([])
    authenticatedApi.getTenantGatekeepersApi()
      .then(async (api) => {
        if (cancelled) {
          api?.[Symbol.dispose]()
          return
        }
        stub = api
        if (!api) return
        setCapability({ api })
        const list = await api.list()
        if (!cancelled) setGatekeepers(list)
      })
      .catch((err) => {
        if (!cancelled) logRpcFailure('Failed to load organization gatekeepers:', err)
      })
    return () => {
      cancelled = true
      stub?.[Symbol.dispose]()
    }
  }, [authenticatedApi])

  if (!capability || gatekeepers.length === 0) return null

  const handleToggle = async ({ vendorId, enabled }: TenantGatekeeperInfo) => {
    setBusyVendorId(vendorId)
    try {
      if (enabled) await capability.api.disable(vendorId)
      else await capability.api.enable(vendorId)
      setGatekeepers(await capability.api.list())
      // Its management UI's nav entry, and the Data page, follow without a reload.
      refreshGatekeeperApps(authenticatedApi)
      refreshDataArea(authenticatedApi)
    } catch (err) {
      console.error('Failed to change organization gatekeeper:', err)
      toasts.add({
        title: enabled ? 'Failed to disable for organization' : 'Failed to enable for organization',
        variant: 'error',
      })
    } finally {
      setBusyVendorId(null)
    }
  }

  return (
    <section className="mb-10">
      <SectionEyebrow label="Your organization" />
      <div className="flex flex-col gap-2">
        {gatekeepers.map((gatekeeper) => (
          <div
            key={gatekeeper.vendorId}
            className="flex items-center justify-between gap-3 rounded-2xl border border-kumo-line bg-kumo-base px-4 py-3"
          >
            <div className="min-w-0">
              <p className="m-0 truncate text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
                {gatekeeper.title}
              </p>
              <p className="m-0 truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                {describeState(gatekeeper)}
              </p>
            </div>
            {gatekeeper.mayManage && gatekeeper.mode !== 'disabled' && (
              <Button
                variant={gatekeeper.enabled ? 'secondary' : 'primary'}
                size="sm"
                onClick={() => handleToggle(gatekeeper)}
                loading={busyVendorId === gatekeeper.vendorId}
                disabled={busyVendorId !== null}
              >
                {gatekeeper.enabled ? 'Disable for organization' : 'Enable for organization'}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
