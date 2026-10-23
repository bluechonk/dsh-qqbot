/**
 * ModelResolver — 统一的模型发现与路由解析
 *
 * 职责：
 *   1. 解析当前生效的默认模型路由
 *   2. 列出可用 providers 和模型
 *   3. 管理 per-peer 的模型偏好（委托 PrefsStore）
 *
 * 优先级（从高到低）：
 *   per-peer 偏好（~/.dsh-qqbot/model-prefs.json）
 *   > config 显式指定（cordis.yml 的 provider/model）
 *   > settings.yaml 的 agent-default-model（只读，作为默认兜底）
 *   > 宿主 agentDefaultModel 服务
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { ModelRoute, ModelEntry } from './types.ts';
import { PrefsStore } from './prefs-store.ts';
import { SettingsReader } from './settings-reader.ts';

/** ctx.llm 服务的最小接口（listProviders 同步，listModels 异步） */
interface LlmServiceLike {
  listProviders(): Array<{ id: string; name: string }> | string[];
  listModels(providerId: string): Promise<readonly { id: string; name?: string }[]>;
  /**
   * 查询单个 provider/model 的能力元数据（可选：旧版宿主没有这个方法）。
   *
   * 关键用途：`reasoning` 字段决定这个模型支不支持思考强度。
   * 不查就注入 `reasoningEffort` 会让**整轮直接失败**——
   * 宿主源码：模型没有 reasoning 能力时，只要传了值就抛
   * `UNSUPPORTED_REASONING_EFFORT`。
   */
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ reasoning?: { efforts?: readonly { id: string }[] } }>;
}

/** 模型对思考强度的支持情况（查过一次就缓存） */
interface ReasoningCapability {
  /** 模型是否暴露 reasoning 能力 */
  supported: boolean;
  /** 支持的档位 id */
  efforts: Set<string>;
}

export class ModelResolver {
  private readonly prefs: PrefsStore;
  private readonly settings: SettingsReader;
  private readonly ctx: Context;
  private readonly config: ImQQBotConfig;
  private readonly logger?: Logger;
  /** `${provider}/${model}` → 思考强度支持情况（查过一次就缓存） */
  private readonly reasoningCaps = new Map<string, ReasoningCapability>();

  constructor(
    ctx: Context,
    config: ImQQBotConfig,
    logger?: Logger,
  ) {
    this.ctx = ctx;
    this.config = config;
    this.logger = logger;
    this.prefs = new PrefsStore(
      config.debug ? (msg) => this.logger?.debug(msg) : undefined,
    );
    this.settings = new SettingsReader();
  }

  /**
   * 获取指定 sessionKey 的有效模型路由（create 用）
   *
   * 优先级：per-peer 偏好 > config 显式指定 > settings.yaml > 宿主服务
   */
  getEffectiveRoute(sessionKey: string): ModelRoute | undefined {
    return this.withReasoning(this.prefs.getOverride(sessionKey) ?? this.resolveDefault());
  }

  /**
   * 同 `getEffectiveRoute`，但**先查模型能力**再决定要不要注入思考强度。
   *
   * 建会话必须走这个版本：模型不支持 reasoning 时注入 `reasoningEffort`
   * 会让整轮直接抛 `UNSUPPORTED_REASONING_EFFORT`（宿主源码里是硬校验）。
   */
  async getEffectiveRouteChecked(sessionKey: string): Promise<ModelRoute | undefined> {
    const base = this.prefs.getOverride(sessionKey) ?? this.resolveDefault();
    await this.ensureReasoningCapability(base.provider, base.model);
    return this.withReasoning(base);
  }

  /**
   * 获取 resume 时覆盖 session 的模型路由
   *
   * 优先级：per-peer 偏好 > cordis.yml 显式配置 > 默认链（settings.yaml > host）
   *
   * 这里不返回 undefined，因为未装 installModelSelection，system-prompt 的
   * {{model}} 变量直接读 agent.options.model——若无值会抛
   * "prompt variable {{model}} has no value for this assembly"。
   * 因此兜底到默认链，确保 agent.options.model 始终有值。
   */
  getResumeRoute(sessionKey: string): ModelRoute | undefined {
    const override = this.prefs.getOverride(sessionKey);
    if (override) return this.withReasoning(override);

    if (this.config.provider && this.config.model) {
      return this.withReasoning({ provider: this.config.provider, model: this.config.model });
    }

    return this.withReasoning(this.resolveDefault());
  }

