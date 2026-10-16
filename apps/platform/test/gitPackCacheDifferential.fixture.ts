export interface GitPackCacheDifferentialCase {
  name: 'full' | 'shallow' | 'blobless';
  request: string;
  response: string;
}

export interface GitPackCacheDifferentialFixture {
  cases: GitPackCacheDifferentialCase[];
}

export const fixture: GitPackCacheDifferentialFixture | null = null;
