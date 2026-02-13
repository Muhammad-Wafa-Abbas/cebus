import { readFile } from 'fs/promises';
import { ConfigSchema } from './schema';

const ENV_KEYS = {
  OPENAI_API_KEY: 'OPENAI_API_KEY',
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  GITHUB_TOKEN: 'GITHUB_TOKEN',
  OPENAI_BASE_URL: 'OPENAI_BASE_URL',
  ANTHROPIC_BASE_URL: 'ANTHROPIC_BASE_URL',
} as const;

export interface ProviderConfig {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  timeout?: number | undefined;
}

export interface AppConfig {
  providers: {
    openai?: ProviderConfig | undefined;
    anthropic?: ProviderConfig | undefined;
    copilot?: ProviderConfig | undefined;
  };
  defaults: {
    maxTokens: number;
    temperature: number;
  };
}

const DEFAULT_CONFIG: AppConfig = {
  providers: {},
  defaults: {
    maxTokens: 4096,
    temperature: 0.7,
  },
};

function loadFromEnv(): Partial<AppConfig> {
  const config: Partial<AppConfig> = {
    providers: {},
  };

  const openaiKey = process.env[ENV_KEYS.OPENAI_API_KEY];
  if (openaiKey) {
    config.providers!.openai = {
      apiKey: openaiKey,
      baseUrl: process.env[ENV_KEYS.OPENAI_BASE_URL],
    };
  }

  const anthropicKey = process.env[ENV_KEYS.ANTHROPIC_API_KEY];
  if (anthropicKey) {
    config.providers!.anthropic = {
      apiKey: anthropicKey,
      baseUrl: process.env[ENV_KEYS.ANTHROPIC_BASE_URL],
    };
  }

  const githubToken = process.env[ENV_KEYS.GITHUB_TOKEN];
  if (githubToken) {
    config.providers!.copilot = {
      apiKey: githubToken,
    };
  }

  return config;
}

async function loadFromFile(filePath: string): Promise<Partial<AppConfig>> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as Partial<AppConfig>;
  } catch {
    // Expected: optional config file may not exist or may be malformed
    return {};
  }
}

function mergeConfigs(...configs: Partial<AppConfig>[]): AppConfig {
  const result: AppConfig = { ...DEFAULT_CONFIG };

  for (const config of configs) {
    if (config.providers) {
      result.providers = {
        ...result.providers,
        ...config.providers,
      };

      for (const key of ['openai', 'anthropic', 'copilot'] as const) {
        if (config.providers[key]) {
          result.providers[key] = {
            ...result.providers[key],
            ...config.providers[key],
          };
        }
      }
    }

    if (config.defaults) {
      result.defaults = {
        ...result.defaults,
        ...config.defaults,
      };
    }
  }

  return result;
}

let cachedConfig: AppConfig | null = null;

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const envConfig = loadFromEnv();
  const fileConfig = configPath ? await loadFromFile(configPath) : {};

  const merged = mergeConfigs(DEFAULT_CONFIG, fileConfig, envConfig);

  const validatedPartial = ConfigSchema.safeParse({
    providers: merged.providers,
    defaults: merged.defaults,
  });

  if (!validatedPartial.success) {
    console.warn('Config validation warnings:', validatedPartial.error.issues);
  }

  cachedConfig = merged;
  return merged;
}

export function getConfig(): AppConfig | null {
  return cachedConfig;
}

export * from './schema';
