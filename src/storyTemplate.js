// Generates a finished, ready-to-post Instagram Story image (1080x1920 PNG)
// from up to 4 photos plus the pet's info. This is the whole point of this
// file: turn "a pile of raw photos + text in a DM" into "one image your team
// can open and tap Add to Story", no design work needed.
//
// Layout matches tabanni's reference template: a 2x2 photo collage across
// the top, a light paper-textured background, a rounded "story" box with
// the pet's info, a hand-lettered "CONTACT INFO:" label, and a rounded
// contact box with the phone number at the very bottom.
//
// Uses sharp for compositing (fast, well-supported on Render) and embeds
// real font files + tabanni's real logo as base64 in an SVG overlay, so it
// renders identically regardless of what fonts/assets happen to exist on
// the host.

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const CANVAS_W = 1080;
const CANVAS_H = 1920;

// tabanni's real brand colors
const BRAND_NAVY = '#333E48';   // text color, matches the reference template
const BRAND_TEAL = '#3D937F';
const BRAND_ORANGE = '#FA8D29';
const PAPER_BG = '#EEEEEE';     // off-white paper background
const BOX_FILL = '#D9D9D9';     // grey content box fill, matches the reference

// Box positions, measured directly from the reference template image
// (1080x1920), as fractions of the canvas so they scale correctly.
const STORY_BOX = { x: 55, y: 1341, w: 970, h: 316, r: 32 };
const CONTACT_LABEL_Y = 1725;
const CONTACT_BOX = { x: 258, y: 1751, w: 564, h: 141, r: 32 };
const PHOTO_AREA_H = 1300; // photo collage fills the top, down to just above the story box

// Fonts and the logo are embedded once at module load, not per-request.
const FONTS_DIR = path.join(__dirname, '..', 'fonts');
const ASSETS_DIR = path.join(__dirname, '..', 'tabanni-assets');
function loadFileBase64(dir, filename) {
  return fs.readFileSync(path.join(dir, filename)).toString('base64');
}
const FONT_LATIN_REGULAR = loadFileBase64(FONTS_DIR, 'NotoSans-Regular.woff2');
const FONT_LATIN_MEDIUM = loadFileBase64(FONTS_DIR, 'NotoSans-Medium.woff2');
const FONT_ARABIC_REGULAR = loadFileBase64(FONTS_DIR, 'NotoSansArabic-Regular.woff2');
const FONT_ARABIC_MEDIUM = loadFileBase64(FONTS_DIR, 'NotoSansArabic-Medium.woff2');
const LOGO_ICON_BASE64 = loadFileBase64(ASSETS_DIR, 'tabanni-icon.png');
const LOGO_ICON_ASPECT = 1750 / 1404;

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

// Very rough line-wrapping for the story caption.
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

async function fetchAndPrepPhoto(url, cellW, cellH) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch photo: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return sharp(buffer)
    .resize(cellW, cellH, { fit: 'cover', position: 'attention' })
    .toBuffer();
}

// Builds the grid layout for 1-4 photos. Always aims for a 2x2 feel when
// 4 photos are available, per the reference template.
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
  const w = Math.floor((areaW - gap) / 2);
  const h = Math.floor((areaH - gap) / 2);
  return [
    { x: 0, y: 0, w, h },
    { x: w + gap, y: 0, w: areaW - w - gap, h },
    { x: 0, y: h + gap, w, h: areaH - h - gap },
    { x: w + gap, y: h + gap, w: areaW - w - gap, h: areaH - h - gap },
  ];
}

