import { nativeImage } from 'electron'

/**
 * Draws detection boxes onto an image in the main process.
 *
 * There is no canvas here, so the image is decoded to its raw BGRA bitmap
 * (`nativeImage`), written into directly, and re-encoded as PNG. The output
 * stays a PNG data URL because every consumer — the chat card, the gallery
 * extractor, the Home Agent channel shipper — treats it as a photo; an SVG
 * would render in the app and be rejected by Telegram.
 *
 * Labels are drawn from a 5x7 bitmap font rather than a system font: main has
 * no text shaper, and a glyph table is both dependency-free and deterministic.
 */

export type Detection = {
  label: string
  /** `[x1, y1, x2, y2]` in the model's 0–1000 coordinate space. */
  location: number[]
}

/** Classic 5x7 ASCII font, five column bytes per glyph, bit 0 = top row. */
const FONT_5X7 = [
  '0000000000',
  '00005f0000',
  '0007000700',
  '147f147f14',
  '242a7f2a12',
  '2313086462',
  '3649552250',
  '0005030000',
  '001c224100',
  '0041221c00',
  '14083e0814',
  '08083e0808',
  '0050300000',
  '0808080808',
  '0060600000',
  '2010080402',
  '3e5149453e',
  '00427f4000',
  '4261514946',
  '2141454b31',
  '1814127f10',
  '2745454539',
  '3c4a494930',
  '0171090503',
  '3649494936',
  '064949291e',
  '0036360000',
  '0056360000',
  '0814224100',
  '1414141414',
  '0041221408',
  '0201510906',
  '324979413e',
  '7e1111117e',
  '7f49494936',
  '3e41414122',
  '7f4141221c',
  '7f49494941',
  '7f09090901',
  '3e4149497a',
  '7f0808087f',
  '00417f4100',
  '2040413f01',
  '7f08142241',
  '7f40404040',
  '7f020c027f',
  '7f0408107f',
  '3e4141413e',
  '7f09090906',
  '3e4151215e',
  '7f09192946',
  '4649494931',
  '01017f0101',
  '3f4040403f',
  '1f2040201f',
  '3f4038403f',
  '6314081463',
  '0708700807',
  '6151494543',
  '007f414100',
  '0204081020',
  '0041417f00',
  '0402010204',
  '4040404040',
  '0001020400',
  '2054545478',
  '7f48444438',
  '3844444420',
  '384444487f',
  '3854545418',
  '087e090102',
  '0c5252523e',
  '7f08040478',
  '00447d4000',
  '2040443d00',
  '7f10284400',
  '00417f4000',
  '7c04180478',
  '7c08040478',
  '3844444438',
  '7c14141408',
  '0814141721',
  '7c08040408',
  '4854545420',
  '043f444020',
  '3c4040207c',
  '1c2040201c',
  '3c4030403c',
  '4428102844',
  '0c5050503c',
  '4464544c44',
  '0008364100',
  '00007f0000',
  '0041360800',
  '08082a1c08',
]

const GLYPH_WIDTH = 5
const GLYPH_HEIGHT = 7
const GLYPH_SPACING = 1

function glyphColumns(char: string): number[] {
  const index = char.charCodeAt(0) - 32
  const hex = FONT_5X7[index >= 0 && index < FONT_5X7.length ? index : '?'.charCodeAt(0) - 32]
  const columns: number[] = []
  for (let i = 0; i < GLYPH_WIDTH; i++) {
    columns.push(parseInt(hex.slice(i * 2, i * 2 + 2), 16))
  }
  return columns
}

export function textWidth(text: string, scale: number): number {
  if (!text) return 0
  return (text.length * (GLYPH_WIDTH + GLYPH_SPACING) - GLYPH_SPACING) * scale
}

type Rgb = [number, number, number]

const BOX_COLOR: Rgb = [0, 255, 0]
const LABEL_TEXT_COLOR: Rgb = [0, 0, 0]

