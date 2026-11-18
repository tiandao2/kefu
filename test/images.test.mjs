import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { prepareTelegramPhoto, createImagePreview } from '../images.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'kf-photos-'));
let index=0;
after(()=>rm(directory,{recursive:true,force:true}));
async function fixture(bytes,name){const file=path.join(directory,String(index++));await writeFile(file,bytes);return {path:file,originalname:name,size:bytes.length,mimetype:'image/png'};}

test('compatible photos keep their input quality before Telegram processing',async()=>{
 const bytes=await sharp({create:{width:640,height:480,channels:3,background:'#187466'}}).png().toBuffer();
 const file=await fixture(bytes,'photo.png'),prepared=await prepareTelegramPhoto(file);
 assert.equal(prepared.path,file.path);assert.equal(prepared.size,bytes.length);assert.equal(prepared.mimetype,'image/png');
});

test('WebP converts to a Telegram-compatible JPEG without enlarging or cropping',async()=>{
 const bytes=await sharp({create:{width:800,height:600,channels:4,background:'#18746680'}}).webp().toBuffer();
 const prepared=await prepareTelegramPhoto(await fixture(bytes,'photo.webp'));
 const metadata=await sharp(prepared.path).metadata();assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,800);assert.equal(metadata.height,600);assert.equal(prepared.originalname,'photo.jpg');
});

test('panoramas are padded to Telegram limits while keeping their full content',async()=>{
 const bytes=await sharp({create:{width:12000,height:20,channels:3,background:'#abc'}}).png().toBuffer();
 const prepared=await prepareTelegramPhoto(await fixture(bytes,'panorama.png'));
 const m=await sharp(prepared.path).metadata();assert.ok(m.width+m.height<=10000);assert.ok(m.width/m.height<=20);assert.ok(m.width>=1000);assert.ok(prepared.size<=10_000_000);
});

test('oversized photo uploads are reduced below the Telegram photo byte limit',async()=>{
 const jpeg=await sharp({create:{width:800,height:600,channels:3,background:'#abc'}}).jpeg().toBuffer();
 const file=await fixture(Buffer.concat([jpeg,Buffer.alloc(10_000_000)]),'large.jpg');
 const prepared=await prepareTelegramPhoto(file);assert.notEqual(prepared.path,file.path);assert.ok(prepared.size<=10_000_000);assert.equal((await sharp(prepared.path).metadata()).format,'jpeg');
});

test('camera orientation is applied before sending the converted photo',async()=>{
 const jpeg=await sharp({create:{width:80,height:40,channels:3,background:'#abc'}}).jpeg().withMetadata({orientation:6}).toBuffer();
 const prepared=await prepareTelegramPhoto(await fixture(jpeg,'camera.jpg'));
 const m=await sharp(prepared.path).metadata();assert.equal(m.width,40);assert.equal(m.height,80);assert.ok(!m.orientation||m.orientation===1);
});

test('invalid photo contents produce a client-facing validation error',async()=>{
 const file=await fixture(Buffer.from('not a photo'),'invalid.png');
 await assert.rejects(prepareTelegramPhoto(file),error=>error.code==='INVALID_PHOTO');
});


test('HEVC HEIC uploads convert to JPEG and staff previews preserve the original',async()=>{
 const bytes=await readFile(new URL('./fixtures/solid.heic',import.meta.url));
 const file=await fixture(bytes,'iphone.heic');file.mimetype='image/heic';
 const prepared=await prepareTelegramPhoto(file),preview=await createImagePreview(file);
 for(const p of [prepared,preview]) { const m=await sharp(p.path).metadata();assert.equal(m.format,'jpeg');assert.equal(m.width,96);assert.equal(m.height,64); }
 assert.deepEqual(await readFile(file.path),bytes);
});
