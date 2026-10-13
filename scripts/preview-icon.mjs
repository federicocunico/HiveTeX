import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const source = await readFile('apps/desktop/src-tauri/icons/source.svg', 'utf8');
const small = await readFile('apps/desktop/src-tauri/icons/source-small.svg', 'utf8');
const cell = size => `<div><div class="icon">${(size <= 24 ? small : source).replace('width="1024" height="1024"', `width="${size}" height="${size}"`)} </div><p>${size}px</p></div>`;
const browser = await chromium.launch();
try {
 const page = await browser.newPage({ viewport: { width: 1000, height: 370 }, deviceScaleFactor: 2 });
 await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;font:14px Arial;background:#f5f1e9}.panel{width:50%;height:370px;display:inline-block;padding:36px;vertical-align:top}.dark{background:#101216;color:#fff4d6}h1{font-size:25px;margin:0 0 16px}small{opacity:.7}.sizes{display:flex;justify-content:space-between;align-items:end;margin-top:35px}.icon{height:130px;display:flex;align-items:end}p{opacity:.6}</style><div class="panel"><h1>HiveTeX</h1><small>Connected honeycomb · light surroundings</small><div class="sizes">${[16,24,32,128].map(cell).join('')}</div></div><div class="panel dark"><h1>HiveTeX</h1><small>Connected honeycomb · dark surroundings</small><div class="sizes">${[16,24,32,128].map(cell).join('')}</div></div>`);
 await page.screenshot({ path: 'docs/images/hivetex-icon-preview.png' });
} finally { await browser.close(); }
