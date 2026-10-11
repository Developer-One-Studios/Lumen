import type { ToolDefinition } from '../definitions.js';
import type { RobloxStudioTools } from '../index.js';

export type ForkToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

export type ForkHandler = (
  tools: RobloxStudioTools,
  body: Record<string, unknown>,
  context?: { signal?: AbortSignal },
) => Promise<ForkToolResult>;

// One self-contained fork feature: its tools, their handlers, and the guidance agents read.
export interface ForkFeature {
  name: string;
  definitions: ToolDefinition[];
  handlers: Record<string, ForkHandler>;
  /** Tools that never route to a Studio peer, so they carry no instance_id. */
  studioAgnostic?: string[];
  /** Added to the server instructions when every named tool is exposed. */
  instructions?: Array<{ tools: string[]; text: string }>;
  /** A Markdown section (starting with "## ") appended to lumen://tool-guides. */
  guide?: string;
}
