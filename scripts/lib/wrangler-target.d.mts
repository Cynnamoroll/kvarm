export const PLACEHOLDER_D1_DATABASE_ID: string;

export const SETTINGS: string[];

export const WRANGLER_TARGET: string;

export function remoteD1Args(sql: string): string[];

export function parseJsonc(text: string): unknown;

export function parseEnvFile(text: string): Record<string, string>;

export function resolveSettings(
  processEnv: Record<string, string | undefined>,
  fileEnv: Record<string, string | undefined>,
): Record<string, string>;

export function targetConfig(base: unknown, settings: Record<string, string | undefined>, opts: { requireOrigin: boolean }): unknown;
