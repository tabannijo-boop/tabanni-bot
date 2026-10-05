// Generates a finished, ready-to-post Instagram Story image (1080x1920 PNG)
// from up to 4 photos plus the pet's info. This is the whole point of this
// file: turn "a pile of raw photos + text in a DM" into "one image your team
// can open and tap Add to Story", no design work needed.
//
// Layout matches tabanni's reference template: a 2x2 photo collage across
// the top, a light paper-textured background, a rounded "story" box with
// the pet's info, a hand-lettered "CONTACT INFO:" label, and a rounded
// contact box with the phone number (or fallback text) at the very bottom.
//
// Uses sharp for compositing (fast, well-supported on Render).
//
// NOTE ON FONTS: the renderer (librsvg) ignores @font-face fonts embedded
// in an SVG, so text is drawn in the server's default sans font, not in the
// Noto Sans files below. They are still loaded so nothing else changes, but
// text sizing in this file is measured against the font actually in use
// rather than assumed.

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

// Where the description sits inside the story box. It starts just under the
// row of tags and may use the full width of the box and everything down to
// a small bottom margin. (The old layout wrapped at ~46 characters and only
// allowed two lines, which used about half the available space and cut
// descriptions off mid-sentence.)
const STORY_PAD_X = 40;
const STORY_TEXT_TOP = STORY_BOX.y + 146;
const STORY_TEXT_W = STORY_BOX.w - STORY_PAD_X * 2;
const STORY_TEXT_MAX_H = STORY_BOX.h - 146 - 24;
const STORY_FONT_SIZES = [28, 26, 24, 22]; // tried largest first, first one that fits wins

// Photos closer than this (out of 64) in perceptual-hash distance are treated
// as the same picture. Checked against real photos: near-identical shots of
// the same pose scored 1-6, genuinely different photos scored 30+.
const DUPLICATE_PHOTO_DISTANCE = 10;

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

// Emoji and pictograph characters have no glyphs in the server font and
// would draw as empty boxes on the card, so they are removed from anything
// printed on it. (The full text, emoji included, still goes to Telegram.)
function cleanCardText(str) {
  return String(str || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Very rough line-wrapping, still used for the contact box text and as the
// emergency fallback for the description (see renderStoryTextFallbackSvg).
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

// The contact box used to always render info.phone at one fixed large font
// size, on one line, no wrapping — fine for a real phone number, but a
// declined phone now comes through as fallback text (e.g. "Not shared,
// contact via Instagram"), which is far too long for the box at that size.
// This picks the largest of a few font-size/line presets that plausibly
// fits the text, wrapping to a second line if needed.
function fitContactText(text) {
  const clean = String(text || '').trim();
  const attempts = [
    { fontSize: 42, maxCharsPerLine: 14, maxLines: 1 },
    { fontSize: 32, maxCharsPerLine: 20, maxLines: 1 },
    { fontSize: 26, maxCharsPerLine: 26, maxLines: 2 },
    { fontSize: 22, maxCharsPerLine: 34, maxLines: 2 },
  ];
  for (const attempt of attempts) {
    if (clean.length <= attempt.maxCharsPerLine * attempt.maxLines) {
      return { ...attempt, lines: wrapText(clean, attempt.maxCharsPerLine, attempt.maxLines) };
    }
  }
  const last = attempts[attempts.length - 1];
  return { ...last, lines: wrapText(clean, last.maxCharsPerLine, last.maxLines) };
}

// --- Photos: fetch, drop duplicates, pick the best 4 ----------------------

async function fetchPhotoBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch photo: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// A "difference hash": shrink the photo to 9x8 greyscale and record whether
// each pixel is brighter than its right-hand neighbour. Two copies of the
// same picture (or near-identical frames of the same shot) end up with
// almost the same 64 bits even if the files differ, which is what lets us
// spot duplicates when the same photo is sent more than once.
async function perceptualHash(buffer) {
  const { data } = await sharp(buffer)
    .rotate()
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
    }
  }
  return bits;
}

