// Type declarations for WASM module imports in Cloudflare Workers
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
