import type { IncomingMessage, ServerResponse } from 'node:http';

export function forwardGitRequest(
  req: IncomingMessage,
  res: ServerResponse,
  target: string,
  options?: { path?: string; authorization?: string | null; onResponse?: (response: IncomingMessage) => void },
): ReturnType<typeof import('node:http').request>;
