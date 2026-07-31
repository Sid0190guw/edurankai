// src/lib/qr.ts — QR codes generated on our own server.
//
// The offer letter rendered a literal "QR" placeholder: nothing ever generated one, so the
// verification square on every issued offer was decorative. Scanning it did nothing.
//
// Generated locally rather than via an image URL from a QR service. Three reasons, in order of how
// much they matter here:
//   1. An offer letter is printed and archived. A remote image is a dead box the moment that
//      service changes, rate-limits, or disappears — on a document people keep for years.
//   2. The URL contains the offer's verification token. Handing that to a third party on every
//      render leaks who was hired and when.
//   3. It has to work with no network, which is how these get viewed as often as not.
//
// Returns an inline SVG string, so it embeds directly in HTML and prints at any size without
// blurring, unlike a raster data URI.
import QRCode from 'qrcode';

export interface QrOptions {
  /** Rendered edge length in px. The SVG scales, so this is a default rather than a limit. */
  size?: number;
  /**
   * Error-correction level. 'M' is the sensible default for a printed document: it survives a fold,
   * a staple or a coffee ring, without inflating the module count the way 'H' does.
   */
  level?: 'L' | 'M' | 'Q' | 'H';
  margin?: number;
}

/**
 * An inline SVG QR for `text`.
 *
 * Never throws: a failure here must not take down an offer letter. The caller gets null and shows
 * the plain verification URL, which is the real fallback — the link works whether or not the square
 * renders.
 */
export async function qrSvg(text: string, opts: QrOptions = {}): Promise<string | null> {
  const value = (text || '').trim();
  if (!value) return null;
  try {
    const svg = await QRCode.toString(value, {
      type: 'svg',
      errorCorrectionLevel: opts.level || 'M',
      margin: opts.margin ?? 1,
      width: opts.size || 128,
      color: { dark: '#111111', light: '#ffffff' },
    });
    // Strip the XML prolog so the result can be dropped straight into HTML.
    return svg.replace(/<\?xml[^>]*\?>\s*/i, '');
  } catch {
    return null;
  }
}

/** A data URI, for the cases where an <img src> is needed rather than inline markup. */
export async function qrDataUri(text: string, opts: QrOptions = {}): Promise<string | null> {
  const value = (text || '').trim();
  if (!value) return null;
  try {
    return await QRCode.toDataURL(value, {
      errorCorrectionLevel: opts.level || 'M',
      margin: opts.margin ?? 1,
      width: opts.size || 256,
      color: { dark: '#111111', light: '#ffffff' },
    });
  } catch {
    return null;
  }
}
