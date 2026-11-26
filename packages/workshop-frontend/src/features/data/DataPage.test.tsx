// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TenantGatekeeperInfo, TenantGatekeepersApi } from '@gadgets/workshop-shared/api'
import { DataPage } from './DataPage'

// The page reads only `authenticatedApi.getTenantGatekeepersApi()` from the auth context.
const auth = vi.hoisted<{ current: { authenticatedApi: object } | null }>(() => ({ current: null }))

vi.mock('../../AuthContext', () => ({ useOptionalAuthenticatedApi: () => auth.current }))
vi.mock('../../useGatekeeperApps', () => ({ refreshGatekeeperApps: vi.fn<(api: object) => void>() }))
vi.mock('../../GatekeeperAppPage', () => ({
  default: ({ appId, path }: { appId: string; path: string }) => (
    <div data-testid="app-host">{`${appId} ${path}`}</div>
  ),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const retail = (overrides: Partial<TenantGatekeeperInfo> = {}): TenantGatekeeperInfo => ({
  vendorId: 'retail', title: 'Data', enabled: false, mode: 'optional', mayManage: true,
  ...overrides,
})

const capability = (...lists: TenantGatekeeperInfo[][]) => {
  const list = vi.fn<TenantGatekeepersApi['list']>()
  for (const entries of lists) list.mockResolvedValueOnce(entries)
  return {
    list,
    enable: vi.fn<TenantGatekeepersApi['enable']>(async () => {}),
    disable: vi.fn<TenantGatekeepersApi['disable']>(async () => {}),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
}

describe('DataPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  const open = async (getTenantGatekeepersApi: () => Promise<ReturnType<typeof capability> | null>) => {
    auth.current = { authenticatedApi: { getTenantGatekeepersApi } }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<DataPage path="/browse/orders" />))
  }

  const button = (name: string) =>
    [...container!.querySelectorAll('button')].find(item => item.textContent?.trim() === name)
  const heading = () => container!.querySelector('h2')?.textContent
  const appHost = () => container!.querySelector('[data-testid="app-host"]')?.textContent

  it('shows a loader while the state is loading', async () => {
    await open(() => new Promise(() => {}))

    expect(container!.querySelector('[role="status"]')).not.toBeNull()
    expect(heading()).toBeUndefined()
    expect(appHost()).toBeUndefined()
  })

  it('says Data is not available without Clerk', async () => {
    await open(async () => null)

    expect(heading()).toBe('Data is not available on this deployment.')
    expect(button('Turn on Data')).toBeUndefined()
  })

  it('says Data is not available when the vendor is not bound', async () => {
    await open(async () => capability([]))

    expect(heading()).toBe('Data is not available on this deployment.')
  })

  it('says Data is turned off when the operator disabled it', async () => {
    await open(async () => capability([retail({ mode: 'disabled' })]))

    expect(heading()).toBe('Data is turned off on this deployment.')
    expect(button('Turn on Data')).toBeUndefined()
  })

  it('hosts the Data app at the given path once Data is on', async () => {
    await open(async () => capability([retail({ enabled: true })]))

    expect(appHost()).toBe('retail /browse/orders')
  })

  it('explains Data to an administrator and turns it on in place', async () => {
    const api = capability([retail()], [retail({ enabled: true })])
    await open(async () => api)

    expect(heading()).toBe('Data')
    expect(container!.textContent).toContain('Square or Stripe')
    expect(container!.textContent).toContain('Dashboards, Reports and chats')

    await act(async () => { button('Turn on Data')!.click() })

    expect(api.enable).toHaveBeenCalledExactlyOnceWith('retail')
    expect(appHost()).toBe('retail /browse/orders')
  })

  it('shows a refusal and keeps the button', async () => {
    const api = capability([retail()])
    api.enable.mockRejectedValueOnce(new Error('Only an organization administrator may do this.'))
    await open(async () => api)

    await act(async () => { button('Turn on Data')!.click() })

    expect(container!.textContent).toContain('Only an organization administrator may do this.')
    expect(button('Turn on Data')).toBeDefined()
    expect(appHost()).toBeUndefined()
  })

  it('tells a member that an administrator turns Data on, with no button', async () => {
    await open(async () => capability([retail({ mayManage: false })]))

    expect(heading()).toBe('Data')
    expect(container!.textContent).toContain('An administrator of your organization needs to turn Data on.')
    expect(container!.querySelector('button')).toBeNull()
  })
})