// Generates a subtle paper-grain texture as an SVG filter, approximating
// the reference template's kraft-paper background. This is a generated
// approximation, not the exact source texture — if tabanni has the real
// paper texture file, it can be swapped in directly for a closer match.
function paperTextureSvg(w, h) {
  return `
    <filter id="paperGrain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0.13  0 0 0 0 0.15  0 0 0 0 0.18  0 0 0 0.05 0"/>
    </filter>
    <rect width="${w}" height="${h}" fill="${PAPER_BG}" />
    <rect width="${w}" height="${h}" filter="url(#paperGrain)" />
  `;
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

  // 1) Prepare the 2x2 photo collage across the top.
  const layout = buildGridLayout(photoUrls.length, CANVAS_W, PHOTO_AREA_H);
  const photoBuffers = await Promise.all(
    photoUrls.map((url, i) => fetchAndPrepPhoto(url, layout[i].w, layout[i].h).catch(() => null))
  );
  let photoLayer = sharp({
    create: { width: CANVAS_W, height: PHOTO_AREA_H, channels: 3, background: BOX_FILL },
  });
  const compositeOps = [];
  photoBuffers.forEach((buf, i) => {
    if (buf) compositeOps.push({ input: buf, left: layout[i].x, top: layout[i].y });
  });
  photoLayer = photoLayer.composite(compositeOps);
  const photoBuffer = await photoLayer.png().toBuffer();

  // 2) Build the rest as one SVG overlay: paper background, story box
  // (name + tags + description), "CONTACT INFO:" label, contact box.
  const isAr = isArabicText(info.name) || isArabicText(info.story);
  const fontFamily = isAr ? 'NotoSansArabic' : 'NotoSans';
  const anchorAttr = isAr ? 'end' : 'start';
  const padX = 40;
  const textStartX = isAr ? STORY_BOX.x + STORY_BOX.w - padX : STORY_BOX.x + padX;

  const tags = [info.age, info.gender, info.vaccination].filter(Boolean);
  const storyLines = wrapText(info.story, isAr ? 34 : 46, 2);

  let tagX = textStartX;
  const tagEls = [];
  const tagY = STORY_BOX.y + 82;
  for (const tag of tags) {
    const tagW = escapeXml(tag).length * 13 + 36;
    const rectX = isAr ? tagX - tagW : tagX;
    tagEls.push(`
      <rect x="${rectX}" y="${tagY}" width="${tagW}" height="46" rx="23" fill="${BRAND_TEAL}" />
      <text x="${rectX + tagW / 2}" y="${tagY + 30}" font-family="${fontFamily}" font-size="23" fill="#FFFFFF" text-anchor="middle">${escapeXml(tag)}</text>
    `);
    tagX = isAr ? rectX - 12 : rectX + tagW + 12;
  }

  const storyTspans = storyLines
    .map((line, i) => `<tspan x="${textStartX}" dy="${i === 0 ? 0 : 38}">${escapeXml(line)}</tspan>`)
    .join('');

  const contactLabelText = 'CONTACT INFO:';

  const overlaySvg = `
    <svg width="${CANVAS_W}" height="${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          @font-face { font-family: 'NotoSans'; src: url(data:font/woff2;base64,${FONT_LATIN_REGULAR}) format('woff2'); font-weight: 400; }
          @font-face { font-family: 'NotoSans'; src: url(data:font/woff2;base64,${FONT_LATIN_MEDIUM}) format('woff2'); font-weight: 500; }
          @font-face { font-family: 'NotoSansArabic'; src: url(data:font/woff2;base64,${FONT_ARABIC_REGULAR}) format('woff2'); font-weight: 400; }
          @font-face { font-family: 'NotoSansArabic'; src: url(data:font/woff2;base64,${FONT_ARABIC_MEDIUM}) format('woff2'); font-weight: 500; }
        </style>
      </defs>

      ${paperTextureSvg(CANVAS_W, CANVAS_H)}

      <!-- Story box: name, tags, description -->
      <rect x="${STORY_BOX.x}" y="${STORY_BOX.y}" width="${STORY_BOX.w}" height="${STORY_BOX.h}" rx="${STORY_BOX.r}" fill="${BOX_FILL}" />

      <text x="${textStartX}" y="${STORY_BOX.y + 58}" font-family="${fontFamily}" font-size="46" font-weight="500" fill="${BRAND_NAVY}" text-anchor="${anchorAttr}">${escapeXml(info.name)}</text>

      ${tagEls.join('')}

      <text x="${textStartX}" y="${tagY + 90}" font-family="${fontFamily}" font-size="28" fill="${BRAND_NAVY}" text-anchor="${anchorAttr}" font-style="italic">${storyTspans}</text>

      <!-- "CONTACT INFO:" label -->
      <text x="${CANVAS_W / 2}" y="${CONTACT_LABEL_Y}" font-family="${fontFamily}" font-size="34" font-weight="500" fill="${BRAND_NAVY}" text-anchor="middle" letter-spacing="1">${contactLabelText}</text>

      <!-- Contact box: phone number -->
      <rect x="${CONTACT_BOX.x}" y="${CONTACT_BOX.y}" width="${CONTACT_BOX.w}" height="${CONTACT_BOX.h}" rx="${CONTACT_BOX.r}" fill="${BOX_FILL}" />
      <text x="${CANVAS_W / 2}" y="${CONTACT_BOX.y + CONTACT_BOX.h / 2 + 14}" font-family="${fontFamily}" font-size="42" fill="${BRAND_NAVY}" text-anchor="middle">${escapeXml(info.phone)}</text>
    </svg>
  `;

  const finalImage = await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 3, background: PAPER_BG },
  })
    .composite([
      { input: Buffer.from(overlaySvg), left: 0, top: 0 },
      { input: photoBuffer, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();

  return finalImage;
}

module.exports = { generateStoryImage };
