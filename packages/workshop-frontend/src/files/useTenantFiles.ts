import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { TenantFile, TenantFilesApi, TenantFilesUsage } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'

// The capability is wrapped, because useState would call a bare stub (every stub is callable).
type Session =
  | { status: 'connecting' }
  | { status: 'unavailable' }
  | { status: 'failed' }
  | { status: 'ready'; files: { api: RpcStub<TenantFilesApi> } }

type Listing = {
  session: Session
  query: string
  version: number
  outcome: { files: TenantFile[]; next?: string; usage: TenantFilesUsage } | 'failed'
}

export type TenantFilesView =
  | { status: 'loading' | 'unavailable' | 'failed' }
  | {
    status: 'ready'
    api: RpcStub<TenantFilesApi>
    files: TenantFile[]
    usage: TenantFilesUsage
    hasMore: boolean
    /** A newer listing (another search, or after a change) is loading behind this one. */
    refreshing: boolean
  }

/**
 * The active workspace's files: the capability for them, and the first page and usage for `query`.
 * Everything is dropped and reloaded when the connection changes (switching workspace reconnects),
 * so nothing of the previous workspace is ever shown.
 */
export const useTenantFiles = (query: string) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [session, setSession] = useState<Session>({ status: 'connecting' })
  const [listing, setListing] = useState<Listing>()
  const [version, setVersion] = useState(0)
  const [more, setMore] = useState<{ listing: Listing; files: TenantFile[]; next?: string }>()

  useEffect(() => {
    let cancelled = false
    let stub: RpcStub<TenantFilesApi> | null = null
    setSession({ status: 'connecting' })
    authenticatedApi.getFilesApi().then(api => {
      if (cancelled) {
        api?.[Symbol.dispose]()
        return
      }
      stub = api
      setSession(api ? { status: 'ready', files: { api } } : { status: 'unavailable' })
    }).catch(() => { if (!cancelled) setSession({ status: 'failed' }) })
    return () => {
      cancelled = true
      stub?.[Symbol.dispose]()
    }
  }, [authenticatedApi])

  useEffect(() => {
    if (session.status !== 'ready') return
    let cancelled = false
    const { api } = session.files
    Promise.all([api.listFiles({ query: query || undefined }), api.getUsage()])
      .then(([page, usage]) => ({ ...page, usage }))
      .then(
        outcome => outcome,
        () => 'failed' as const,
      )
      .then(outcome => { if (!cancelled) setListing({ session, query, version, outcome }) })
    return () => { cancelled = true }
  }, [session, query, version])

  // What is on screen: the latest listing for this connection, which stays up while the next one
  // loads so a search or a refresh does not blank the page. A new connection shows none of it.
  const shown = listing?.session === session ? listing : undefined
  const refreshing = shown !== undefined &&
    (shown.query !== query || shown.version !== version)
  const continuation = more?.listing === shown ? more : undefined

  let view: TenantFilesView
  if (session.status !== 'ready') {
    view = { status: session.status === 'connecting' ? 'loading' : session.status }
  } else if (!shown) {
    view = { status: 'loading' }
  } else if (shown.outcome === 'failed') {
    view = { status: 'failed' }
  } else {
    const { files, next, usage } = shown.outcome
    view = {
      status: 'ready', api: session.files.api, usage, refreshing,
      files: [...files, ...(continuation?.files ?? [])],
      hasMore: (continuation ? continuation.next : next) !== undefined,
    }
  }

  return {
    view,
    /** Reloads the first page and the usage, after an upload or a removal. */
    refresh: () => setVersion(value => value + 1),
    /** Appends the next page of the current listing. */
    loadMore: async () => {
      if (!shown || shown.outcome === 'failed' || session.status !== 'ready') return
      const after = continuation ? continuation.next : shown.outcome.next
      if (after === undefined) return
      const page = await session.files.api.listFiles({ query: query || undefined, after })
      setMore({
        listing: shown,
        files: [...(continuation?.files ?? []), ...page.files],
        next: page.next,
      })
    },
  }
}
