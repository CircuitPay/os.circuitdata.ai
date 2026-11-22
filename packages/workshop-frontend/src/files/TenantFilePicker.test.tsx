// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, TenantFile, TenantFilesApi, TenantFilesUsage } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import TenantFilePicker from './TenantFilePicker'

vi.mock('../AuthContext', () => ({ useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const file = (overrides: Partial<TenantFile> & { name: string }): TenantFile => ({
  id: overrides.name, size: 1234, contentType: 'text/csv', previewable: false,
  uploader: { name: 'Tom', isMe: false }, uploadedAt: new Date('2026-11-01T10:00:00Z'), mayRemove: false,
  ...overrides,
})

const usage: TenantFilesUsage = { usedBytes: 2_000, quotaBytes: 5_000_000, fileCount: 2, maxFileBytes: 100_000 }

describe('TenantFilePicker', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  function capability(files: TenantFile[], next?: string) {
    return {
      getUsage: vi.fn<TenantFilesApi['getUsage']>(async () => usage),
      listFiles: vi.fn<TenantFilesApi['listFiles']>(async () => ({ files, next })),
      findExisting: vi.fn<TenantFilesApi['findExisting']>(async () => []),
      uploadFile: vi.fn<TenantFilesApi['uploadFile']>(async (request, body) => {
        await new Response(body).arrayBuffer()
        return file({ name: request.name, id: `new-${request.name}`, contentType: request.contentType })
      }),
      downloadFile: vi.fn<TenantFilesApi['downloadFile']>(),
      removeFile: vi.fn<TenantFilesApi['removeFile']>(async () => {}),
      [Symbol.dispose]: vi.fn<() => void>(),
    }
  }

  async function open(
    api: ReturnType<typeof capability> | null,
    { accept = ['.csv', 'text/csv'], multiple = true }: { accept?: string[]; multiple?: boolean } = {},
  ) {
    const authenticatedApi = { getFilesApi: async () => api } as unknown as RpcStub<AuthenticatedApi>
    vi.mocked(useAuthenticatedApi).mockImplementation(
      () => ({ authenticatedApi }) as ReturnType<typeof useAuthenticatedApi>)
    const onConfirm = vi.fn<(files: TenantFile[]) => void>()
    const onCancel = vi.fn<() => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <TenantFilePicker accept={accept} multiple={multiple} onConfirm={onConfirm} onCancel={onCancel} />))
    return { onConfirm, onCancel }
  }

  const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!

  const button = (name: string) =>
    [...dialog().querySelectorAll('button')].find(item =>
      item.textContent?.trim() === name || item.getAttribute('aria-label') === name)

  async function click(name: string) {
    const target = button(name)
    if (!target) throw new Error(`No button named ${name}`)
    await act(async () => { target.click() })
  }

  // The selectable control labelled by a file's name (a checkbox, or a radio for a single pick).
  const control = (name: string) => {
    const label = [...dialog().querySelectorAll('label')].find(item => item.textContent?.includes(name))
    const target = label?.querySelector<HTMLElement>('[role="checkbox"], [role="radio"]')
    if (!target) throw new Error(`No control for ${name}`)
    return target
  }

  // Through the input the control forwards its clicks to, since jsdom has no PointerEvent to forward
  // them with.
  async function toggle(name: string) {
    const input = control(name).nextElementSibling
    if (!(input instanceof HTMLInputElement)) throw new Error(`No input for ${name}`)
    await act(async () => { input.click() })
  }

  const isDisabled = (target: HTMLElement) =>
    target.hasAttribute('data-disabled') || target.getAttribute('aria-disabled') === 'true'

  async function choose(...files: File[]) {
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  }

  // jsdom's File has no stream(), which the upload reads.
  const upload = (name: string, type: string, text = 'a,b\n1,2') => Object.assign(new File([text], name, { type }), {
    stream: () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() },
    }),
  })

  it('is a labelled modal dialog that takes focus and offers only accepted files', async () => {
    const api = capability([file({ name: 'sales.csv' }), file({ name: 'logo.png', contentType: 'image/png' })])
    await open(api)

    const element = dialog()
    const titleId = element.getAttribute('aria-labelledby')
    expect(titleId && document.getElementById(titleId)?.textContent).toBe('Choose files')
    expect(element.contains(document.activeElement)).toBe(true)
    expect(element.textContent).toContain('Only .csv, text/csv files can be chosen.')
    expect(isDisabled(control('sales.csv'))).toBe(false)
    expect(isDisabled(control('logo.png'))).toBe(true)
    expect(button('Use files')?.disabled).toBe(true)
  })

  it('confirms the chosen files, and allows at most ten', async () => {
    const files = Array.from({ length: 11 }, (_, index) => file({ name: `day-${index + 1}.csv` }))
    const api = capability(files)
    const { onConfirm } = await open(api)

    for (const chosen of files.slice(0, 10)) await toggle(chosen.name)
    expect(dialog().textContent).toContain('10 of 10 chosen')
    expect(isDisabled(control('day-11.csv'))).toBe(true)

    await toggle('day-1.csv')
    expect(isDisabled(control('day-11.csv'))).toBe(false)
    await toggle('day-11.csv')

    await click('Use files')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].map(chosen => chosen.name)).toEqual(
      [...files.slice(1, 10), files[10]].map(chosen => chosen.name))
  })

  it('keeps a single choice when only one file is asked for', async () => {
    const api = capability([file({ name: 'a.csv' }), file({ name: 'b.csv' })])
    const { onConfirm } = await open(api, { multiple: false })

    expect(control('a.csv').getAttribute('role')).toBe('radio')
    await toggle('a.csv')
    await toggle('b.csv')
    await click('Use file')
    expect(onConfirm.mock.calls[0][0].map(chosen => chosen.id)).toEqual(['b.csv'])
  })

  it('searches by name and loads further pages', async () => {
    const api = capability([file({ name: 'a.csv' })], 'cursor-1')
    await open(api)

    api.listFiles.mockResolvedValueOnce({ files: [file({ name: 'b.csv' })] })
    await click('Load more')
    expect(api.listFiles).toHaveBeenLastCalledWith({ query: undefined, after: 'cursor-1' })
    expect(dialog().textContent).toContain('b.csv')
    expect(button('Load more')).toBeUndefined()

    vi.useFakeTimers()
    const search = dialog().querySelector<HTMLInputElement>('input:not([type="file"])')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(search, 'march')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(api.listFiles).toHaveBeenLastCalledWith({ query: 'march' })
  })

  it('uploads into Files first and chooses the new file, refusing types that are not accepted', async () => {
    const api = capability([])
    const { onConfirm } = await open(api)

    await choose(upload('march.csv', 'text/csv'), upload('photo.png', 'image/png'))

    expect(api.uploadFile).toHaveBeenCalledTimes(1)
    expect(api.uploadFile.mock.calls[0][0]).toEqual(
      { name: 'march.csv', size: 7, contentType: 'text/csv', onConflict: 'keep-both' })
    expect(dialog().textContent).toContain('photo.png')
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('photo.png')
    expect(dialog().textContent).toContain('1 of 10 chosen')

    await click('Use files')
    expect(onConfirm.mock.calls[0][0].map(chosen => chosen.id)).toEqual(['new-march.csv'])
  })

  it('cancels from the button and from Escape without choosing anything', async () => {
    const api = capability([file({ name: 'a.csv' })])
    const { onConfirm, onCancel } = await open(api)

    await toggle('a.csv')
    await click('Cancel')
    expect(onCancel).toHaveBeenCalledTimes(1)

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('releases its files capability when it closes', async () => {
    const api = capability([])
    await open(api)
    act(() => root!.unmount())
    expect(api[Symbol.dispose]).toHaveBeenCalledTimes(1)
  })
})
