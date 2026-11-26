// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GatekeeperAppInfo, TenantGatekeeperInfo, TenantGatekeepersApi,
} from '@gadgets/workshop-shared/api'
import { useGatekeeperApps } from '../../useGatekeeperApps'
import Sidebar from './Sidebar'

// The Data entry reads only `authenticatedApi.getTenantGatekeepersApi()` from the auth context.
const auth = vi.hoisted<{ current: { authenticatedApi: object } | null }>(() => ({ current: null }))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode | ((state: { isActive: boolean }) => ReactNode) }) => (
    <a href="/">{typeof children === 'function' ? children({ isActive: false }) : children}</a>
  ),
}))
vi.mock('../../AuthContext', () => ({ useOptionalAuthenticatedApi: () => auth.current }))
vi.mock('../../useGatekeeperApps', () => ({
  useGatekeeperApps: vi.fn<typeof useGatekeeperApps>(),
  refreshGatekeeperApps: vi.fn<(api: object) => void>(),
}))
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'Workshop' }))
vi.mock('../SiteLogo', () => ({ default: ({ children }: { children: ReactNode }) => children }))
vi.mock('./SidebarWorkspaces', () => ({
  SidebarWorkspacesProvider: ({ children }: { children: ReactNode }) => children,
  SidebarWorkspacesTools: () => null,
  SidebarWorkspacesLists: () => null,
}))
vi.mock('./SidebarUtilityStrip', () => ({ default: () => null }))
vi.mock('../../features/notifications/UnreadSummary', () => ({ UnreadSummary: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const app = (id: string, title: string): GatekeeperAppInfo => ({ id, title })

const retail = (overrides: Partial<TenantGatekeeperInfo> = {}): TenantGatekeeperInfo => ({
  vendorId: 'retail', title: 'Data', enabled: true, mode: 'optional', mayManage: true,
  ...overrides,
})

const capability = (entries: TenantGatekeeperInfo[]) => ({
  list: vi.fn<TenantGatekeepersApi['list']>(async () => entries),
  enable: vi.fn<TenantGatekeepersApi['enable']>(async () => {}),
  disable: vi.fn<TenantGatekeepersApi['disable']>(async () => {}),
  [Symbol.dispose]: vi.fn<() => void>(),
})

describe('Sidebar', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  const open = async (api: ReturnType<typeof capability> | null, apps: GatekeeperAppInfo[]) => {
    auth.current = { authenticatedApi: { getTenantGatekeepersApi: async () => api } }
    vi.mocked(useGatekeeperApps).mockReturnValue(apps)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />))
  }

  const labels = () =>
    [...container!.querySelectorAll('nav a')].map((link) => link.textContent?.trim())

  it('lists Data once, after Outputs, when the retail app is also served', async () => {
    await open(capability([retail()]), [app('retail', 'Data'), app('context', 'Context Library')])

    expect(labels().filter((label) => label === 'Data')).toHaveLength(1)
    expect(labels().indexOf('Data')).toBe(labels().indexOf('Outputs') + 1)
    expect(labels()).toContain('Context Library')
  })

  it('lists Data before the organization has turned it on', async () => {
    await open(capability([retail({ enabled: false, mayManage: false })]), [])

    expect(labels()).toContain('Data')
  })

  it('does not list Data on a deployment without Clerk', async () => {
    await open(null, [app('context', 'Context Library')])

    expect(labels()).not.toContain('Data')
    expect(labels()).toContain('Context Library')
  })
})
