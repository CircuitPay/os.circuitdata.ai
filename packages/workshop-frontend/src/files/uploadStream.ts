/**
 * The file's bytes as a stream that reports how many have been read so far. The RPC layer pulls
 * from it only as fast as the connection takes bytes, so the count follows what has been sent.
 */
export const trackedStream = (
  file: Blob,
  onProgress: (sentBytes: number) => void,
): ReadableStream<Uint8Array> => {
  let sent = 0
  return file.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sent += chunk.byteLength
      onProgress(sent)
      controller.enqueue(chunk)
    },
  }))
}