type Surface = { data: Buffer; width: number; height: number }

function setPixel(surface: Surface, x: number, y: number, color: Rgb): void {
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return
  const offset = (y * surface.width + x) * 4
  // nativeImage bitmaps are BGRA on every platform.
  surface.data[offset] = color[2]
  surface.data[offset + 1] = color[1]
  surface.data[offset + 2] = color[0]
  surface.data[offset + 3] = 255
}

function fillRect(
  surface: Surface,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Rgb,
): void {
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) setPixel(surface, x + dx, y + dy, color)
  }
}

function strokeRect(
  surface: Surface,
  x: number,
  y: number,
  width: number,
  height: number,
  thickness: number,
  color: Rgb,
): void {
  fillRect(surface, x, y, width, thickness, color)
  fillRect(surface, x, y + height - thickness, width, thickness, color)
  fillRect(surface, x, y, thickness, height, color)
  fillRect(surface, x + width - thickness, y, thickness, height, color)
}

function drawText(
  surface: Surface,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: Rgb,
): void {
  let cursor = x
  for (const char of text) {
    const columns = glyphColumns(char)
    for (let col = 0; col < GLYPH_WIDTH; col++) {
      for (let row = 0; row < GLYPH_HEIGHT; row++) {
        if (!(columns[col] & (1 << row))) continue
        fillRect(surface, cursor + col * scale, y + row * scale, scale, scale, color)
      }
    }
    cursor += (GLYPH_WIDTH + GLYPH_SPACING) * scale
  }
}

/**
 * Returns a PNG data URL of `imageDataUri` with one labelled box per detection.
 * Detection coordinates are relative (0–1000) and are clamped to the image.
 */
export function drawDetections(imageDataUri: string, detections: Detection[]): string {
  const source = nativeImage.createFromDataURL(imageDataUri)
  if (source.isEmpty()) {
    throw new Error('The attached image could not be decoded.')
  }
  const { width, height } = source.getSize()
  const surface: Surface = { data: Buffer.from(source.toBitmap()), width, height }

  // Same proportions the canvas version used, rounded to whole font pixels so
  // glyphs stay sharp.
  const fontSize = Math.max(12, Math.min(width, height) / 40)
  const scale = Math.max(1, Math.round(fontSize / GLYPH_HEIGHT))
  const thickness = Math.max(2, Math.round(scale * 0.75))
  const padding = Math.max(2, scale)

  for (const detection of detections) {
    const [rx1, ry1, rx2, ry2] = detection.location
    const clamp = (value: number, max: number) => Math.max(0, Math.min(Math.round(value), max))
    const x1 = clamp((rx1 / 1000) * width, width)
    const y1 = clamp((ry1 / 1000) * height, height)
    const x2 = clamp((rx2 / 1000) * width, width)
    const y2 = clamp((ry2 / 1000) * height, height)
    const boxWidth = Math.max(thickness, x2 - x1)
    const boxHeight = Math.max(thickness, y2 - y1)
    strokeRect(surface, x1, y1, boxWidth, boxHeight, thickness, BOX_COLOR)

    const label = detection.label
    const labelWidth = textWidth(label, scale) + padding * 2
    const labelHeight = GLYPH_HEIGHT * scale + padding * 2
    // Inside the box's top-left, so a detection at the image edge keeps its label.
    const labelX = Math.min(x1 + thickness, Math.max(0, width - labelWidth))
    const labelY = Math.min(y1 + thickness, Math.max(0, height - labelHeight))
    fillRect(surface, labelX, labelY, labelWidth, labelHeight, BOX_COLOR)
    drawText(surface, label, labelX + padding, labelY + padding, scale, LABEL_TEXT_COLOR)
  }

  const annotated = nativeImage.createFromBitmap(surface.data, { width, height })
  return `data:image/png;base64,${annotated.toPNG().toString('base64')}`
}
