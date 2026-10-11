// 从 src/assets/tray/tray-icon.png 生成 Windows 用 .ico（electron-builder 的 nsis/portable 图标）。
//
// 为什么手写 ICO 容器：sharp 不支持输出 ico。ICO 格式本身很简单 ——
// 6 字节头 + 每张图 16 字节目录项 + 各图原始字节；Windows Vista 之后允许目录项里直接塞 PNG。
// 这里塞 256/128/64/48/32/16 六档，全部由 sharp 从同一张源图缩放而来。
//
// 注意：源图只有 32x32，放大到 256 是插值结果（不清晰但可用）。等主人提供高清图标后替换源图即可。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
// 图标源图：默认用高清 badge（2048x2048）；也可以用命令行参数指定其它图片当图标。
// 早期默认源是 src/assets/tray/tray-icon.png（只有 32x32，放大后会糊）。
const source = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'incoming-assets', 'badge', 'badge-01.png');
const target = path.join(root, '.build', 'app.ico');
const sizes = [256, 128, 64, 48, 32, 16];

/** 拼 ICO 容器：header(6) + entries(16*n) + images */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const directory = [];
  for (const image of images) {
    const entry = Buffer.alloc(16);
    // 256 用 0 表示（目录项里宽度/高度是 1 字节）
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2); // 调色板数
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    offset += image.data.length;
  }
  return Buffer.concat([header, ...directory, ...images.map((image) => image.data)]);
}

const sharp = (await import('sharp')).default;
await mkdir(path.dirname(target), { recursive: true });

const images = [];
for (const size of sizes) {
  const data = await sharp(source)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  images.push({ size, data });
}
const ico = buildIco(images);
await writeFile(target, ico);
console.log(`ICON_READY ${path.relative(root, target)} bytes=${ico.length} sizes=${sizes.join(',')}`);
