import { useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi, TenantGatekeeperInfo, TenantGatekeepersApi,
} from '@gadgets/workshop-shared/api'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure } from '../../rpcErrors'
import { refreshGatekeeperApps } from '../../useGatekeeperApps'

/** The vendor id of the organization's retail dataset (packages/gatekeeper-retail). */
export const DATA_VENDOR_ID = 'retail'

export type DataArea =
  | { state: 'loading' }
  /** No Clerk, or the vendor is not bound. */
  | { state: 'absent' }
  /** The operator's mode is "disabled". */
  | { state: 'unavailable' }
  | { state: 'off'; mayManage: boolean; enable(): Promise<void> }
  | { state: 'on' }

// Held in a plain object: a bare stub is callable and answers every property, so code that treats
// functions or promise results specially could misread it.
type Capability = { api: RpcStub<TenantGatekeepersApi> }

const LOADING: DataArea = { state: 'loading' }
const ABSENT: DataArea = { state: 'absent' }

/**
 * The Data state of one authenticated session, shared by every mounted caller so the Sidebar, the
 * Header and the Data page make one request between them. The capability is held while anyone is
 * subscribed and disposed when the last caller leaves; a new session (organization switch) is a new
 * `authenticatedApi` and so a separate instance.
 */
class DataAreaSession {
  readonly #authenticatedApi: RpcStub<AuthenticatedApi>
  readonly #listeners = new Set<() => void>()
  // The capability of the current subscription period; null while nobody is subscribed.
  #capability: Promise<Capability | null> | null = null
  #area: DataArea = LOADING
  // Increments with each read, and on close, so a slower earlier read cannot overwrite a later one.
  #reads = 0

  constructor(authenticatedApi: RpcStub<AuthenticatedApi>) {
    this.#authenticatedApi = authenticatedApi
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    if (this.#listeners.size === 1) this.#open()
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) this.#close()
    }
  }

  readonly getSnapshot = (): DataArea => this.#area

  async refresh(): Promise<void> {
    const capability = this.#capability
    if (!capability) return
    const read = ++this.#reads
    try {
      const held = await capability
      const area = held
        ? this.#areaOf((await held.api.list()).find((entry) => entry.vendorId === DATA_VENDOR_ID))
        : ABSENT
      if (read !== this.#reads) return
      this.#area = area
      for (const listener of this.#listeners) listener()
    } catch (err) {
      if (read === this.#reads) logRpcFailure('Failed to load the Data state:', err)
    }
  }

  /** The kernel checks the caller's role; a refusal rejects with its message. */
  readonly #enable = async (): Promise<void> => {
    const held = await this.#capability
    if (!held) throw new Error('Data is not available on this deployment.')
    await held.api.enable(DATA_VENDOR_ID)
    refreshGatekeeperApps(this.#authenticatedApi)
    await this.refresh()
  }

  #areaOf(entry: TenantGatekeeperInfo | undefined): DataArea {
    if (!entry) return ABSENT
    if (entry.mode === 'disabled') return { state: 'unavailable' }
    if (entry.enabled) return { state: 'on' }
    return { state: 'off', mayManage: entry.mayManage, enable: this.#enable }
  }

  #open() {
    this.#capability = this.#authenticatedApi.getTenantGatekeepersApi().then((api) => api && { api })
    void this.refresh()
  }

  #close() {
    const capability = this.#capability
    this.#capability = null
    this.#reads++
    // A failed acquisition was already reported by the read that awaited it.
    capability?.then((held) => held?.api[Symbol.dispose](), () => {})
  }
}

const sessions = new WeakMap<object, DataAreaSession>()

const sessionFor = (authenticatedApi: RpcStub<AuthenticatedApi>): DataAreaSession => {
  let session = sessions.get(authenticatedApi)
  if (!session) {
    session = new DataAreaSession(authenticatedApi)
    sessions.set(authenticatedApi, session)
  }
  return session
}

const subscribeToNothing = () => () => {}
const getAbsent = () => ABSENT

/**
 * Prompts every mounted `useDataArea()` caller of this session to re-read, after an action elsewhere
 * (the Connectors page) turned the vendor on or off.
 */
export const refreshDataArea = (authenticatedApi: object): void => {
  void sessions.get(authenticatedApi)?.refresh()
}

/** The organization's Data state, refetched when the session (organization) changes. */
export const useDataArea = (): DataArea => {
  const auth = useOptionalAuthenticatedApi()
  const session = auth ? sessionFor(auth.authenticatedApi) : null
  return useSyncExternalStore(
    session ? session.subscribe : subscribeToNothing,
    session ? session.getSnapshot : getAbsent,
  )
}
