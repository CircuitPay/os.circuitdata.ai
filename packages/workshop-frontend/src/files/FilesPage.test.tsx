// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi, FileUploadRequest, TenantFile, TenantFilesApi, TenantFilesUsage,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import FilesPage from './FilesPage'

const testState = vi.hoisted(() => ({ addToast: vi.fn<(toast: { title: string; variant: string }) => void>() }))

vi.mock('../AuthContext', () => ({ useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>() }))
vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const file = (overrides: Partial<TenantFile> & { name: string }): TenantFile => ({
  id: overrides.name, size: 1234, contentType: 'text/plain', previewable: false,
  uploader: { name: 'Tom', isMe: false }, uploadedAt: new Date('2026-11-01T10:00:00Z'), mayRemove: false,
  ...overrides,
})

const usage: TenantFilesUsage = { usedBytes: 2_000_000, quotaBytes: 5_000_000_000, fileCount: 2, maxFileBytes: 100_000_000 }

describe('FilesPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  function capability(files: TenantFile[], taken: string[] = []) {
    return {
      getUsage: vi.fn<TenantFilesApi['getUsage']>(async () => usage),
      listFiles: vi.fn<TenantFilesApi['listFiles']>(async () => ({ files })),
      findExisting: vi.fn<TenantFilesApi['findExisting']>(async () => taken),
      uploadFile: vi.fn<TenantFilesApi['uploadFile']>(async (request, body) => {
        await new Response(body).arrayBuffer()
        return file({ name: request.name })
      }),
      downloadFile: vi.fn<TenantFilesApi['downloadFile']>(),
      removeFile: vi.fn<TenantFilesApi['removeFile']>(async () => {}),
      [Symbol.dispose]: vi.fn<() => void>(),
    }
  }

  async function open(api: ReturnType<typeof capability> | null) {
    // One stub for the whole session: a new one per render would restart the page's effect.
    const authenticatedApi = { getFilesApi: async () => api } as unknown as RpcStub<AuthenticatedApi>
    vi.mocked(useAuthenticatedApi).mockImplementation(
      () => ({ authenticatedApi }) as ReturnType<typeof useAuthenticatedApi>)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<FilesPage />))
  }

  const button = (name: string) =>
    [...document.body.querySelectorAll('button')].find(item =>
      item.textContent?.trim() === name || item.getAttribute('aria-label') === name)

  async function click(name: string) {
    const target = button(name)
    if (!target) throw new Error(`No button named ${name}`)
    await act(async () => { target.click() })
  }

  async function choose(...files: File[]) {
    const input = container!.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  }

  // jsdom's File has no stream(), which the upload reads.
  const upload = (name: string, text = 'hello') => Object.assign(new File([text], name, { type: 'text/plain' }), {
    stream: () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() },
    }),
  })

  it('says files are unavailable when the deployment has no file storage', async () => {
    await open(null)
    expect(container!.textContent).toContain('File storage is not set up')
    expect(container!.querySelector('input[type="file"]')).toBeNull()
  })

  it('lists the files with their usage, and offers removal only where it is allowed', async () => {
    const api = capability([
      file({ name: 'mine.txt', uploader: { name: 'Ann', isMe: true }, mayRemove: true }),
      file({ name: 'theirs.pdf', previewable: true }),
    ])
    await open(api)

    expect(container!.textContent).toContain('mine.txt')
    expect(container!.textContent).toContain('You')
    expect(container!.textContent).toContain('2 MB of 5 GB')
    expect(button('Remove mine.txt')).toBeDefined()
    expect(button('Remove theirs.pdf')).toBeUndefined()
    expect(button('Open theirs.pdf')).toBeDefined()
    expect(button('Open mine.txt')).toBeUndefined()
  })

  it('removes a file only after the confirmation, and not when it is cancelled', async () => {
    const api = capability([file({ name: 'mine.txt', mayRemove: true })])
    await open(api)

    await click('Remove mine.txt')
    expect(document.body.textContent).toContain('Remove this file?')
    await click('Cancel')
    expect(api.removeFile).not.toHaveBeenCalled()

    await click('Remove mine.txt')
    await click('Remove')
    expect(api.removeFile).toHaveBeenCalledWith('mine.txt')
    // The list is reloaded afterwards, because it may have changed under the user.
    expect(api.listFiles).toHaveBeenCalledTimes(2)
  })

  it('uploads the chosen files, and says why one that was refused was not uploaded', async () => {
    const api = capability([])
    api.uploadFile.mockImplementation(async (request: FileUploadRequest, body) => {
      await new Response(body).arrayBuffer()
      if (request.name === 'huge.bin') throw new Error('Files can be at most 100000000 bytes.')
      return file({ name: request.name })
    })
    await open(api)

    await choose(upload('a.txt'), upload('huge.bin'))

    expect(api.uploadFile).toHaveBeenCalledTimes(2)
    expect(api.uploadFile.mock.calls[0][0]).toEqual(
      { name: 'a.txt', size: 5, contentType: 'text/plain', onConflict: 'reject' })
    expect(container!.textContent).toContain('a.txt uploaded')
    expect(container!.textContent).toContain('huge.bin was not uploaded: Files can be at most 100000000 bytes.')
    // The batch ended: the list and the usage are reloaded.
    expect(api.getUsage).toHaveBeenCalledTimes(2)
  })

  it('asks before touching a name that is taken, and carries out the answer', async () => {
    const api = capability([file({ name: 'a.txt' })], ['a.txt'])
    await open(api)

    await choose(upload('a.txt'), upload('b.txt'))
    expect(document.body.textContent).toContain('A file with this name already exists')
    expect(api.uploadFile).not.toHaveBeenCalled()

    await click('Keep both')
    const requests = api.uploadFile.mock.calls.map(([request]) => [request.name, request.onConflict])
    expect(requests).toEqual([['a.txt', 'keep-both'], ['b.txt', 'reject']])
  })

  it('uploads only the files that do not clash when told to skip, and nothing when cancelled', async () => {
    const api = capability([], ['a.txt'])
    await open(api)

    await choose(upload('a.txt'), upload('b.txt'))
    await click('Skip it')
    expect(api.uploadFile.mock.calls.map(([request]) => request.name)).toEqual(['b.txt'])

    api.uploadFile.mockClear()
    await choose(upload('a.txt'))
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(api.uploadFile).not.toHaveBeenCalled()
  })

  it('releases the capability when the page closes', async () => {
    const api = capability([])
    await open(api)
    act(() => root!.unmount())
    expect(api[Symbol.dispose]).toHaveBeenCalledTimes(1)
  })
})
