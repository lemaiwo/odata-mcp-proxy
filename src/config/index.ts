import dotenv from "dotenv";
import { z } from "zod";
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import type { EntitySetDefinition } from '../tools/registry.js';

// Load .env file into process.env on import
dotenv.config();

/**
 * Zod schema for the application configuration.
 *
 * - All variables have sensible defaults.
 * - ENABLED_API_CATEGORIES is stored as raw string here; the parsed
 *   array is derived in loadConfig().
 * - PORT and REQUEST_TIMEOUT are coerced from strings to numbers so
 *   that env-var strings like "4004" are accepted.
 */
const configSchema = z.object({
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

  apiConfigFile: z.string().default('api-config.json'),
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
 * @throws {Error} with a descriptive message when any value fails validation.
 */
export function loadConfig(): Config {
  const rawInput = {
    mcpTransport: process.env.MCP_TRANSPORT,
    port: process.env.PORT,
    logLevel: process.env.LOG_LEVEL,
    enabledApiCategories: process.env.ENABLED_API_CATEGORIES,
    requestTimeout: process.env.REQUEST_TIMEOUT,
    apiConfigFile: process.env.API_CONFIG_FILE,
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
 * A single API backend: its BTP destination name, OData path prefix,
 * and the entity sets it exposes.
 */
export interface ApiDefinition {
  /** Logical name for this API (used for logging). */
  name: string;
  /** BTP Destination name (or local env var prefix) used to authenticate requests. */
  destination: string;
  /** OData path prefix, e.g. "/api/v1". */
  pathPrefix: string;
  /** Entity sets exposed by this API. */
  entitySets: EntitySetDefinition[];
  /**
   * Whether mutating requests require a CSRF token (default: true).
   * Set to false for REST APIs that do not use SAP OData CSRF protection.
   */
  csrfProtected?: boolean;
}

/**
 * Shape of the static API configuration loaded from api-config.json.
 */
export interface ApiConfig {
  server: {
    name: string;
    version: string;
    description: string;
  };
  /** One entry per backend API. Each has its own destination, path prefix, and entity sets. */
  apis: ApiDefinition[];
}

/**
 * Load API configuration from a JSON file.
 * Relative filenames are resolved against this module's directory (src/config/).
 */
function loadApiConfig(filename: string): ApiConfig {
  const configDir = dirname(fileURLToPath(import.meta.url));
  const filePath = isAbsolute(filename) ? filename : join(configDir, filename);
  return JSON.parse(readFileSync(filePath, 'utf-8')) as ApiConfig;
}

/**
 * API configuration — server identity and all API definitions.
 * Loaded from the file specified by `API_CONFIG_FILE` (default: api-config.json).
 */
export const apiConfig: ApiConfig = loadApiConfig(config.apiConfigFile);
