// src/types/qrcode.d.ts — the types the `qrcode` package does not ship.
//
// WHY THIS FILE EXISTS. src/lib/qr.ts generates the verification square printed on every offer
// letter, on our own server, precisely so the token in that URL never reaches a third party. The
// package it uses publishes JavaScript with no declarations, and there is no @types/qrcode in this
// project's dependency tree, so the whole module resolved to an implicit any.
//
// WHY IT DECLARES REAL SIGNATURES RATHER THAN `declare module 'qrcode';`. The bare form silences
// the error by making every call untyped — including a misspelt option name. A QR built with a
// mistyped `errorCorrectionLevel` still renders; it renders at the DEFAULT level, on a document
// that gets printed and archived, and nothing says so. So the two functions this codebase calls are
// declared for what they actually are (see node_modules/qrcode/lib/server.js). Anything else stays
// undeclared on purpose: adding a call means adding its signature here first, which is a moment to
// check the option names against the package rather than guess them.
//
// If @types/qrcode is ever installed, DELETE THIS FILE in the same change — two declarations of the
// same module is a duplicate-identifier error, not a merge.

declare module 'qrcode' {
  /** Long form and short form both accepted by the encoder. */
  export type QRCodeErrorCorrectionLevel =
    | 'low' | 'medium' | 'quartile' | 'high'
    | 'L' | 'M' | 'Q' | 'H';

  export interface QRCodeOptions {
    /** 1-40. Omit to let the encoder pick the smallest version that fits. */
    version?: number;
    errorCorrectionLevel?: QRCodeErrorCorrectionLevel;
    maskPattern?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  }

  export interface QRCodeRenderOptions extends QRCodeOptions {
    /** Quiet-zone width, in modules. */
    margin?: number;
    scale?: number;
    /** Rendered edge length in px. */
    width?: number;
    color?: { dark?: string; light?: string };
  }

  export interface QRCodeToStringOptions extends QRCodeRenderOptions {
    type?: 'utf8' | 'svg' | 'terminal';
  }

  export interface QRCodeToDataURLOptions extends QRCodeRenderOptions {
    type?: 'image/png' | 'image/jpeg' | 'image/webp';
    rendererOpts?: { quality?: number };
  }

  /** Resolves to the rendered string — SVG markup when `type` is 'svg'. Rejects on encode failure. */
  export function toString(text: string, options?: QRCodeToStringOptions): Promise<string>;

  /** Resolves to a data: URI. Rejects on encode failure. */
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;

  /** The CommonJS module object, which is what `import QRCode from 'qrcode'` binds to. */
  const QRCode: {
    toString: typeof toString;
    toDataURL: typeof toDataURL;
  };
  export default QRCode;
}
