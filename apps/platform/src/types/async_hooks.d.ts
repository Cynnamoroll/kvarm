// Minimal declaration for the nodejs_compat AsyncLocalStorage; the platform
// tsconfig deliberately excludes @types/node.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, fn: () => R): R;
  }
}
