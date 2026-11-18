import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute=promisify(execFile);

sharp.cache({ memory: 32, files: 0, items: 16 });
sharp.concurrency(1);
const PHOTO_LIMIT = 10_000_000;
const INPUT = { limitInputPixels: 80_000_000 };

async function readableImage(file, fn) {
  const metadata=await sharp(file.path,INPUT).metadata();
  if(!metadata.width || !metadata.height || metadata.width*metadata.height>INPUT.limitInputPixels) throw new Error('Image dimensions exceed limits');
  if(metadata.format!=='heif' || metadata.compression!=='hevc') return fn(file.path,metadata);
  const directory=await fs.mkdtemp(path.join(path.dirname(file.path),'heic-'));
  try {
    // Decode outside the Node heap, without a shell; constrain CPU, address
    // space, output size and wall time. Only the first still image is used.
    await execute('/usr/bin/prlimit',['--as=1073741824','--cpu=20','--fsize=33554432','--',
      '/usr/bin/heif-convert','-q','95',file.path,path.join(directory,'image.jpg')],
      {timeout:25000,maxBuffer:65536,env:{...process.env,OMP_NUM_THREADS:'1'}});
    const names=(await fs.readdir(directory)).filter(n=>/^image(?:-\d+)?\.jpg$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    if(!names.length) throw new Error('HEIC decoder produced no image');
    const decoded=path.join(directory,names[0]);
    return await fn(decoded,await sharp(decoded,INPUT).metadata());
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
}

// Keep staff original files unchanged, but provide a browser-readable preview
// for HEIC/HEIF. Compatible originals do not acquire a second compression pass.
export async function createImagePreview(file) {
  try {
    return await readableImage(file,async (source,metadata) => {
      if(source===file.path && metadata.format!=='heif') return null;
      const destination=path.join(path.dirname(file.path),randomUUID());
      try {
        await sharp(source,INPUT).rotate().resize({width:5000,height:5000,fit:'inside',withoutEnlargement:true}).jpeg({quality:95}).toFile(destination);
        return {path:destination,mimetype:'image/jpeg'};
      } catch(e) { await fs.rm(destination,{force:true});throw e; }
    });
  } catch {
    throw Object.assign(new Error('图片预览无法处理，请重试或使用 JPEG / PNG 图片'),{code:'INVALID_PHOTO'});
  }
}

export function largestPhoto(sizes) {
  if (!Array.isArray(sizes)) return null;
  return sizes.reduce((best, item) => {
    const area = (item.width || 0) * (item.height || 0);
    const previous = (best?.width || 0) * (best?.height || 0);
    return !best || area > previous || (area === previous && (item.file_size || 0) > (best.file_size || 0)) ? item : best;
  }, null);
}

// Telegram photo uploads have tighter limits than ordinary file uploads.
// Leave compatible JPEG/PNG inputs intact and only convert when necessary.
export async function prepareTelegramPhoto(file) {
  try {
    return await readableImage(file,async (source,metadata) => {
    let { width, height } = metadata;
    if (!width || !height) throw new Error('Missing image dimensions');
    const oriented = metadata.orientation && metadata.orientation !== 1;
    const ratio = Math.max(width / height, height / width);
    if (source===file.path && ['jpeg', 'png'].includes(metadata.format) && file.size <= PHOTO_LIMIT && width + height <= 10000 && ratio <= 20 && !oriented) {
      return { ...file, mimetype: metadata.format === 'jpeg' ? 'image/jpeg' : 'image/png' };
    }
    if ([5, 6, 7, 8].includes(metadata.orientation)) [width, height] = [height, width];
    let output;
    for (const [side, quality] of [[5000, 95], [5000, 80], [3200, 85], [1600, 85]]) {
      const scale = Math.min(1, side / Math.max(width, height));
      let targetWidth = Math.max(1, Math.floor(width * scale));
      let targetHeight = Math.max(1, Math.floor(height * scale));
      // Pad panoramas rather than crop their contents to satisfy Telegram.
      if (targetWidth > targetHeight * 20) targetHeight = Math.ceil(targetWidth / 20);
      if (targetHeight > targetWidth * 20) targetWidth = Math.ceil(targetHeight / 20);
      output = await sharp(source, INPUT).rotate()
        .resize(targetWidth, targetHeight, { fit: 'contain', withoutEnlargement: true, background: '#ffffff' })
        .flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
      if (output.length <= PHOTO_LIMIT) break;
    }
    if (output.length > PHOTO_LIMIT) throw new Error('Image is still too large');
    const destination = path.join(path.dirname(file.path), randomUUID());
    await fs.writeFile(destination, output, { mode: 0o600 });
    return { ...file, path: destination, size: output.length, mimetype: 'image/jpeg', originalname: `${path.parse(file.originalname).name}.jpg` };
    });
  } catch {
    const error = new Error('图片无法处理，请使用有效的 JPEG、PNG 或 WebP 图片');
    error.code = 'INVALID_PHOTO';
    throw error;
  }
}
