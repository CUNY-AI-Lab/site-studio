/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			colors: {
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))'
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))'
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))'
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))'
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))'
				},
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))'
				},
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))'
				},
				// Open Studio semantic colors
				teal: {
					DEFAULT: 'var(--color-primary)',
					hover: 'var(--color-primary-hover)',
					light: 'var(--color-primary-light)',
					lighter: 'var(--color-primary-lighter)'
				},
				coral: {
					DEFAULT: 'var(--color-secondary)',
					hover: 'var(--color-secondary-hover)',
					light: 'var(--color-secondary-light)'
				},
				amber: {
					DEFAULT: 'var(--color-tertiary)',
					hover: 'var(--color-tertiary-hover)',
					light: 'var(--color-tertiary-light)'
				},
				success: {
					DEFAULT: 'var(--color-success)',
					light: 'var(--color-success-light)'
				},
				warning: {
					DEFAULT: 'var(--color-warning)',
					light: 'var(--color-warning-light)'
				},
				error: {
					DEFAULT: 'var(--color-error)',
					light: 'var(--color-error-light)'
				}
			},
			fontFamily: {
				display: 'var(--font-display)',
				mono: 'var(--font-mono)',
				sans: 'var(--font-sans)'
			},
			borderRadius: {
				none: '0',
				sm: 'var(--radius-sm)',
				DEFAULT: 'var(--radius-md)',
				md: 'var(--radius-md)',
				lg: 'var(--radius-lg)',
				xl: 'var(--radius-xl)',
				'2xl': 'var(--radius-2xl)',
				full: 'var(--radius-full)'
			},
			boxShadow: {
				xs: 'var(--shadow-xs)',
				sm: 'var(--shadow-sm)',
				DEFAULT: 'var(--shadow-md)',
				md: 'var(--shadow-md)',
				lg: 'var(--shadow-lg)',
				xl: 'var(--shadow-xl)',
				inner: 'var(--shadow-inner)',
				'glow-primary': 'var(--shadow-glow-primary)',
				'glow-error': 'var(--shadow-glow-error)',
				'glow-success': 'var(--shadow-glow-success)'
			},
			spacing: {
				xs: 'var(--spacing-xs)',
				sm: 'var(--spacing-sm)',
				md: 'var(--spacing-md)',
				lg: 'var(--spacing-lg)',
				xl: 'var(--spacing-xl)',
				'2xl': 'var(--spacing-2xl)',
				'3xl': 'var(--spacing-3xl)'
			},
			fontSize: {
				xs: 'var(--font-size-xs)',
				sm: 'var(--font-size-sm)',
				base: 'var(--font-size-base)',
				lg: 'var(--font-size-lg)',
				xl: 'var(--font-size-xl)',
				'2xl': 'var(--font-size-2xl)',
				'3xl': 'var(--font-size-3xl)',
				'4xl': 'var(--font-size-4xl)',
				'5xl': 'var(--font-size-5xl)'
			},
			lineHeight: {
				tight: 'var(--line-height-tight)',
				snug: 'var(--line-height-snug)',
				normal: 'var(--line-height-normal)',
				relaxed: 'var(--line-height-relaxed)',
				loose: 'var(--line-height-loose)'
			},
			transitionDuration: {
				fast: '150ms',
				base: '200ms',
				slow: '300ms'
			},
			animation: {
				'fade-in': 'fadeIn var(--transition-base) ease-out',
				'fade-in-up': 'fadeInUp var(--transition-slow) ease-out',
				'fade-in-down': 'fadeInDown var(--transition-slow) ease-out',
				'scale-in': 'scaleIn var(--transition-slow) ease-out',
				'slide-in-right': 'slideInRight var(--transition-slow) ease-out',
				shimmer: 'shimmer 1.5s ease-in-out infinite'
			}
		}
	}
};
