/** Development-only declarations for Electrobun's Cottontail/Bun-compatible SDK. */
declare module 'bun:ffi' {
  export type Pointer = number | bigint;
  export const dlopen: any;
  export const suffix: string;
  export const JSCallback: any;
  export class CString {}
  export const ptr: any;
  export type FFIType = any;
  export const FFIType: any;
  export const toArrayBuffer: any;
}

declare const Bun: any;
