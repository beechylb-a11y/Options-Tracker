/** @type {import('tailwindcss').Config} */
// Colours are CSS variables (index.css) so the day/night theme swaps them in one place.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: 'rgb(var(--rgb-0d1117) / <alpha-value>)', card: 'rgb(var(--rgb-161b22) / <alpha-value>)', hover: 'rgb(var(--rgb-1c2128) / <alpha-value>)', border: 'rgb(var(--rgb-30363d) / <alpha-value>)' },
        accent: { DEFAULT: 'rgb(var(--rgb-2f81f7) / <alpha-value>)', hover: 'rgb(var(--rgb-388bfd) / <alpha-value>)', dim: 'rgb(var(--rgb-1f6feb) / <alpha-value>)' },
        green: { DEFAULT: 'rgb(var(--rgb-3fb950) / <alpha-value>)', dim: 'rgb(var(--rgb-238636) / <alpha-value>)', bg: 'rgb(var(--rgb-0d1f0d) / <alpha-value>)' },
        red: { DEFAULT: 'rgb(var(--rgb-f85149) / <alpha-value>)', dim: 'rgb(var(--rgb-da3633) / <alpha-value>)', bg: 'rgb(var(--rgb-1f0d0d) / <alpha-value>)' },
        amber: { DEFAULT: 'rgb(var(--rgb-d29922) / <alpha-value>)', dim: 'rgb(var(--rgb-9e6a03) / <alpha-value>)', bg: 'rgb(var(--rgb-1f1a0d) / <alpha-value>)' },
        // Contrast on #161b22 (card): DEFAULT 14.6:1, muted 8.1:1, faint 5.6:1.
        // Was muted 5.6:1 and faint 2.09:1 — faint failed every threshold there is.
        text: { DEFAULT: 'rgb(var(--rgb-e6edf3) / <alpha-value>)', muted: 'rgb(var(--rgb-a8b2be) / <alpha-value>)', faint: 'rgb(var(--rgb-8b949e) / <alpha-value>)' }
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
