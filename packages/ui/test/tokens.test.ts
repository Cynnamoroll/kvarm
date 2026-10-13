import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourcePath = fileURLToPath(new URL('../src/tokens.css', import.meta.url));
const publicPath = fileURLToPath(new URL('../../../apps/platform/public/assets/tokens.css', import.meta.url));

function cssHex(css: string, name: string): string {
  const value = css.match(new RegExp(`--${name}:\\s*(#[\\da-fA-F]{6})\\s*;`))?.[1];
  if (!value) throw new Error(`Missing hex token --${name}`);
  return value;
}

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g);
  if (!channels) throw new Error(`Invalid hex color: ${hex}`);
  const [red, green, blue] = channels.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  if (lighter === undefined || darker === undefined) throw new Error('Invalid contrast colors');
  return (lighter + 0.05) / (darker + 0.05);
}

describe('brand tokens', () => {
  it('keeps the Worker-served tokens byte-identical to the package source', async () => {
    const [source, served] = await Promise.all([readFile(sourcePath), readFile(publicPath)]);
    expect(served.equals(source)).toBe(true);
  });

  it('meets WCAG 2.x AA contrast against the dark surfaces', async () => {
    const css = await readFile(sourcePath, 'utf8');
    const foregrounds = ['bone', 'silver', 'steel', 'signal-hi', 'heat-3', 'heat-4'];
    const backgrounds = ['void', 'carbon', 'graphite'];

    for (const foreground of foregrounds) {
      for (const background of backgrounds) {
        const ratio = contrastRatio(cssHex(css, foreground), cssHex(css, background));
        expect(ratio, `--${foreground} on --${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps primary-button white text at WCAG 2.x AA contrast on --signal', async () => {
    const css = await readFile(sourcePath, 'utf8');
    expect(contrastRatio('#ffffff', cssHex(css, 'signal'))).toBeGreaterThanOrEqual(4.5);
  });
});
