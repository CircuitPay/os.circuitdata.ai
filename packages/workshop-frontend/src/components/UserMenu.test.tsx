// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClerkBridgeContext, type ClerkBridge } from '../clerk/clerkBridge'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn<() => void>() }))
vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: {}, logout: () => {}, currentUser: { id: 'u', name: 'Ada Lovelace' }, isAdmin: false,
  }),
}))
vi.mock('../useAvatar', () => ({ useAvatar: () => null }))
vi.mock('../branding/useTenantBranding', () => ({ useTenantBranding: () => ({ canManage: false }) }))

import UserMenu from './UserMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function bridge(overrides: Partial<ClerkBridge>): ClerkBridge {
  return {
    isLoaded: true,
    isSignedIn: true,
    userId: 'user_1',
    orgId: 'org_1',
    getToken: async () => 'token',
    signOut: async () => {},
    switchOrganization: async () => {},
    openUserProfile: () => {},
    isOrganizationAdmin: false,
    openOrganizationMembers: vi.fn<() => void>(),
    ...overrides,
  }
}

describe('UserMenu invite members', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  async function openMenu(clerk: ClerkBridge | null) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ClerkBridgeContext.Provider value={clerk}><UserMenu /></ClerkBridgeContext.Provider>))
    await act(async () => container!.querySelector<HTMLElement>('[aria-label="Open profile menu"]')!.click())
    return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  }

  const invite = (items: HTMLElement[]) => items.find(item => item.textContent === 'Invite members')

  it('opens the members panel for an administrator of the active organization', async () => {
    const clerk = bridge({ isOrganizationAdmin: true })
    const item = invite(await openMenu(clerk))
    expect(item).toBeDefined()
    await act(async () => item!.click())
    expect(clerk.openOrganizationMembers).toHaveBeenCalledOnce()
  })

  it.each([
    ['an organization member', bridge({ isOrganizationAdmin: false })],
    ['the personal workspace', bridge({ orgId: null, isOrganizationAdmin: false })],
    ['a deployment without Clerk', null],
  ])('is not offered to %s', async (_, clerk) => {
    const items = await openMenu(clerk)
    expect(items.map(item => item.textContent)).toContain('Profile')
    expect(invite(items)).toBeUndefined()
  })
})
