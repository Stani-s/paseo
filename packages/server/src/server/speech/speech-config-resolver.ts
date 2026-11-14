import { z } from "zod";

import type { PersistedConfig } from "../persisted-config.js";
import type { PaseoOpenAIConfig, PaseoSpeechConfig } from "../bootstrap.js";
import { resolveLocalSpeechConfig } from "./providers/local/config.js";
import { resolveOpenAiSpeechConfig } from "./providers/openai/config.js";
import {
  SpeechProviderIdSchema,
  type RequestedSpeechProvider,
  type RequestedSpeechProviders,
} from "./speech-types.js";

const OptionalSpeechProviderSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(SpeechProviderIdSchema)
  .optional();

const OptionalBooleanFlagSchema = z
  .union([z.boolean(), z.string().trim().toLowerCase()])
  .optional()
  .transform((value) => {
    if (typeof value === "boolean") {
      return value;
    }
    if (value === undefined) {
      return undefined;
    }
    if (["1", "true", "yes", "y", "on"].includes(value)) {
      return true;
    }
    if (["0", "false", "no", "n", "off"].includes(value)) {
      return false;
    }
    return undefined;
  });

const RequestedSpeechProvidersSchema = z.object({
  dictationStt: OptionalSpeechProviderSchema.default("local"),
  voiceTurnDetection: OptionalSpeechProviderSchema.default("local"),
  voiceStt: OptionalSpeechProviderSchema.default("local"),
  voiceTts: OptionalSpeechProviderSchema.default("local"),
  readAloudTts: OptionalSpeechProviderSchema.default("local"),
});

// Dictation is on unless turned off. Voice mode is opt-in: it downloads its own models and
// runs a hidden agent, so a host only pays for it once someone turns it on.
export const DICTATION_ENABLED_BY_DEFAULT = true;
export const VOICE_MODE_ENABLED_BY_DEFAULT = false;
// Read aloud shares dictation's always-available posture: a one-shot synthesis with no hidden
// agent, so it is on unless turned off.
export const READ_ALOUD_ENABLED_BY_DEFAULT = true;

function resolveOptionalBooleanFlag(value: unknown, fallback: boolean): boolean {
  return OptionalBooleanFlagSchema.parse(value) ?? fallback;
}

interface FeatureProviderInputs {
  configuredValue: string | undefined;
  enabled: boolean;
}

function firstSpeechDefinedValue<T>(values: Array<T | null | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

/**
 * Voice-mode TTS provider selection; read aloud synthesizes through the same site,
 * so the same env and config values apply to both features.
 */
function voiceTtsProviderSelection(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): string | undefined {
  return firstSpeechDefinedValue<string>([
    params.env.PASEO_VOICE_TTS_PROVIDER,
    params.persisted.features?.voiceMode?.tts?.provider,
  ]);
}

function buildFeatureProviderInputs(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): Record<keyof RequestedSpeechProviders, FeatureProviderInputs> {
  const voiceModeEnabled = resolveOptionalBooleanFlag(
    firstSpeechDefinedValue<string | boolean>([
      params.env.PASEO_VOICE_MODE_ENABLED,
      params.persisted.features?.voiceMode?.enabled,
    ]),
    VOICE_MODE_ENABLED_BY_DEFAULT,
  );
  return {
    dictationStt: {
      configuredValue: firstSpeechDefinedValue<string>([
        params.env.PASEO_DICTATION_STT_PROVIDER,
        params.persisted.features?.dictation?.stt?.provider,
      ]),
      enabled: resolveOptionalBooleanFlag(
        firstSpeechDefinedValue<string | boolean>([
          params.env.PASEO_DICTATION_ENABLED,
          params.persisted.features?.dictation?.enabled,
        ]),
        DICTATION_ENABLED_BY_DEFAULT,
      ),
    },
    voiceTurnDetection: {
      configuredValue: firstSpeechDefinedValue<string>([
        params.env.PASEO_VOICE_TURN_DETECTION_PROVIDER,
        params.persisted.features?.voiceMode?.turnDetection?.provider,
      ]),
      enabled: voiceModeEnabled,
    },
    voiceStt: {
      configuredValue: firstSpeechDefinedValue<string>([
        params.env.PASEO_VOICE_STT_PROVIDER,
        params.persisted.features?.voiceMode?.stt?.provider,
      ]),
      enabled: voiceModeEnabled,
    },
    voiceTts: {
      configuredValue: voiceTtsProviderSelection(params),
      enabled: voiceModeEnabled,
    },
    readAloudTts: {
      configuredValue: voiceTtsProviderSelection(params),
      enabled: resolveOptionalBooleanFlag(
        firstSpeechDefinedValue<string | boolean>([
          params.env.PASEO_READ_ALOUD_ENABLED,
          params.persisted.features?.readAloud?.enabled,
        ]),
        READ_ALOUD_ENABLED_BY_DEFAULT,
      ),
    },
  };
}

function buildRequestedFeatureProvider(
  inputs: FeatureProviderInputs,
  parsedValue: z.infer<typeof SpeechProviderIdSchema>,
): RequestedSpeechProvider {
  return {
    provider: parsedValue,
    explicit: inputs.configuredValue !== undefined,
    enabled: inputs.enabled,
  };
}

export function resolveRequestedSpeechProviders(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): RequestedSpeechProviders {
  const featureProviders = buildFeatureProviderInputs(params);

  const parsed = RequestedSpeechProvidersSchema.parse({
    dictationStt: featureProviders.dictationStt.configuredValue ?? "local",
    voiceTurnDetection: featureProviders.voiceTurnDetection.configuredValue ?? "local",
    voiceStt: featureProviders.voiceStt.configuredValue ?? "local",
    voiceTts: featureProviders.voiceTts.configuredValue ?? "local",
    readAloudTts: featureProviders.readAloudTts.configuredValue ?? "local",
  });

  return {
    dictationStt: buildRequestedFeatureProvider(featureProviders.dictationStt, parsed.dictationStt),
    voiceTurnDetection: buildRequestedFeatureProvider(
      featureProviders.voiceTurnDetection,
      parsed.voiceTurnDetection,
    ),
    voiceStt: buildRequestedFeatureProvider(featureProviders.voiceStt, parsed.voiceStt),
    voiceTts: buildRequestedFeatureProvider(featureProviders.voiceTts, parsed.voiceTts),
    readAloudTts: buildRequestedFeatureProvider(featureProviders.readAloudTts, parsed.readAloudTts),
  };
}

export function resolveSpeechConfig(params: {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): {
  openai: PaseoOpenAIConfig | undefined;
  speech: PaseoSpeechConfig;
} {
  const providers = resolveRequestedSpeechProviders({
    env: params.env,
    persisted: params.persisted,
  });

  const local = resolveLocalSpeechConfig({
    paseoHome: params.paseoHome,
    env: params.env,
    persisted: params.persisted,
    providers,
  });

  const openai = resolveOpenAiSpeechConfig({
    env: params.env,
    persisted: params.persisted,
    providers,
  });

  return {
    openai,
    speech: {
      providers,
      localModelsDir: local.modelsDir,
      sttLanguages: local.sttLanguages,
      ...(local.local ? { local: local.local } : {}),
    },
  };
}
