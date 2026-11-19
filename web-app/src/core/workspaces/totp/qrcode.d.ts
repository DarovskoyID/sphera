// The module ships `qrcode` as a runtime dependency; its own types are a dev
// dependency, and module builds install production deps only. This is all of
// the API the module uses.
declare module 'qrcode' {
  export function toDataURL(
    text: string,
    options?: { margin?: number; width?: number; errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' },
  ): Promise<string>;
}
