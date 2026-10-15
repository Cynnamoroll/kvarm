/**
 * The instance-type → container instance mapping shared by the container
 * Durable Objects: `basic` is the smallest standard runner, every other
 * instance is already a runner name (services/environments validates the
 * same union), so the cast lives here and only here.
 */
export function instanceName(instance: string): 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4' {
  return instance === 'basic' ? 'standard-1' : (instance as 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4');
}
