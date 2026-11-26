// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GatekeeperAppInfo, TenantGatekeeperInfo, TenantGatekeepersApi,
} from '@gadgets/workshop-shared/api'
import { useGatekeeperApps } from '../useGatekeeperApps'
import Header from './Header'

// The Data entry reads only `authenticatedApi.getTenantGatekeepersApi()` from the auth context.
const auth = vi.hoisted<{ current: { authenticatedApi: object } | null }>(() => ({ current: null }))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}))
vi.mock('../AuthContext', () => ({ useOptionalAuthenticatedApi: () => auth.current }))
vi.mock('../useGatekeeperApps', () => ({
  useGatekeeperApps: vi.fn<typeof useGatekeeperApps>(),
  refreshGatekeeperApps: vi.fn<(api: object) => void>(),
}))
vi.mock('../ServerConfigContext', () => ({ useSiteName: () => 'Workshop' }))
vi.mock('../clerk/clerkBridge', () => ({ useClerkBridge: () => null }))
vi.mock('./SiteLogo', () => ({ default: ({ children }: { children: ReactNode }) => children }))
vi.mock('./UserMenu', () => ({ default: () => null }))
vi.mock('../clerk/WorkspaceSwitcher', () => ({ default: () => null }))
vi.mock('../TopBarNotice', () => ({ default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const app = (id: string, title: string): GatekeeperAppInfo => ({ id, title })

const capability = (entries: TenantGatekeeperInfo[]) => ({
  list: vi.fn<TenantGatekeepersApi['list']>(async () => entries),
  enable: vi.fn<TenantGatekeepersApi['enable']>(async () => {}),
  disable: vi.fn<TenantGatekeepersApi['disable']>(async () => {}),
  [Symbol.dispose]: vi.fn<() => void>(),
})

describe('Header', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  // Renders the header with its mobile menu open, so both navigation lists are present.
  const open = async (api: ReturnType<typeof capability> | null, apps: GatekeeperAppInfo[]) => {
    auth.current = { authenticatedApi: { getTenantGatekeepersApi: async () => api } }
    vi.mocked(useGatekeeperApps).mockReturnValue(apps)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Header />))
    await act(async () => { container!.querySelector<HTMLButtonElement>('.sm\\:hidden button')!.click() })
  }

  const labelsIn = (list: number) =>
    [...container!.querySelectorAll('nav')[list].querySelectorAll('a')].map((link) => link.textContent?.trim())

  it('lists Data once in each list when the retail app is also served', async () => {
    await open(
      capability([{ vendorId: 'retail', title: 'Data', enabled: true, mode: 'optional', mayManage: true }]),
      [app('retail', 'Data'), app('context', 'Context Library')],
    )

    for (const list of [0, 1]) {
      expect(labelsIn(list).filter((label) => label === 'Data')).toHaveLength(1)
      expect(labelsIn(list)).toContain('Context Library')
    }
  })

  it('does not list Data on a deployment without Clerk', async () => {
    await open(null, [app('context', 'Context Library')])

    for (const list of [0, 1]) {
      expect(labelsIn(list)).not.toContain('Data')
      expect(labelsIn(list)).toContain('Context Library')
    }
  })
})
