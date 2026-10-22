/**
 * Vitest 配置
 *
 * 显式限定用例范围：只跑 src/ 下的单测。
 *
 * 不写的话 vitest 用默认通配（`**` + `/*.test.ts`），会扫到仓库里任何临时副本
 * （例如 .tmp/ 下的 CI 演练快照）——用例数翻倍、失败原因难以定位。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'lib/**', '.tmp/**', '.planning/**'],
  },
});
