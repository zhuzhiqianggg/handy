import type { Config } from 'tailwindcss';

/**
 * Handy · 顺手 设计令牌
 * 风格：浅色、扁平、少层级、单一品牌强调色、低对比分割线、无重阴影。
 * 深浅色通过 CSS 变量 + `dark:` 前缀切换（MVP 保证浅色）。
 */
const config: Config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 语义色（映射到 index.css 中的 CSS 变量）
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // 单一品牌强调色（蓝）
        brand: {
          DEFAULT: 'hsl(var(--brand))',
          foreground: 'hsl(var(--brand-foreground))',
          muted: 'hsl(var(--brand-muted))',
        },
      },
      fontFamily: {
        sans: [
          '"Microsoft YaHei"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Source Han Sans SC"',
          '"Noto Sans SC"',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Cascadia Code"',
          'Consolas',
          '"Courier New"',
          'monospace',
        ],
      },
      borderRadius: {
        sm: 'calc(var(--radius) - 4px)',
        md: 'calc(var(--radius) - 2px)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + 4px)',
      },
      boxShadow: {
        // 扁平优先：仅保留极浅的浮层阴影
        panel: '0 1px 2px 0 hsl(215 16% 47% / 0.08)',
        popover: '0 4px 12px -2px hsl(215 16% 47% / 0.12)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-down': {
          from: { opacity: '0', transform: 'translateY(-4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'slide-down': 'slide-down 140ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
