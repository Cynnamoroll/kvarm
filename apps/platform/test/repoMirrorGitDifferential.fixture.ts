export interface GitDifferentialState {
  v0: string;
  v2: string;
  lsRefs: string[];
}

export interface GitDifferentialFixture {
  empty: GitDifferentialState;
  full: GitDifferentialState[];
  updates: Array<{ ref: string; oldOid: string; newOid: string }>;
}

export const fixture: GitDifferentialFixture | null = null;
