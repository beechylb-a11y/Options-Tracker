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
        text: { DEFAULT: '#e6edf3', muted: '#8b949e', faint: '#484f58' }
      },
      fontFamily: {
        sans: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace'],
        display: ['DM Sans', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
};