  /** 同 `getResumeRoute`，但先查模型能力 */
  async getResumeRouteChecked(sessionKey: string): Promise<ModelRoute | undefined> {
    const override = this.prefs.getOverride(sessionKey);
    const base = override
      ?? (this.config.provider && this.config.model
        ? { provider: this.config.provider, model: this.config.model }
        : this.resolveDefault());
    await this.ensureReasoningCapability(base.provider, base.model);
    return this.withReasoning(base);
  }

  /**
   * 查询并缓存某模型的思考强度支持情况。
   *
   * 查不到（服务缺失/旧版宿主/查询失败）就**不缓存**，保持「未知」状态——
   * 未知时 `withReasoning` 选择不注入，因为注入的代价是整轮失败，
   * 而不注入只是少一个偏好。
   */
  async ensureReasoningCapability(provider: string, model: string): Promise<void> {
    const key = `${provider}/${model}`;
    if (this.reasoningCaps.has(key)) return;

    const llm = this.getLlmService();
    if (!llm?.resolveModelInfo) return;

    try {
      const info = await llm.resolveModelInfo(provider, model);
      const reasoning = info?.reasoning;
      if (reasoning === undefined) {
        this.reasoningCaps.set(key, { supported: false, efforts: new Set() });
        return;
      }
      const efforts = new Set((reasoning.efforts ?? []).map((e) => e.id));
      this.reasoningCaps.set(key, { supported: true, efforts });
    } catch (err) {
      // 保持未知，不缓存；下次还会重试
      this.logger?.debug(
        `ModelResolver: ${key} 思考强度能力查询失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 把配置里的思考强度注入路由。
   *
   * 未配置时**不写这个字段**（undefined 与「显式 off」是两回事）：
   * 前者让宿主/模型自己决定，后者是明确关掉思考。
   *
   * ⚠️ 但**只在模型确实支持时才注入**。宿主对 `reasoningEffort` 是硬校验：
   * 模型没有 reasoning 能力时，传任何值都会抛 `UNSUPPORTED_REASONING_EFFORT`，
   * 整轮直接失败、用户只看到一句报错。
   * 实测踩过：`longcat/LongCat-2.5-Preview` 不支持，而配置里是 `off`。
   */
  private withReasoning(route: ModelRoute | undefined): ModelRoute | undefined {
    const effort = this.config.reasoningEffort;
    if (route === undefined || effort === undefined || effort === null) return route;
    // 设置面板用空串表示"不覆盖"，这里同样归一化掉
    if (String(effort) === '') return route;

    const cap = this.reasoningCaps.get(`${route.provider}/${route.model}`);
    if (cap === undefined) {
      // 未知 → 不注入（注入可能直接让整轮失败）。留痕，避免静默降级。
      this.logger?.debug(
        `ModelResolver: ${route.provider}/${route.model} 思考强度能力未知，本次不注入 ${String(effort)}`,
      );
      return route;
    }
    if (!cap.supported) {
      // 模型根本没有 reasoning 能力 → 它永远处于「关思考」，注入没有意义
      this.logger?.debug(
        `ModelResolver: ${route.provider}/${route.model} 不支持思考强度，忽略配置值 ${String(effort)}`,
      );
      return route;
    }
    if (!cap.efforts.has(String(effort))) {
      this.logger?.warn(
        `ModelResolver: ${route.provider}/${route.model} 不支持思考强度 ${String(effort)}`
        + `（可选：${[...cap.efforts].join('/') || '无'}），本次不注入`,
      );
      return route;
    }
    return { ...route, reasoningEffort: effort as ModelRoute['reasoningEffort'] };
  }

  /**
   * 设置 per-peer 模型偏好并持久化到隔离文件
   */
  setOverride(sessionKey: string, route: ModelRoute): void {
    this.prefs.setOverride(sessionKey, route);
  }

  /**
   * 清除 per-peer 模型偏好并持久化
   */
  clearOverride(sessionKey: string): void {
    this.prefs.clearOverride(sessionKey);
  }

  /**
   * 是否存在指定 session 的模型偏好
   */
  hasOverride(sessionKey: string): boolean {
    return this.prefs.hasOverride(sessionKey);
  }

  /**
   * 获取指定 sessionKey 的最新 sessionId（重建会话后记录，重启恢复用）
   */
  getSessionId(sessionKey: string): string | undefined {
    return this.prefs.getSessionId(sessionKey);
  }

  /**
   * 记录指定 sessionKey 的最新 sessionId（重建会话后调用）并持久化
   */
  setSessionId(sessionKey: string, sessionId: string): void {
    this.prefs.setSessionId(sessionKey, sessionId);
  }

  /**
   * 清除指定 sessionKey 的 sessionId 记录
   */
  clearSessionId(sessionKey: string): void {
    this.prefs.clearSessionId(sessionKey);
  }

  /**
   * 获取指定 sessionKey 的 per-peer preset 覆盖
   */
  getPreset(sessionKey: string): string | undefined {
    return this.prefs.getPreset(sessionKey);
  }

  /**
   * 设置 per-peer preset 覆盖并持久化
   */
  setPreset(sessionKey: string, presetId: string): void {
    this.prefs.setPreset(sessionKey, presetId);
  }

  /**
   * 清除 per-peer preset 覆盖并持久化
   */
  clearPreset(sessionKey: string): boolean {
    return this.prefs.clearPreset(sessionKey);
  }

  /**
   * 解析默认模型路由（不含 per-peer 偏好）
   *
   * 优先级：config 显式指定 > settings.yaml（只读） > 宿主 agentDefaultModel
   * 最终兜底 deepseek-official/deepseek-v4-flash，确保 {{model}} 变量始终有值。
   */
  resolveDefault(): ModelRoute {
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }

    const fromSettings = this.settings.readDefaultRoute();
    if (fromSettings) return fromSettings;

    const fromHost = this.readFromHost();
    if (fromHost) return fromHost;

    return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
  }

  /**
   * 列出所有可用模型
   *
   * 优先走 ctx.llm 服务动态发现，服务不可用或失败时回退 settings.yaml 静态配置。
   */
  async listModels(): Promise<ModelEntry[]> {
    const llm = this.getLlmService();
    if (!llm) return this.settings.readModels();

    try {
      const providers = llm.listProviders();
      const entries: ModelEntry[] = [];
      for (const provider of providers) {
        const providerId = typeof provider === 'string' ? provider : provider.id;
        try {
          const models = await llm.listModels(providerId);
          for (const model of models) {
            entries.push({ provider: providerId, id: model.id, name: model.name });
          }
        } catch (err) {
          // 单个 provider 失败，跳过
          this.logger?.debug(
            `ModelResolver: provider ${providerId} 模型列表获取失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (entries.length > 0) return entries;
    } catch (err) {
      this.logger?.warn(
        `ModelResolver: 动态发现模型失败，回退 settings.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return this.settings.readModels();
  }

  /**
   * 列出可用 provider 名称
   */
  listProviders(): string[] {
    const llm = this.getLlmService();
    if (llm) {
      const providers = llm.listProviders();
      if (providers.length > 0) {
        const first = providers[0];
        if (typeof first === 'string') return providers as string[];
        return (providers as Array<{ id: string; name: string }>).map((p) => p.id);
      }
    }

    return this.settings.readProviders();
  }

  // ── 私有方法 ──

  private readFromHost(): ModelRoute | undefined {
    try {
      const agentDefaultModel = this.getService('agentDefaultModel') as
        | { currentSelection(): { provider: string; model: string } }
        | undefined;

      if (agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function') {
        const selection = agentDefaultModel.currentSelection();
        if (selection?.provider && selection?.model) {
          return { provider: selection.provider, model: selection.model };
        }
      }
    } catch (err) {
      if (this.config.debug) {
        this.logger?.debug(`ModelResolver: host service failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  }

  /** 统一的 Cordis 服务访问（可选获取：服务未注入时静默返回 undefined，避免 Proxy 抛错） */
  private getService(name: string): unknown {
    try {
      const ctxAny = this.ctx as unknown as { get?: (key: string) => unknown };
      return typeof ctxAny.get === 'function' ? ctxAny.get(name) : undefined;
    } catch {
      return undefined;
    }
  }

  /** 获取 ctx.llm 服务（最小接口收窄，不可用时返回 undefined） */
  private getLlmService(): LlmServiceLike | undefined {
    try {
      const llm = this.getService('llm') as LlmServiceLike | undefined;
      if (llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
        return llm;
      }
    } catch (err) {
      this.logger?.warn(
        `ModelResolver: ctx.llm 服务访问失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return undefined;
  }
}
