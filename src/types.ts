export interface ToolDef {
  name: string
  description?: string
  inputSchema?: JsonSchema
  outputSchema?: JsonSchema
  annotations?: Record<string, unknown>
  title?: string
}

export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema | JsonSchema[]
  enum?: unknown[]
  const?: unknown
  description?: string
  additionalProperties?: boolean | JsonSchema
  [k: string]: unknown
}

/** One MCP server as found in a host config file (or given on the CLI). */
export interface ServerSpec {
  name: string
  kind: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  /** Which config files declared this server (a server can appear in several). */
  sources: string[]
  /** Set when the entry cannot be launched (e.g. it needs interactive input). */
  unlaunchable?: string
}

/** The token weight of a single tool definition, as the host serialises it. */
export interface ToolWeight {
  name: string
  /** Whole definition: name + description + inputSchema. */
  tokens: number
  descriptionTokens: number
  schemaTokens: number
}

export interface ServerWeight {
  spec: ServerSpec
  ok: boolean
  /** Why the measurement failed, when it did. */
  error?: string
  connectMs?: number
  serverInfo?: { name?: string; version?: string } | null
  protocolVersion?: string | null
  tools: ToolWeight[]
  toolCount: number
  resourceCount: number
  promptCount: number
  /** Sum of all tool-definition tokens: the per-request tax this server charges. */
  toolTokens: number
  /** Tokens in the server's `instructions` string, which hosts also inject. */
  instructionTokens: number
  /** toolTokens + instructionTokens. */
  taxTokens: number
  /** 'estimate' (chars-based) or 'counted' (Anthropic count_tokens). */
  method: 'estimate' | 'counted'
}

export interface XrayOptions {
  timeoutMs: number
  /** Use the Anthropic count_tokens API when a key is available. */
  precise: boolean
  apiKey?: string
  /** Assumed requests per day for the cost projection. */
  requestsPerDay: number
  /** $ per million input tokens for the cost projection. */
  pricePerMTok: number
  /** How many tools to show per server in the report. */
  top: number
  concurrency: number
}

export interface XrayReport {
  servers: ServerWeight[]
  /** Sum of taxTokens across servers that measured OK. */
  totalTaxTokens: number
  method: 'estimate' | 'counted' | 'mixed'
  options: Pick<XrayOptions, 'requestsPerDay' | 'pricePerMTok'>
  configsSearched: string[]
  durationMs: number
}
