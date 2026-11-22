// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi, TenantGatekeeperInfo, TenantGatekeepersApi,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { TenantGatekeepersSection } from './TenantGatekeepersSection'

const testState = vi.hoisted(() => ({ addToast: vi.fn<(toast: { title: string; variant: string }) => void>() }))

vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>() }))
vi.mock('../../useGatekeeperApps', () => ({ refreshGatekeeperApps: vi.fn<(api: object) => void>() }))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const gatekeeper = (overrides: Partial<TenantGatekeeperInfo> = {}): TenantGatekeeperInfo => ({
  vendorId: 'retail-data', title: 'Data', enabled: false, mode: 'optional', mayManage: true,
  ...overrides,
})

describe('TenantGatekeepersSection', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  function capability(...lists: TenantGatekeeperInfo[][]) {
    const list = vi.fn<TenantGatekeepersApi['list']>()
    for (const entries of lists) list.mockResolvedValueOnce(entries)
    return {
      list,
      enable: vi.fn<TenantGatekeepersApi['enable']>(async () => {}),
      disable: vi.fn<TenantGatekeepersApi['disable']>(async () => {}),
      [Symbol.dispose]: vi.fn<() => void>(),
    }
  }

  async function open(api: ReturnType<typeof capability> | null) {
    const authenticatedApi = { getTenantGatekeepersApi: async () => api } as unknown as RpcStub<AuthenticatedApi>
    vi.mocked(useAuthenticatedApi).mockImplementation(
      () => ({ authenticatedApi }) as ReturnType<typeof useAuthenticatedApi>)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<TenantGatekeepersSection />))
  }

  const button = (name: string) =>
    [...document.body.querySelectorAll('button')].find(item => item.textContent?.trim() === name)

  it('renders nothing on a deployment without Clerk', async () => {
    await open(null)

    expect(container!.innerHTML).toBe('')
  })

  it('lets an administrator enable a gatekeeper, then shows the refreshed state', async () => {
    const api = capability([gatekeeper()], [gatekeeper({ enabled: true })])
    await open(api)

    await act(async () => { button('Enable for organization')!.click() })

    expect(api.enable).toHaveBeenCalledWith('retail-data')
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(container!.textContent).toContain('Enabled for your organization')
    expect(button('Disable for organization')).toBeDefined()
  })

  it('surfaces a failed enable', async () => {
    const api = capability([gatekeeper()])
    api.enable.mockRejectedValueOnce(new Error('not an administrator'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await open(api)

    await act(async () => { button('Enable for organization')!.click() })

    expect(testState.addToast).toHaveBeenCalledWith({ title: 'Failed to enable for organization', variant: 'error' })
  })

  it('shows a member the state without a control', async () => {
    await open(capability([gatekeeper({ mayManage: false })]))

    expect(container!.textContent).toContain('Not enabled — ask an administrator')
    expect(container!.querySelector('button')).toBeNull()
  })

  it('offers no control for a gatekeeper the operator disabled', async () => {
    await open(capability([gatekeeper({ mode: 'disabled' })]))

    expect(container!.textContent).toContain('Data')
    expect(container!.textContent).toContain('disabled by the operator')
    expect(container!.querySelector('button')).toBeNull()
  })

  it('disposes the capability on unmount', async () => {
    const api = capability([gatekeeper()])
    await open(api)

    act(() => root!.unmount())
    root = undefined

    expect(api[Symbol.dispose]).toHaveBeenCalled()
  })
})
