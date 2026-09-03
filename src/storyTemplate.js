// Generates a finished, ready-to-post Instagram Story image (1080x1920 PNG)
// from up to 4 photos plus the pet's info. This is the whole point of this
// file: turn "a pile of raw photos + text in a DM" into "one image your team
// can open and tap Add to Story", no design work needed.
//
// Uses sharp for compositing (fast, well-supported on Render) and embeds
// real font files as base64 in an SVG overlay, so text renders identically
// regardless of what fonts happen to be installed on the host.

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const CANVAS_W = 1080;
const CANVAS_H = 1920;
const PANEL_H = 720; // height of the bottom info panel

const BRAND_ORANGE = '#FF8C00';
const BRAND_DARK = '#2B2320';
const BRAND_CREAM = '#FFFDF9';

// Fonts are embedded once at module load, not per-request.
const FONTS_DIR = path.join(__dirname, '..', 'fonts');
function loadFontBase64(filename) {
  return fs.readFileSync(path.join(FONTS_DIR, filename)).toString('base64');
}
const FONT_LATIN_REGULAR = loadFontBase64('NotoSans-Regular.woff2');
const FONT_LATIN_MEDIUM = loadFontBase64('NotoSans-Medium.woff2');
const FONT_ARABIC_REGULAR = loadFontBase64('NotoSansArabic-Regular.woff2');
const FONT_ARABIC_MEDIUM = loadFontBase64('NotoSansArabic-Medium.woff2');

