import { describe, expect, it } from 'vitest'
import { trackedStream } from './uploadStream'

const blobOf = (...chunks: number[][]) => ({
  stream: () => new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk))
      controller.close()
    },
  }),
}) as unknown as Blob

describe('trackedStream', () => {
  it('passes every byte through unchanged and reports the running total as it is read', async () => {
    const seen: number[] = []
    const stream = trackedStream(blobOf([1, 2, 3], [4, 5], [6]), sent => seen.push(sent))

    const received = new Uint8Array(await new Response(stream).arrayBuffer())

    expect([...received]).toEqual([1, 2, 3, 4, 5, 6])
    expect(seen).toEqual([3, 5, 6])
  })

  it('reports nothing for an empty file', async () => {
    const seen: number[] = []
    const received = await new Response(trackedStream(blobOf(), sent => seen.push(sent))).arrayBuffer()

    expect(received.byteLength).toBe(0)
    expect(seen).toEqual([])
  })
})
