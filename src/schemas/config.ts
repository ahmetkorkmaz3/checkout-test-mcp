import { z } from 'zod';

const HostPattern = z
  .string()
  .min(1)
  .regex(
    /^(\*\.)?[a-z0-9.-]+$|^\[::1\]$/i,
    'Use a host name like "staging.shop.test" or "*.shop.test", without scheme or port.',
  );

/** Settings for inspect_target. Every field has a default, so an empty block is valid. */
export const InspectConfig = z
  .object({
    /** Read-only source folders for the code scan. Relative to the config folder. */
    source_dirs: z.array(z.string()).default([]),
    start_paths: z.array(z.string().startsWith('/')).min(1).default(['/']),
    product_paths: z.array(z.string().startsWith('/')).default([]),
    max_pages: z.number().int().min(1).max(100).default(25),
    /** The probe may click add-to-cart and the checkout button. It never clicks a pay button. */
    probe_checkout: z.boolean().default(false),
    // Task 7 narrows the keys to WordKind.
    words: z.record(z.string(), z.array(z.string())).default({}),
  })
  .strict();
export type InspectConfig = z.infer<typeof InspectConfig>;

export const AuthoringConfig = z
  .object({
    /** Where save_scenario writes. Must be inside one of scenario_dirs. */
    dir: z.string().min(1),
    /** save_scenario never writes test data in v1. */
    test_data_dir_writable: z.boolean().default(false),
  })
  .strict();
export type AuthoringConfig = z.infer<typeof AuthoringConfig>;

export const TargetConfig = z
  .object({
    description: z.string().default(''),
    profile: z.string().min(1),
    base_url: z.url(),
    allowed_hosts: z.array(HostPattern).min(1),
    third_party_hosts: z.array(HostPattern).default([]),
    allow_unlabeled_host: z.boolean().default(false),
    test_id_attribute: z.string().default('data-testid'),
    /** Scenario secret name -> environment variable name. */
    secrets: z
      .record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string().regex(/^[A-Z][A-Z0-9_]*$/))
      .default({}),
    http_credentials: z.object({ username_secret: z.string(), password_secret: z.string() }).optional(),
    locale: z.string().optional(),
    inspect: InspectConfig.optional(),
  })
  .strict();
export type TargetConfig = z.infer<typeof TargetConfig>;

export const ServerConfig = z
  .object({
    runs_dir: z.string().default('.checkout-test-mcp/runs'),
    max_parallel_runs: z.number().int().min(1).max(4).default(1),
    max_queued_runs: z.number().int().min(1).max(100).default(20),
    scenario_dirs: z.array(z.string()).min(1).default(['./scenarios']),
    test_data_dir: z.string().default('./test-data'),
    headless: z.boolean().default(true),
    targets: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), TargetConfig),
    production_hosts: z.array(HostPattern).default([]),
    authoring: AuthoringConfig.optional(),
  })
  .strict();
export type ServerConfig = z.infer<typeof ServerConfig>;

/** Config after load: paths are absolute. */
export interface ResolvedConfig extends ServerConfig {
  config_dir: string;
}
