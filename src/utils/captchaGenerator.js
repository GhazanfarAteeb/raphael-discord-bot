import { createCanvas } from '@napi-rs/canvas';
import './fonts.js';

/**
 * Generate a captcha image with distortion and noise
 * @param {string} code - The captcha code to render
 * @returns {Promise<Buffer>} PNG image buffer
 */
export async function generateCaptchaImage(code) {
  const width = 280;
  const height = 100;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background gradient
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#1a1a2e');
  gradient.addColorStop(0.5, '#16213e');
  gradient.addColorStop(1, '#0f3460');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Add noise dots
  for (let i = 0; i < 150; i++) {
    ctx.fillStyle = `rgba(${Math.random() * 255}, ${Math.random() * 255}, ${Math.random() * 255}, ${Math.random() * 0.5})`;
    ctx.beginPath();
    ctx.arc(
      Math.random() * width,
      Math.random() * height,
      Math.random() * 2 + 1,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  // Add random lines for confusion
  for (let i = 0; i < 8; i++) {
    ctx.strokeStyle = `rgba(${Math.random() * 255}, ${Math.random() * 255}, ${Math.random() * 255}, ${Math.random() * 0.5 + 0.2})`;
    ctx.lineWidth = Math.random() * 2 + 1;
    ctx.beginPath();
    ctx.moveTo(Math.random() * width, Math.random() * height);
    ctx.bezierCurveTo(
      Math.random() * width, Math.random() * height,
      Math.random() * width, Math.random() * height,
      Math.random() * width, Math.random() * height
    );
    ctx.stroke();
  }

  // Draw each character with random styling
  const colors = ['#e94560', '#00fff5', '#00d9ff', '#f9ed69', '#f08a5d', '#b83b5e', '#6a2c70'];
  const charWidth = width / (code.length + 1);

  for (let i = 0; i < code.length; i++) {
    const char = code[i];

    // Random rotation
    const rotation = (Math.random() - 0.5) * 0.5;

    // Random font size
    const fontSize = 36 + Math.random() * 12;

    // Random color
    const color = colors[Math.floor(Math.random() * colors.length)];

    // Random y offset
    const yOffset = 55 + (Math.random() - 0.5) * 20;

    ctx.save();
    ctx.translate(charWidth * (i + 0.8), yOffset);
    ctx.rotate(rotation);

    // Shadow for depth
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    // Text styling
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Draw character outline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeText(char, 0, 0);

    // Draw character
    ctx.fillText(char, 0, 0);

    ctx.restore();
  }

  // Add more overlay noise
  for (let i = 0; i < 50; i++) {
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.1})`;
    ctx.beginPath();
    ctx.arc(
      Math.random() * width,
      Math.random() * height,
      Math.random() * 3,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  // Add subtle grid pattern
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 10) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 10) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}

/**
 * Generate a random captcha code
 * @param {number} length - Length of the code
 * @returns {string} The captcha code
 */
export function generateCaptchaCode(length = 6) {
  // Exclude confusing characters: 0/O, 1/I/L
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export default { generateCaptchaImage, generateCaptchaCode };
