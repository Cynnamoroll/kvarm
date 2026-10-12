export type LicenseClass = 'permissive' | 'weak-copyleft' | 'copyleft' | 'restrictive' | 'unknown';

export interface Dependency {
  name: string;
  version: string;
  license: string;
  scope: 'runtime' | 'runtime (optional)' | 'development';
  class: LicenseClass;
  path: string;
}

export interface WorkspacePackage {
  name: string;
  path: string;
  license: string;
}

export function classifyLicense(expression: string | undefined | null): LicenseClass;
export function collectDependencies(lock: Record<string, any>): Dependency[];
export function collectWorkspaces(lock: Record<string, any>): WorkspacePackage[];
export function renderLicenseReport(lock: Record<string, any>): string;
