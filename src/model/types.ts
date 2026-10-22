/**
 * 模型路由层类型定义
 */

/**
 * 思考强度（对应 dsh-llm 的 ReasoningEffortId）
 *
 * 合法值由宿主侧定义：off / low / medium / high / max。
 * 这里不引入 dsh-llm 依赖，字符串原样透传给 agentOptions.reasoningEffort。
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

/** 模型路由 */
export interface ModelRoute {
  provider: string;
  model: string;
  /** 思考强度；缺省表示不覆盖，由宿主/模型默认决定 */
  reasoningEffort?: ReasoningEffort;
}

/** 模型信息条目 */
export interface ModelEntry {
  provider: string;
  id: string;
  name?: string;
}