function isArabicText(text) {
  return /[\u0600-\u06FF]/.test(text || '');
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Very rough line-wrapping for the story caption. Good enough for a short
// 1-2 line teaser, not meant for long paragraphs (see condenseStory below).
function wrapText(text, maxCharsPerLine, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

// Fetches a photo and returns it resized/cropped to exactly fit a grid cell.
async function fetchAndPrepPhoto(url, cellW, cellH) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch photo: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return sharp(buffer)
    .resize(cellW, cellH, { fit: 'cover', position: 'attention' })
    .toBuffer();
}

// Builds the grid layout (positions) for 1-4 photos across the top area.
function buildGridLayout(count, areaW, areaH) {
  const gap = 4;
  if (count <= 1) {
    return [{ x: 0, y: 0, w: areaW, h: areaH }];
  }
  if (count === 2) {
    const w = Math.floor((areaW - gap) / 2);
    return [
      { x: 0, y: 0, w, h: areaH },
      { x: w + gap, y: 0, w: areaW - w - gap, h: areaH },
    ];
  }
  if (count === 3) {
    const w = Math.floor((areaW - gap * 2) / 3);
    return [
      { x: 0, y: 0, w, h: areaH },
      { x: w + gap, y: 0, w, h: areaH },
      { x: (w + gap) * 2, y: 0, w: areaW - (w + gap) * 2, h: areaH },
    ];
  }
  // 4 photos: 2x2 grid
  const w = Math.floor((areaW - gap) / 2);
  const h = Math.floor((areaH - gap) / 2);
  return [
    { x: 0, y: 0, w, h },
    { x: w + gap, y: 0, w: areaW - w - gap, h },
    { x: 0, y: h + gap, w, h: areaH - h - gap },
    { x: w + gap, y: h + gap, w: areaW - w - gap, h: areaH - h - gap },
  ];
}

/**
 * Generates the finished story image.
 * @param {Object} info
 * @param {string[]} info.photoUrls - up to 4 photo URLs (extras are ignored)
 * @param {string} info.name
 * @param {string} info.animalType - 'dog' | 'cat' | etc
 * @param {string} info.age
 * @param {string} info.gender
 * @param {string} info.vaccination
 * @param {string} info.story - the short condensed caption (1-2 lines worth)
 * @param {string} info.phone
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function generateStoryImage(info) {
  const photoUrls = (info.photoUrls || []).slice(0, 4);
  const gridAreaH = CANVAS_H - PANEL_H;

  // 1) Prepare the photo grid.
  const layout = buildGridLayout(photoUrls.length, CANVAS_W, gridAreaH);
  const photoBuffers = await Promise.all(
    photoUrls.map((url, i) => fetchAndPrepPhoto(url, layout[i].w, layout[i].h).catch(() => null))
  );

  let gridImage = sharp({
    create: { width: CANVAS_W, height: gridAreaH, channels: 3, background: BRAND_DARK },
  });
  const compositeOps = [];
  photoBuffers.forEach((buf, i) => {
    if (buf) compositeOps.push({ input: buf, left: layout[i].x, top: layout[i].y });
  });
  gridImage = gridImage.composite(compositeOps);

  // 2) Build the info panel as SVG (logo, name, tags, story, phone), with
  // real embedded fonts so it renders consistently everywhere.
  const isAr = isArabicText(info.name) || isArabicText(info.story);
  const fontFamily = isAr ? 'NotoSansArabic' : 'NotoSans';
  const dir = isAr ? 'rtl' : 'ltr';
  const textAnchorStart = isAr ? CANVAS_W - 64 : 64;
  const anchorAttr = isAr ? 'end' : 'start';

  const tags = [info.age, info.gender, info.vaccination].filter(Boolean);
  const storyLines = wrapText(info.story, isAr ? 30 : 40, 2);

  let tagX = textAnchorStart;
  const tagEls = [];
  const tagY = 250;
  for (const tag of tags) {
    const tagW = escapeXml(tag).length * 15 + 40;
    const rectX = isAr ? tagX - tagW : tagX;
    tagEls.push(`
      <rect x="${rectX}" y="${tagY}" width="${tagW}" height="54" rx="27" fill="rgba(255,255,255,0.12)" />
      <text x="${rectX + tagW / 2}" y="${tagY + 36}" font-family="${fontFamily}" font-size="27" fill="${BRAND_CREAM}" text-anchor="middle">${escapeXml(tag)}</text>
    `);
    tagX = isAr ? rectX - 14 : rectX + tagW + 14;
  }

  const storyTspans = storyLines
    .map((line, i) => `<tspan x="${textAnchorStart}" dy="${i === 0 ? 0 : 46}">${escapeXml(line)}</tspan>`)
    .join('');

  const panelSvg = `
    <svg width="${CANVAS_W}" height="${PANEL_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          @font-face { font-family: 'NotoSans'; src: url(data:font/woff2;base64,${FONT_LATIN_REGULAR}) format('woff2'); font-weight: 400; }
          @font-face { font-family: 'NotoSans'; src: url(data:font/woff2;base64,${FONT_LATIN_MEDIUM}) format('woff2'); font-weight: 500; }
          @font-face { font-family: 'NotoSansArabic'; src: url(data:font/woff2;base64,${FONT_ARABIC_REGULAR}) format('woff2'); font-weight: 400; }
          @font-face { font-family: 'NotoSansArabic'; src: url(data:font/woff2;base64,${FONT_ARABIC_MEDIUM}) format('woff2'); font-weight: 500; }
        </style>
      </defs>
      <rect width="${CANVAS_W}" height="${PANEL_H}" fill="${BRAND_DARK}" />

      <rect x="64" y="44" width="${escapeXml('up for adoption').length * 15 + 50}" height="60" rx="30" fill="${BRAND_ORANGE}" />
      <text x="89" y="84" font-family="${fontFamily}" font-size="30" font-weight="500" fill="${BRAND_CREAM}">up for adoption</text>

      <text x="${textAnchorStart}" y="200" font-family="${fontFamily}" font-size="68" font-weight="500" fill="${BRAND_CREAM}" text-anchor="${anchorAttr}">${escapeXml(info.name)}</text>

      ${tagEls.join('')}

      <text x="${textAnchorStart}" y="370" font-family="${fontFamily}" font-size="36" fill="#D8D0C0" text-anchor="${anchorAttr}" font-style="italic">${storyTspans}</text>

      <line x1="64" y1="${PANEL_H - 150}" x2="${CANVAS_W - 64}" y2="${PANEL_H - 150}" stroke="rgba(255,255,255,0.2)" stroke-width="2" />

      <circle cx="102" cy="${PANEL_H - 84}" r="32" fill="${BRAND_ORANGE}" />
      <text x="102" y="${PANEL_H - 73}" font-family="${fontFamily}" font-size="30" fill="${BRAND_CREAM}" text-anchor="middle">☎</text>
      <text x="150" y="${PANEL_H - 68}" font-family="${fontFamily}" font-size="46" fill="${BRAND_CREAM}">${escapeXml(info.phone)}</text>

      <circle cx="${CANVAS_W - 84}" cy="${PANEL_H - 84}" r="36" fill="${BRAND_CREAM}" />
      <text x="${CANVAS_W - 84}" y="${PANEL_H - 72}" font-family="${fontFamily}" font-size="34" text-anchor="middle">🐾</text>
    </svg>
  `;

  const gridBuffer = await gridImage.png().toBuffer();

  const finalImage = await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 3, background: BRAND_DARK },
  })
    .composite([
      { input: gridBuffer, left: 0, top: 0 },
      { input: Buffer.from(panelSvg), left: 0, top: gridAreaH },
    ])
    .png()
    .toBuffer();

  return finalImage;
}

module.exports = { generateStoryImage };
