/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: '#0d1117', card: '#161b22', hover: '#1c2128', border: '#30363d' },
        accent: { DEFAULT: '#2f81f7', hover: '#388bfd', dim: '#1f6feb' },
        green: { DEFAULT: '#3fb950', dim: '#238636', bg: '#0d1f0d' },
        red: { DEFAULT: '#f85149', dim: '#da3633', bg: '#1f0d0d' },
        amber: { DEFAULT: '#d29922', dim: '#9e6a03', bg: '#1f1a0d' },
        // Contrast on #161b22 (card): DEFAULT 14.6:1, muted 8.1:1, faint 5.6:1.
        // Was muted 5.6:1 and faint 2.09:1 — faint failed every threshold there is.
        text: { DEFAULT: '#e6edf3', muted: '#a8b2be', faint: '#8b949e' }
      },
      // Tailwind's default xs/sm are 12px/14px. At 12px, on a dark surface, dense
      // numeric rows are genuinely hard to read — and text-xs alone appears 200+
      // times here. Lifting the scale once fixes all of them.
      fontSize: {
        xs:   ['0.8125rem', { lineHeight: '1.15rem' }],  // 13px  (was 12)
        sm:   ['0.9063rem', { lineHeight: '1.3rem'  }],  // 14.5px (was 14)
        base: ['1rem',      { lineHeight: '1.5rem'  }],
      },
      fontFamily: {
        sans: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace'],
        display: ['DM Sans', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
};
