import dotenv from "dotenv";
import { z } from "zod";
import type { EntitySetDefinition } from '../tools/registry.js';
import apiConfigJson from './api-config.json' with { type: 'json' };

// Load .env file into process.env on import
dotenv.config();

/**
 * Zod schema for the application configuration.
 *
 * - SAP_DESTINATION_NAME is required (must be non-empty).
 * - All other variables have sensible defaults.
 * - ENABLED_API_CATEGORIES is stored as raw string here; the parsed
 *   array is derived in loadConfig().
 * - PORT and REQUEST_TIMEOUT are coerced from strings to numbers so
 *   that env-var strings like "4004" are accepted.
 */
const configSchema = z.object({
  sapDestinationName: z
    .string({
      required_error:
        "SAP_DESTINATION_NAME is required. Set it to the BTP Destination name pointing to your Cloud Integration tenant.",
    })
    .min(1, {
      message:
        "SAP_DESTINATION_NAME must not be empty. Set it to the BTP Destination name pointing to your Cloud Integration tenant.",
    }),

  mcpTransport: z.enum(["http", "stdio"]).default("http"),

  port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(4004),

  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),

  enabledApiCategories: z.string().default("all"),

  requestTimeout: z.coerce
    .number()
    .int()
    .positive()
    .default(60000),
});

/** Inferred type from the raw Zod schema (enabledApiCategories is still a string). */
type RawConfig = z.infer<typeof configSchema>;

/**
 * The fully-typed application configuration.
 *
 * `enabledApiCategories` is exposed as a string array (parsed from the
 * comma-separated environment variable).
 */
export interface Config extends Omit<RawConfig, "enabledApiCategories"> {
  /** Parsed list of enabled API categories (e.g. ["all"] or ["monitoring", "artifacts"]). */
  enabledApiCategories: string[];
}

/**
 * Parse a comma-separated string into a trimmed, non-empty array of strings.
 *
 * Examples:
 *   "all"                        -> ["all"]
 *   "monitoring, artifacts"      -> ["monitoring", "artifacts"]
 *   " monitoring , artifacts , " -> ["monitoring", "artifacts"]
 */
function parseCategories(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Load, validate, and return the application configuration.
 *
 * Environment variables are read from `process.env` (already populated by
 * `dotenv.config()` at module-load time).
 *
 * @throws {Error} with a descriptive message when required variables are
 *   missing or any value fails validation.
 */
export function loadConfig(): Config {
  const rawInput = {
    sapDestinationName: process.env.SAP_DESTINATION_NAME,
    mcpTransport: process.env.MCP_TRANSPORT,
    port: process.env.PORT,
    logLevel: process.env.LOG_LEVEL,
    enabledApiCategories: process.env.ENABLED_API_CATEGORIES,
    requestTimeout: process.env.REQUEST_TIMEOUT,
  };

  const result = configSchema.safeParse(rawInput);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return `  - ${path}: ${issue.message}`;
      })
      .join("\n");

    throw new Error(
      `Configuration validation failed:\n${issues}\n\nCheck your environment variables or .env file.`
    );
  }

  const validated: RawConfig = result.data;

  return {
    ...validated,
    enabledApiCategories: parseCategories(validated.enabledApiCategories),
  };
}

/**
 * Singleton config instance – created eagerly on first import so that
 * startup fails fast if the environment is misconfigured.
 */
export const config: Config = loadConfig();

// ─── API Configuration (loaded from static JSON) ────────────────────────────

/**
 * Shape of the static API configuration loaded from api-config.json.
 */
export interface ApiConfig {
  server: {
    name: string;
    version: string;
    description: string;
  };
  api: {
    pathPrefix: string;
  };
  entitySets: EntitySetDefinition[];
}

/**
 * Static API configuration — server identity, API path prefix, and all
 * entity set definitions loaded from the co-located JSON file.
 */
export const apiConfig: ApiConfig = apiConfigJson as ApiConfig;
