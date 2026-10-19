// Wrangler's CompiledWasm rule turns .wasm imports into WebAssembly.Module.
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

declare module '@jitl/quickjs-wasmfile-release-sync/wasm' {
  const module: WebAssembly.Module;
  export default module;
}
