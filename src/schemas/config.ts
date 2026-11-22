import { z } from 'zod';

const HostPattern = z
  .string()
  .min(1)
  .regex(
    /^(\*\.)?[a-z0-9.-]+$|^\[::1\]$/i,
    'Use a host name like "staging.shop.test" or "*.shop.test", without scheme or port.',
  );

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
  })
  .strict();
export type ServerConfig = z.infer<typeof ServerConfig>;

/** Config after load: paths are absolute. */
export interface ResolvedConfig extends ServerConfig {
  config_dir: string;
}
