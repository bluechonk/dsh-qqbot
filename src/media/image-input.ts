/**
 * 入站图片 → 多模态输入
 *
 * 为什么需要它：插件会把群里的图片下载到本地，但**只把路径当纯文本发给模型**
 * （`- Image: C:/.../xxx.png`）。模型看到一行路径，自然答「我看不懂」。
 * 实测确认模型（longcat/LongCat-2.5-Preview）本身能看图——缺的是把图送过去。
 *
 * 这里把下载好的本地图片转成 dsh-llm 的 `ImageBlock`，由入站侧附到用户消息上。
 *
 * 两条硬约束：
 *
 * 1. **必须先查模型能力**（`ModelResolver.supportsImageInput`）。
 *    模型不接受图片输入时附 ImageBlock 会让**整轮直接失败**——
 *    与 `reasoningEffort` 是同一类坑。
 * 2. **字节不进 session log**：`attachments.saveImage` 返回的是引用（ref），
 *    图片本体存在宿主附件库里，会话记录里只留引用。
 */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ImageBlock } from '@deepseek-ai/dsh-llm';

/** 通过 dsh-llm 的 ImageBlock 间接引用 dsh-attachment 类型，避免直接依赖 dsh-attachment */
export type ImageAttachmentRef = ImageBlock['attachment'];
export type ImageMediaType = ImageAttachmentRef['mediaType'];

/** attachments 服务最小接口（与 vision-tool 同一投影） */
export interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>;
}

/**
 * 图片 magic bytes 嗅探 → 标准 MIME。
 *
 * **不信声明**（消息里的 content_type 是平台给的，可能错）：
 * 宿主与 provider 都按这个值判断怎么解码，猜错等于送坏数据。
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  // WEBP: 52 49 46 46 .. 57 45 42 50
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

/**
 * 读本地图片并嗅探 MIME。
 *
 * 任何一步不对就返回 undefined（**不抛**）：附图是增强，失败只该退回「给路径」，
 * 不能因为一张图读不了就让整条消息处理失败。
 */
export async function readLocalImage(
  filePath: string,
  maxBytes: number,
): Promise<{ data: Uint8Array; mediaType: ImageMediaType } | undefined> {
  try {
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) return undefined;
    if (info.size > maxBytes) return undefined;

    const data = new Uint8Array(await readFile(filePath));
    const mediaType = sniffImageMediaType(data);
    if (mediaType === null) return undefined;
    return { data, mediaType };
  } catch {
    return undefined;
  }
}

/**
 * 把本地图片转成可直接附给模型的 `ImageBlock`。
 *
 * 读不到 / 格式不认识 / attachments 服务不可用 → 返回 undefined，
 * 由调用方退回「只给路径」的老行为。
 */
export async function buildInlineImageBlock(
  attachments: AttachmentStoreLike | undefined,
  filePath: string,
  maxBytes: number,
): Promise<ImageBlock | undefined> {
  if (!attachments?.saveImage) return undefined;

  const loaded = await readLocalImage(filePath, maxBytes);
  if (loaded === undefined) return undefined;

  try {
    const ref = await attachments.saveImage({
      data: loaded.data,
      mediaType: loaded.mediaType,
      name: basename(filePath),
    });
    return { type: 'image', attachment: ref };
  } catch {
    return undefined;
  }
}
