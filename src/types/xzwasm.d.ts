declare module 'xzwasm' {
  export class XzReadableStream extends ReadableStream<Uint8Array> {
    constructor(compressedStream: ReadableStream<Uint8Array>);
  }
}
