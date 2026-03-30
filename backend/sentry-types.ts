/*
 * The following is all reverse-engineered from how the Sentry Node SDK behaves.
 * This is almost certainly a subset of what is actually supported, but its enough
 * for the purposes of bun.report
 */

export type NodeEnv = "production" | "development";

/** example: "2024-05-01T23:33:44.598Z" */
export type DateString = string;

export type Payload = [PayloadHeader, { type: "event" }, PayloadEvent];

export type ArchString = "arm64" | "x64";

export interface PayloadHeader {
  /** 32-char hex string */
  event_id: string;
  sent_at: DateString;
  sdk: { name: string; version: string };
  trace: {
    environment: NodeEnv;
    public_key: string;
  };
}

export interface PayloadEvent {
  exception: {
    values: PayloadException[];
  };
  event_id: string;
  /** node integration sets this to "node" */
  platform: string;
  release: string;
  level: "fatal" | "error" | "warning" | "info" | "debug";
  transaction?: string;
  tags: any;
  contexts: PayloadEventContexts;
  server_name?: string;
  /** seconds */
  timestamp: number;
  environment: NodeEnv;
  sdk: {
    integrations: string[];
    name: string;
    version: string;
    packages: PayloadEventPackage[];
  };
}

export interface PayloadEventContexts {
  trace?: {
    /** 32-char hex string */
    trace_id?: string;
    /** 16-char hex string */
    span_id?: string;
  };
  runtime: {
    name: string;
    version: string;
  };
  os: OS;
  device: {
    boot_time?: DateString;
    arch: string;
    memory_size?: number;
    free_memory?: number;
    processor_count?: number;
    cpu_description?: string;
    processor_frequency?: number;
  };
  culture?: {
    locale: string;
    timezone: string;
  };
  cloud_resource?: {};
}

export interface OS {
  kernel_version?: string;
  name: "macOS" | "Linux" | "Windows";
  version?: string;
  build?: string;
}

export interface PayloadException {
  /** example: "ReferenceError" */
  type: string;
  /** example: "foo is not defined" */
  value: string;
  stacktrace: StackTrace;
  mechanism: {
    type: "generic";
    handled: boolean;
  };
}

export interface StackTrace {
  frames: StackTraceFrame[];
}

export interface StackTraceFrame {
  filename?: string;
  package: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
  pre_context?: string[];
  context_line?: string;
  post_context?: string[];
  source_link?: string;
  instruction_addr?: string;
}

export interface PayloadEventPackage {
  name: string;
  version: string;
}
