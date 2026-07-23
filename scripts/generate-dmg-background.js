#!/usr/bin/env node
const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');
// Not a CSS font stack — see pick-font.js. canvas 1.x resolves none of `-apple-system`,
// `Helvetica Neue` or `sans-serif`, and draws one fallback box per glyph without erroring.
const { fontString } = require('./pick-font');

const WIDTH = 660;
const HEIGHT = 400;
const OUTPUT_DIR = path.join(__dirname, '..', 'build');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const canvas = createCanvas(WIDTH, HEIGHT);
const ctx = canvas.getContext('2d');

// Dark gradient background matching the app theme
const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
gradient.addColorStop(0, '#1a1a2e');
gradient.addColorStop(1, '#111118');
ctx.fillStyle = gradient;
ctx.fillRect(0, 0, WIDTH, HEIGHT);

// Subtle grid dots
ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
for (let x = 20; x < WIDTH; x += 20) {
  for (let y = 20; y < HEIGHT; y += 20) {
    ctx.beginPath();
    ctx.arc(x, y, 1, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Arrow from app icon to Applications
ctx.strokeStyle = 'rgba(128, 136, 255, 0.4)';
ctx.lineWidth = 2;
ctx.setLineDash([8, 6]);
ctx.beginPath();
ctx.moveTo(245, HEIGHT / 2 - 20);
ctx.lineTo(415, HEIGHT / 2 - 20);
ctx.stroke();

// Arrowhead
ctx.setLineDash([]);
ctx.fillStyle = 'rgba(128, 136, 255, 0.4)';
ctx.beginPath();
ctx.moveTo(410, HEIGHT / 2 - 28);
ctx.lineTo(420, HEIGHT / 2 - 20);
ctx.lineTo(410, HEIGHT / 2 - 12);
ctx.closePath();
ctx.fill();

// "Drag to install" text
ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
ctx.font = fontString(13);
ctx.textAlign = 'center';
ctx.fillText('Drag to install', WIDTH / 2, HEIGHT / 2 + 15);

// Bottom border accent
const accentGradient = ctx.createLinearGradient(0, HEIGHT - 2, WIDTH, HEIGHT - 2);
accentGradient.addColorStop(0, 'rgba(107, 33, 168, 0.5)');
accentGradient.addColorStop(0.5, 'rgba(128, 136, 255, 0.5)');
accentGradient.addColorStop(1, 'rgba(13, 148, 136, 0.5)');
ctx.fillStyle = accentGradient;
ctx.fillRect(0, HEIGHT - 2, WIDTH, 2);

const buf = canvas.toBuffer('image/png');
const outPath = path.join(OUTPUT_DIR, 'dmg-background.png');
fs.writeFileSync(outPath, buf);
console.log(`Created ${outPath} (${buf.length} bytes)`);

// Also generate @2x version for Retina
const canvas2x = createCanvas(WIDTH * 2, HEIGHT * 2);
const ctx2 = canvas2x.getContext('2d');
ctx2.scale(2, 2);

// Repeat the same drawing at 2x
const gradient2 = ctx2.createLinearGradient(0, 0, WIDTH, HEIGHT);
gradient2.addColorStop(0, '#1a1a2e');
gradient2.addColorStop(1, '#111118');
ctx2.fillStyle = gradient2;
ctx2.fillRect(0, 0, WIDTH, HEIGHT);

ctx2.fillStyle = 'rgba(255, 255, 255, 0.03)';
for (let x = 20; x < WIDTH; x += 20) {
  for (let y = 20; y < HEIGHT; y += 20) {
    ctx2.beginPath();
    ctx2.arc(x, y, 1, 0, Math.PI * 2);
    ctx2.fill();
  }
}

ctx2.strokeStyle = 'rgba(128, 136, 255, 0.4)';
ctx2.lineWidth = 2;
ctx2.setLineDash([8, 6]);
ctx2.beginPath();
ctx2.moveTo(245, HEIGHT / 2 - 20);
ctx2.lineTo(415, HEIGHT / 2 - 20);
ctx2.stroke();

ctx2.setLineDash([]);
ctx2.fillStyle = 'rgba(128, 136, 255, 0.4)';
ctx2.beginPath();
ctx2.moveTo(410, HEIGHT / 2 - 28);
ctx2.lineTo(420, HEIGHT / 2 - 20);
ctx2.lineTo(410, HEIGHT / 2 - 12);
ctx2.closePath();
ctx2.fill();

ctx2.fillStyle = 'rgba(255, 255, 255, 0.3)';
ctx2.font = fontString(13);
ctx2.textAlign = 'center';
ctx2.fillText('Drag to install', WIDTH / 2, HEIGHT / 2 + 15);

const accentGradient2 = ctx2.createLinearGradient(0, HEIGHT - 2, WIDTH, HEIGHT - 2);
accentGradient2.addColorStop(0, 'rgba(107, 33, 168, 0.5)');
accentGradient2.addColorStop(0.5, 'rgba(128, 136, 255, 0.5)');
accentGradient2.addColorStop(1, 'rgba(13, 148, 136, 0.5)');
ctx2.fillStyle = accentGradient2;
ctx2.fillRect(0, HEIGHT - 2, WIDTH, 2);

const buf2x = canvas2x.toBuffer('image/png');
const outPath2x = path.join(OUTPUT_DIR, 'dmg-background@2x.png');
fs.writeFileSync(outPath2x, buf2x);
console.log(`Created ${outPath2x} (${buf2x.length} bytes)`);
