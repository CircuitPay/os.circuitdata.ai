// Text and WebAssembly module imports (Wrangler's default module rules).
declare module "*.txt" {
  const content: string;
  export default content;
}

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