function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// Fetches every candidate photo, then keeps up to maxPhotos DISTINCT ones.
// Candidates are in the order they were sent (oldest first); when the same
// picture appears more than once the most recent copy is the one kept, and
// the result is returned in the original sending order.
async function pickDistinctPhotos(photoUrls, maxPhotos = 4) {
  const fetched = await Promise.all(
    photoUrls.map(async (url) => {
      try {
        const buffer = await fetchPhotoBuffer(url);
        const hash = await perceptualHash(buffer);
        return { url, buffer, hash };
      } catch (err) {
        console.warn(`Story card: skipped a photo that could not be loaded (${err.message}).`);
        return null;
      }
    })
  );
  const usable = fetched.filter(Boolean);

  const kept = [];
  for (let i = usable.length - 1; i >= 0 && kept.length < maxPhotos; i--) {
    const candidate = usable[i];
    const duplicateOf = kept.find((k) => hammingDistance(k.hash, candidate.hash) <= DUPLICATE_PHOTO_DISTANCE);
    if (duplicateOf) {
      console.log('Story card: skipped a duplicate photo.');
      continue;
    }
    kept.push(candidate);
  }
  return kept.reverse();
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

// --- Description text: measured, not guessed ------------------------------

// Cuts text down to at most maxChars, ending on a complete sentence when
// there is one, so a long description is shortened cleanly instead of
// stopping mid-sentence. Only if there is no sentence end to cut at does it
// fall back to the last whole word plus an ellipsis.
function truncateAtSentence(text, maxChars) {
  const t = String(text || '').trim();
  if (t.length <= maxChars) return t;
  const slice = t.slice(0, maxChars);
  let lastEnd = -1;
  const re = /[.!?؟。](?=\s|$)/g;
  let m;
  while ((m = re.exec(slice)) !== null) lastEnd = m.index;
  if (lastEnd >= maxChars * 0.5) return slice.slice(0, lastEnd + 1);
  return slice.replace(/\s+\S*$/, '') + '…';
}

async function renderStoryTextBlock(text, size, isAr) {
  // Pango markup lays the text out and wraps it to the box width. For
  // Arabic, 'left' alignment means "start of the line", which for a
  // right-to-left paragraph is the right-hand side, as wanted. Italic is
  // skipped for Arabic because slanted Arabic script looks wrong.
  const style = isAr ? '' : ' style="italic"';
  return sharp({
    text: {
      text: `<span foreground="${BRAND_NAVY}"${style}>${escapeXml(text)}</span>`,
      font: `sans ${size}`,
      width: STORY_TEXT_W,
      rgba: true,
      wrap: 'word',
      align: 'left',
      dpi: 72,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
}

// Finds the largest font size at which the whole description fits inside
// the story box. If it does not fit even at the smallest size, the text is
// shortened (at a sentence boundary where possible) and tried again, so the
// card always ends up complete and tidy rather than overflowing or being
// chopped mid-word. Returns null if there is no description at all.
async function renderStoryText(rawText, isAr) {
  let text = cleanCardText(rawText);
  if (!text) return null;
  for (let attempt = 0; attempt < 8; attempt++) {
    for (const size of STORY_FONT_SIZES) {
      const block = await renderStoryTextBlock(text, size, isAr);
      if (block.info.height <= STORY_TEXT_MAX_H) return block;
    }
    text = truncateAtSentence(text, Math.floor(text.length * 0.8));
  }
  return renderStoryTextBlock(text, STORY_FONT_SIZES[STORY_FONT_SIZES.length - 1], isAr);
}

// Emergency fallback if the text layout above is ever unavailable: the
// previous approach (hand-wrapped lines in the SVG), just with the wider
// line length and extra lines. Not expected to be used.
function renderStoryTextFallbackSvg(text, isAr, textStartX, y, fontFamily, anchorAttr) {
  const lines = wrapText(cleanCardText(text), isAr ? 44 : 58, 4);
  const tspans = lines
    .map((line, i) => `<tspan x="${textStartX}" dy="${i === 0 ? 0 : 36}">${escapeXml(line)}</tspan>`)
    .join('');
  return `<text x="${textStartX}" y="${y}" font-family="${fontFamily}" font-size="26" fill="${BRAND_NAVY}" text-anchor="${anchorAttr}"${isAr ? '' : ' font-style="italic"'}>${tspans}</text>`;
}

// Generates a subtle paper-grain texture as an SVG filter, approximating
// the reference template's kraft-paper background.
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
 * @param {string[]} info.photoUrls - candidate photo URLs, oldest first (up to 10).
 *   Duplicates are removed and up to 4 distinct photos are used.
 * @param {string} info.name
 * @param {string} info.animalType - 'dog' | 'cat' | etc
 * @param {string} info.age
 * @param {string} info.gender
 * @param {string} info.vaccination
 * @param {string} info.story - the description; shrunk or shortened cleanly to fit
 * @param {string} info.phone - a real phone number, OR fallback text if declined
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function generateStoryImage(info) {
  const candidateUrls = (info.photoUrls || []).slice(-10);

  // 1) Pick up to 4 distinct photos and lay them out as the collage.
  const photos = await pickDistinctPhotos(candidateUrls, 4);
  const layout = buildGridLayout(photos.length, CANVAS_W, PHOTO_AREA_H);
  const photoBuffers = await Promise.all(
    photos.map((p, i) =>
      sharp(p.buffer)
        .rotate()
        .resize(layout[i].w, layout[i].h, { fit: 'cover', position: 'attention' })
        .toBuffer()
        .catch(() => null)
    )
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

  // 2) Name, tags and contact box go in one SVG overlay; the description is
  // laid out separately (above) so it can be measured to fit.
  const name = cleanCardText(info.name);
  const isAr = isArabicText(name) || isArabicText(info.story);
  const fontFamily = isAr ? 'NotoSansArabic' : 'NotoSans';
  const anchorAttr = isAr ? 'end' : 'start';
  const textStartX = isAr ? STORY_BOX.x + STORY_BOX.w - STORY_PAD_X : STORY_BOX.x + STORY_PAD_X;

  const tags = [info.age, info.gender, info.vaccination].map(cleanCardText).filter(Boolean);

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

  const contactLabelText = 'CONTACT INFO:';

  // Contact box text adapts its font size and wraps to a second line when
  // needed (see fitContactText above).
  const contactFit = fitContactText(cleanCardText(info.phone));
  const contactIsAr = isArabicText(info.phone);
  const contactFontFamily = contactIsAr ? 'NotoSansArabic' : 'NotoSans';
  const contactLineHeight = contactFit.fontSize + 10;
  const contactBlockH = contactFit.lines.length * contactLineHeight;
  const contactStartY = CONTACT_BOX.y + CONTACT_BOX.h / 2 - contactBlockH / 2 + contactFit.fontSize * 0.75;
  const contactTspans = contactFit.lines
    .map((line, i) => `<tspan x="${CANVAS_W / 2}" dy="${i === 0 ? 0 : contactLineHeight}">${escapeXml(line)}</tspan>`)
    .join('');

  // 3) The description, measured to fit the box.
  let storyBlock = null;
  let storyFallbackSvg = '';
  try {
    storyBlock = await renderStoryText(info.story, isAr);
  } catch (err) {
    console.error('Story card: text layout failed, using simple fallback:', err.message);
    storyFallbackSvg = renderStoryTextFallbackSvg(info.story, isAr, textStartX, tagY + 90, fontFamily, anchorAttr);
  }

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

      <text x="${textStartX}" y="${STORY_BOX.y + 58}" font-family="${fontFamily}" font-size="46" font-weight="500" fill="${BRAND_NAVY}" text-anchor="${anchorAttr}">${escapeXml(name)}</text>

      ${tagEls.join('')}

      ${storyFallbackSvg}

      <!-- "CONTACT INFO:" label -->
      <text x="${CANVAS_W / 2}" y="${CONTACT_LABEL_Y}" font-family="${fontFamily}" font-size="34" font-weight="500" fill="${BRAND_NAVY}" text-anchor="middle" letter-spacing="1">${contactLabelText}</text>

      <!-- Contact box: phone number, or fallback text if declined -->
      <rect x="${CONTACT_BOX.x}" y="${CONTACT_BOX.y}" width="${CONTACT_BOX.w}" height="${CONTACT_BOX.h}" rx="${CONTACT_BOX.r}" fill="${BOX_FILL}" />
      <text x="${CANVAS_W / 2}" y="${contactStartY}" font-family="${contactFontFamily}" font-size="${contactFit.fontSize}" fill="${BRAND_NAVY}" text-anchor="middle">${contactTspans}</text>
    </svg>
  `;

  const layers = [{ input: Buffer.from(overlaySvg), left: 0, top: 0 }];
  if (storyBlock) {
    layers.push({ input: storyBlock.data, left: STORY_BOX.x + STORY_PAD_X, top: STORY_TEXT_TOP });
  }
  layers.push({ input: photoBuffer, left: 0, top: 0 });

  return sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 3, background: PAPER_BG },
  })
    .composite(layers)
    .png()
    .toBuffer();
}

module.exports = { generateStoryImage };
