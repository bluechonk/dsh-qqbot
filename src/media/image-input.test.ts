/**
 * 入站图片 → 多模态输入 — 单测
 *
 * 重点是**失败必须退回「只给路径」而不是让整条消息失败**：
 * 附图是增强，一张图读不了不该拖垮整轮对话。
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildInlineImageBlock,
  readLocalImage,
  sniffImageMediaType,
  type AttachmentStoreLike,
  type ImageAttachmentRef,
} from './image-input.ts';

/** 造一个至少 12 字节、以指定 magic 开头的 buffer */
function bytes(magic: number[], total = 16): Uint8Array {
  const buf = new Uint8Array(total);
  magic.forEach((b, i) => { buf[i] = b; });
  return buf;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];

describe('sniffImageMediaType', () => {
  it('识别四种受支持格式', () => {
    expect(sniffImageMediaType(bytes(PNG))).toBe('image/png');
    expect(sniffImageMediaType(bytes(JPEG))).toBe('image/jpeg');
    expect(sniffImageMediaType(bytes(GIF))).toBe('image/gif');
    expect(sniffImageMediaType(bytes(WEBP))).toBe('image/webp');
  });

  it('不认识的格式返回 null（不信平台声明的 content_type）', () => {
    expect(sniffImageMediaType(bytes([0x00, 0x01, 0x02, 0x03, 4, 5, 6, 7, 8, 9, 10, 11]))).toBeNull();
  });

  it('太短返回 null（不足 12 字节无法判 WEBP）', () => {
    expect(sniffImageMediaType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });

  it('RIFF 但不是 WEBP 不误判', () => {
    const riffWave = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45];
    expect(sniffImageMediaType(bytes(riffWave))).toBeNull();
  });
});

describe('readLocalImage', () => {
  it('文件不存在返回 undefined（不抛）', async () => {
    await expect(readLocalImage(join(tmpdir(), 'no-such-file-xyz.png'), 1024)).resolves.toBeUndefined();
  });

  it('超过体积上限返回 undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-'));
    try {
      const file = join(dir, 'big.png');
      writeFileSync(file, Buffer.from(bytes(PNG, 64)));
      await expect(readLocalImage(file, 16)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('格式不认识返回 undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-'));
    try {
      const file = join(dir, 'x.bin');
      writeFileSync(file, Buffer.from(bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])));
      await expect(readLocalImage(file, 1024)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('正常图片返回字节与嗅探出的 MIME', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-'));
    try {
      const file = join(dir, 'ok.png');
      writeFileSync(file, Buffer.from(bytes(PNG)));
      const loaded = await readLocalImage(file, 1024);
      expect(loaded?.mediaType).toBe('image/png');
      expect(loaded?.data.length).toBe(16);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildInlineImageBlock', () => {
  function tempPng(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'img-'));
    const file = join(dir, 'pic.png');
    writeFileSync(file, Buffer.from(bytes(PNG)));
    return { dir, file };
  }

  it('attachments 服务不可用时返回 undefined（退回只给路径）', async () => {
    const { dir, file } = tempPng();
    try {
      await expect(buildInlineImageBlock(undefined, file, 1024)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saveImage 抛错时返回 undefined（不让整条消息失败）', async () => {
    const { dir, file } = tempPng();
    try {
      const attachments = {
        saveImage: vi.fn(async () => { throw new Error('boom'); }),
      } as unknown as AttachmentStoreLike;
      await expect(buildInlineImageBlock(attachments, file, 1024)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('正常路径返回 ImageBlock，并把嗅探到的 MIME 与文件名传给 saveImage', async () => {
    const { dir, file } = tempPng();
    try {
      const saveImage = vi.fn(async () => ({ id: 'ref-1' }) as unknown as ImageAttachmentRef);
      const block = await buildInlineImageBlock({ saveImage } as unknown as AttachmentStoreLike, file, 1024);
      expect(block?.type).toBe('image');
      expect(saveImage).toHaveBeenCalledTimes(1);
      const arg = saveImage.mock.calls[0]![0] as { mediaType: string; name?: string };
      expect(arg.mediaType).toBe('image/png');
      expect(arg.name).toBe('pic.png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('图片读不到时不调用 saveImage', async () => {
    const saveImage = vi.fn();
    const block = await buildInlineImageBlock(
      { saveImage } as unknown as AttachmentStoreLike,
      join(tmpdir(), 'missing-xyz.png'),
      1024,
    );
    expect(block).toBeUndefined();
    expect(saveImage).not.toHaveBeenCalled();
  });
});
