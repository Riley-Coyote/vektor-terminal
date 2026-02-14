import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

// Generate SVG icon
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="bg" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#1e1e1e"/>
      <stop offset="100%" stop-color="#111111"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="1024" rx="180" fill="url(#bg)"/>
  <circle cx="512" cy="512" r="280" fill="none" stroke="#d4a574" stroke-width="48" stroke-linecap="round"/>
  <line x1="232" y1="512" x2="792" y2="512" stroke="#d4a574" stroke-width="48" stroke-linecap="round"/>
</svg>`;

writeFileSync('build/icon.svg', svg);
console.log('SVG icon written to build/icon.svg');

// Try to convert to PNG with sips (macOS built-in)
try {
  // First write as SVG, then convert
  execSync('which rsvg-convert && rsvg-convert -w 1024 -h 1024 build/icon.svg > build/icon.png', { stdio: 'pipe' });
  console.log('PNG icon generated');
} catch {
  try {
    // Fallback: use sips if available
    execSync('qlmanage -t -s 1024 -o build/ build/icon.svg 2>/dev/null && mv build/icon.svg.png build/icon.png', { stdio: 'pipe' });
    console.log('PNG icon generated via qlmanage');
  } catch {
    console.log('Could not auto-convert SVG to PNG. Manual conversion needed.');
    console.log('Run: npx svgexport build/icon.svg build/icon.png 1024:1024');
  }
}
