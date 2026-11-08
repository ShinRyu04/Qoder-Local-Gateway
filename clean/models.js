// Model registry aligned with `qodercli --list-models` (qodercli 1.1.41).
const MODELS = [
  { id: 'qoder-cn', name: 'Qoder CN Auto', cliModel: 'auto', reasoning: true },
  { id: 'auto', name: 'Auto', cliModel: 'auto', reasoning: true },
  { id: 'ultimate', name: 'Ultimate', cliModel: 'Ultimate', reasoning: true },
  { id: 'performance', name: 'Performance', cliModel: 'Performance', reasoning: true },
  { id: 'efficient', name: 'Efficient', cliModel: 'Efficient', reasoning: true },
  { id: 'lite', name: 'Lite', cliModel: 'Lite', reasoning: true },
  { id: 'cantus', name: 'Cantus', cliModel: 'Cantus', reasoning: true },
  { id: 'sonus', name: 'Sonus (SOTA credits)', cliModel: 'Sonus', reasoning: true },
  { id: 'fast', name: 'Fast', cliModel: 'Fast', reasoning: true },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', cliModel: 'Kimi-K3.1-Pro', reasoning: true },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', cliModel: 'Kimi-K2.8-Preview', reasoning: true },
  { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', cliModel: 'MiniMax-M3.1-Flash', reasoning: true },
  { id: 'deepseek-flash', name: 'DeepSeek-Flash', cliModel: 'DeepSeek-Flash', reasoning: true },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', cliModel: 'deeperseeker/v4.1flash', reasoning: true },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', cliModel: 'Qwen3.8-Max', reasoning: true },
  { id: 'qwen3.8-max-effort-low', name: 'Qwen3.8-Max low', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-max-effort-medium', name: 'Qwen3.8-Max medium', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-max-effort-high', name: 'Qwen3.8-Max high', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-max-effort-max', name: 'Qwen3.8-Max max', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', cliModel: 'Qwen3.8-Flash', reasoning: true },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max', cliModel: 'Qwen3.7-Max', reasoning: true },
  { id: 'qwen3.7-max-effort-low', name: 'Qwen3.7-Max low', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-medium', name: 'Qwen3.7-Max medium', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-high', name: 'Qwen3.7-Max high', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-max', name: 'Qwen3.7-Max max', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', cliModel: 'Qwen3.7-Plus', reasoning: true },
  { id: 'kimi-k3', name: 'Kimi-K3', cliModel: 'Kimi-K3', reasoning: true },
  { id: 'kimi-k2.7-code', name: 'Kimi-K2.7-Code', cliModel: 'Kimi-K2.7-Code', reasoning: true },
  { id: 'glm-5.3', name: 'GLM-5.3', cliModel: 'GLM-5.3', reasoning: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', cliModel: 'GLM-5.3-Flash', reasoning: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', cliModel: 'DeepSeek-V4-Pro', reasoning: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', cliModel: 'DeepSeek-V4-Flash', reasoning: true },
  { id: 'minimax-m3', name: 'MiniMax-M3', cliModel: 'MiniMax-M3', reasoning: true },
];

const DEFAULT_MODEL_ID = 'qoder-cn';
const EFFORT_SUFFIX_RE = /^(.*)-effort-(low|medium|high|max)$/;
const STRICT_MODELS = /^(1|true|yes|on)$/i.test(process.env.QODERCN_STRICT_MODELS || '');

function getModel(modelId) {
  return MODELS.find((model) => model.id === modelId);
}

function resolveCliModel(modelId) {
  if (process.env.QODERCN_MODEL) return process.env.QODERCN_MODEL;
  const model = getModel(modelId);
  if (model) return model.cliModel;
  // Fallback to auto for unknown models (e.g. claude-haiku, gpt-4, etc.)
  return 'auto';
}

function resolveModelRoute(modelId) {
  const match = modelId ? String(modelId).match(EFFORT_SUFFIX_RE) : null;
  const baseModelId = match ? match[1] : modelId;

  // Strict mode stops the silent `auto` fallback: an unknown model would
  // otherwise be routed to whatever the CLI picks, which can be a cheaper
  // bucket than the one the caller intended to burn.
  if (STRICT_MODELS && !process.env.QODERCN_MODEL && !getModel(baseModelId)) {
    const error = new Error(`Model "${baseModelId || ''}" is not in the supported model list.`);
    error.status = 400;
    error.code = 'model_not_supported';
    error.type = 'invalid_request_error';
    throw error;
  }

  return {
    baseModelId,
    cliModel: resolveCliModel(baseModelId),
    reasoningEffort: match?.[2],
  };
}

module.exports = {
  DEFAULT_MODEL_ID,
  MODELS,
  getModel,
  resolveCliModel,
  resolveModelRoute,
};
