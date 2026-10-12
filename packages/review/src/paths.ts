/**
 * Path-only classifiers behind the risk tags. Every rule here is documented
 * in library/api.md ("Risk rules"); keep the two in sync.
 */

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirSegments(path: string): string[] {
  return path.split('/').slice(0, -1);
}

function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// ci-config
// ---------------------------------------------------------------------------

const CI_DIRS = ['.github/', '.kvarm/', '.circleci/', '.buildkite/', '.gitlab/', '.azure-pipelines/', '.husky/'];
const CI_FILES = new Set([
  '.gitlab-ci.yml',
  '.travis.yml',
  'jenkinsfile',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  '.drone.yml',
  'appveyor.yml',
  'cloudbuild.yaml',
  'cloudbuild.yml',
  'buildspec.yml',
  'makefile',
  'gnumakefile',
  '.pre-commit-config.yaml',
]);

export function isCiConfigPath(path: string): boolean {
  if (CI_DIRS.some((d) => path.startsWith(d))) return true;
  const name = basename(path).toLowerCase();
  if (CI_FILES.has(name)) return true;
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return true;
  return /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(name);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__test__', 'spec', 'specs', 'e2e']);
const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[^./]+$/,
  /_test\.(go|py|rb|exs?)$/,
  /^test_[^/]*\.py$/,
  /_spec\.rb$/,
  /(Test|Tests|IT)\.(java|kt|cs|scala)$/,
];

export function isTestPath(path: string): boolean {
  const name = basename(path);
  if (TEST_FILE_PATTERNS.some((re) => re.test(name))) return true;
  return isCodePath(path) && dirSegments(path).some((d) => TEST_DIRS.has(d.toLowerCase()));
}

// ---------------------------------------------------------------------------
// lockfiles and manifests
// ---------------------------------------------------------------------------

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'go.sum',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'gemfile.lock',
  'composer.lock',
  'flake.lock',
  'packages.lock.json',
  'gradle.lockfile',
  'mix.lock',
  'pubspec.lock',
  'podfile.lock',
]);

export function isLockfilePath(path: string): boolean {
  return LOCKFILES.has(basename(path).toLowerCase());
}

export type ManifestKind = 'npm' | 'requirements' | 'go' | 'cargo' | 'pyproject';

export function manifestKind(path: string): ManifestKind | null {
  const name = basename(path);
  if (name === 'package.json') return 'npm';
  if (name === 'go.mod') return 'go';
  if (name === 'Cargo.toml') return 'cargo';
  if (name === 'pyproject.toml') return 'pyproject';
  if (/^requirements[\w.-]*\.(txt|in)$/.test(name)) return 'requirements';
  if (dirSegments(path).at(-1) === 'requirements' && /\.(txt|in)$/.test(name)) return 'requirements';
  return null;
}

// ---------------------------------------------------------------------------
// generated
// ---------------------------------------------------------------------------

const GENERATED_DIRS = new Set(['generated', '__generated__']);
const GENERATED_FILE_PATTERNS = [
  /\.(gen|generated)\.[^./]+$/,
  /_generated\.[^./]+$/,
  /\.pb\.(go|cc|h)$/,
  /_pb2(_grpc)?\.pyi?$/,
  /\.min\.(js|css)$/,
  /\.g\.dart$/,
  /\.designer\.cs$/i,
];

export function isGeneratedPath(path: string): boolean {
  if (dirSegments(path).some((d) => GENERATED_DIRS.has(d))) return true;
  const name = basename(path);
  return GENERATED_FILE_PATTERNS.some((re) => re.test(name));
}

// ---------------------------------------------------------------------------
// security-sensitive
// ---------------------------------------------------------------------------

const SENSITIVE_TOKENS = new Set([
  'auth',
  'authn',
  'authz',
  'oauth',
  'oidc',
  'saml',
  'sso',
  'login',
  'session',
  'sessions',
  'crypto',
  'cryptography',
  'secret',
  'secrets',
  'security',
  'password',
  'passwords',
  'credential',
  'credentials',
  'permission',
  'permissions',
  'acl',
  'rbac',
  'jwt',
  'token',
  'tokens',
  'keys',
  'keychain',
  'cert',
  'certs',
  'certificate',
  'certificates',
  'tls',
  'ssl',
  'signing',
  'encryption',
  'csrf',
]);
const SENSITIVE_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'jks', 'keystore']);
const SENSITIVE_FILES = new Set(['codeowners', '.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ed25519', 'id_ecdsa']);

/** Path words: segments split on camelCase and non-alphanumerics, lowercased. */
function pathTokens(path: string): string[] {
  return path
    .split('/')
    .flatMap((seg) => seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/))
    .filter(Boolean);
}

export function isSecuritySensitivePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (SENSITIVE_FILES.has(name) || name === '.env' || name.startsWith('.env.')) return true;
  if (SENSITIVE_EXTENSIONS.has(extension(path))) return true;
  return pathTokens(path).some((t) => SENSITIVE_TOKENS.has(t));
}

// ---------------------------------------------------------------------------
// code
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy', 'rb', 'php', 'cs', 'fs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'swift', 'dart',
  'sh', 'bash', 'zsh', 'ps1', 'sql', 'lua', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj',
  'sol', 'zig', 'nim', 'r', 'jl', 'pl', 'pm', 'tf', 'hcl',
]);

/** Source code by extension; prose, data and config files are not code. */
export function isCodePath(path: string): boolean {
  return CODE_EXTENSIONS.has(extension(path));
}
