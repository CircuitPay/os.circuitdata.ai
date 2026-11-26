// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TenantGatekeeperInfo, TenantGatekeepersApi } from '@gadgets/workshop-shared/api'
import { refreshGatekeeperApps } from '../../useGatekeeperApps'
import { refreshDataArea, useDataArea, type DataArea } from './dataArea'

// The hook reads only `authenticatedApi.getTenantGatekeepersApi()` from the auth context.
const auth = vi.hoisted<{ current: { authenticatedApi: object } | null }>(() => ({ current: null }))

vi.mock('../../AuthContext', () => ({ useOptionalAuthenticatedApi: () => auth.current }))
vi.mock('../../useGatekeeperApps', () => ({ refreshGatekeeperApps: vi.fn<(api: object) => void>() }))

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

const session = (api: ReturnType<typeof capability> | null) => {
  const getTenantGatekeepersApi = vi.fn<() => Promise<ReturnType<typeof capability> | null>>(async () => api)
  return { getTenantGatekeepersApi, authenticatedApi: { getTenantGatekeepersApi } }
}

const signIn = ({ authenticatedApi }: { authenticatedApi: object }) => {
  auth.current = { authenticatedApi }
}

describe('useDataArea', () => {
  let root: Root | undefined
  let areas: DataArea[][] = []

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    areas = []
    auth.current = null
    vi.clearAllMocks()
  })

  // Mounts `callers` independent consumers of the hook, like the Sidebar, Header and page together.
  const mount = async (callers = 1) => {
    areas = Array.from({ length: callers }, () => [])
    const Probe = ({ index }: { index: number }) => {
      areas[index].push(useDataArea())
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(areas.map((_, index) => createElement(Probe, { key: index, index }))))
  }

  const current = (index = 0) => areas[index].at(-1)!

  it('is absent without a signed-in session', async () => {
    auth.current = null
    await mount()

    expect(current().state).toBe('absent')
  })

  it('is absent on a deployment without Clerk', async () => {
    signIn(session(null))
    await mount()

    expect(current().state).toBe('absent')
  })

  it('is absent when the retail vendor is not bound', async () => {
    signIn(session(capability([retail({ vendorId: 'other' })])))
    await mount()

    expect(current().state).toBe('absent')
  })

  it('is unavailable when the operator disabled the vendor', async () => {
    signIn(session(capability([retail({ mode: 'disabled', enabled: true })])))
    await mount()

    expect(current().state).toBe('unavailable')
  })

  it('is on when the organization enabled it', async () => {
    signIn(session(capability([retail({ enabled: true })])))
    await mount()

    expect(current().state).toBe('on')
  })

  it('is off, with whether the caller may manage it', async () => {
    signIn(session(capability([retail({ mayManage: false })])))
    await mount()

    expect(current()).toMatchObject({ state: 'off', mayManage: false })
  })

  it('makes one request for every mounted caller', async () => {
    const api = capability([retail()])
    const signedIn = session(api)
    signIn(signedIn)
    await mount(3)

    expect(signedIn.getTenantGatekeepersApi).toHaveBeenCalledTimes(1)
    expect(api.list).toHaveBeenCalledTimes(1)
    expect([current(0).state, current(1).state, current(2).state]).toEqual(['off', 'off', 'off'])
  })

  it('turns Data on, then every caller re-reads', async () => {
    const api = capability([retail()], [retail({ enabled: true })])
    const signedIn = session(api)
    signIn(signedIn)
    await mount(2)

    const area = current(0)
    if (area.state !== 'off') throw new Error(`expected off, got ${area.state}`)
    await act(() => area.enable())

    expect(api.enable).toHaveBeenCalledExactlyOnceWith('retail')
    expect(refreshGatekeeperApps).toHaveBeenCalledWith(signedIn.authenticatedApi)
    expect([current(0).state, current(1).state]).toEqual(['on', 'on'])
  })

  it('rejects a refused enable with the server message and stays off', async () => {
    const api = capability([retail()])
    api.enable.mockRejectedValueOnce(new Error('Only an organization administrator may do this.'))
    signIn(session(api))
    await mount()

    const area = current()
    if (area.state !== 'off') throw new Error(`expected off, got ${area.state}`)

    await expect(area.enable()).rejects.toThrow('Only an organization administrator may do this.')
    expect(current().state).toBe('off')
  })

  it('re-reads when the Connectors page changes it', async () => {
    const signedIn = session(capability([retail()], [retail({ enabled: true })]))
    signIn(signedIn)
    await mount()

    await act(async () => refreshDataArea(signedIn.authenticatedApi))

    expect(current().state).toBe('on')
  })

  it('disposes the old capability and re-reads on a session change', async () => {
    const first = capability([retail({ enabled: true })])
    const second = capability([retail({ mayManage: false })])
    signIn(session(first))
    await mount()
    expect(current().state).toBe('on')

    signIn(session(second))
    await act(async () => root!.render(createElement(() => {
      areas[0].push(useDataArea())
      return null
    })))

    expect(first[Symbol.dispose]).toHaveBeenCalledTimes(1)
    expect(second.list).toHaveBeenCalledTimes(1)
    expect(current()).toMatchObject({ state: 'off', mayManage: false })
  })

  it('disposes the capability when the last caller unmounts', async () => {
    const api = capability([retail()])
    signIn(session(api))
    await mount(2)

    await act(async () => root!.unmount())
    root = undefined

    expect(api[Symbol.dispose]).toHaveBeenCalledTimes(1)
  })
})
