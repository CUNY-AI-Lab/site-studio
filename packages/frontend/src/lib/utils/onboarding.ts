import { driver } from 'driver.js';
import type { DriveStep, Config } from 'driver.js';

const ONBOARDING_KEY = 'site-studio-onboarding-completed';

export function hasCompletedOnboarding(): boolean {
	if (typeof localStorage === 'undefined') return true;
	return localStorage.getItem(ONBOARDING_KEY) === 'true';
}

export function markOnboardingComplete(): void {
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem(ONBOARDING_KEY, 'true');
	}
}

export function resetOnboarding(): void {
	if (typeof localStorage !== 'undefined') {
		localStorage.removeItem(ONBOARDING_KEY);
	}
}

export function createDashboardTour() {
	const steps: DriveStep[] = [
		{
			popover: {
				title: 'Welcome to Site Studio! 🎨',
				description:
					'Build professional academic websites using AI. Let\'s take a quick tour to get you started.',
				side: 'bottom',
				align: 'center'
			}
		},
		{
			element: '.dashboard-header button, .empty-state button',
			popover: {
				title: 'Create Your First Project',
				description:
					'Start by creating a new project. You can choose from pre-built templates or start with a blank canvas.',
				side: 'bottom',
				align: 'start'
			}
		},
		{
			popover: {
				title: 'What Happens Next?',
				description:
					'After creating a project, you\'ll enter the editor where you can:\n\n• Chat with AI to build your site\n• Preview changes in real-time\n• Edit code manually if needed',
				side: 'center',
				align: 'center'
			}
		},
		{
			popover: {
				title: 'Ready to Start! 🚀',
				description:
					'Create your first project and describe what you want to build. The AI will guide you through the process.',
				side: 'center',
				align: 'center'
			}
		}
	];

	const config: Config = {
		showProgress: true,
		showButtons: ['next', 'previous', 'close'],
		progressText: '{{current}} of {{total}}',
		nextBtnText: 'Next',
		prevBtnText: 'Previous',
		doneBtnText: 'Get Started',
		onDestroyed: () => {
			markOnboardingComplete();
		},
		steps
	};

	return driver(config);
}

export function createEditorTour() {
	const steps: DriveStep[] = [
		{
			element: '.chat-sidebar',
			popover: {
				title: 'AI Chat Assistant',
				description:
					'Describe what you want in plain English. For example: "Create a hero section" or "Add a contact form"',
				side: 'right',
				align: 'start'
			}
		},
		{
			element: '.preview-area',
			popover: {
				title: 'Live Preview',
				description: 'See your site update in real-time as the AI makes changes. What you see is what you get!',
				side: 'left',
				align: 'center'
			}
		},
		{
			element: '.panel-toggle-right, .code-panel',
			popover: {
				title: 'Code Editor (Optional)',
				description:
					'Want to tweak the code yourself? Click here to open the code editor and make manual adjustments.',
				side: 'left',
				align: 'end'
			}
		}
	];

	const config: Config = {
		showProgress: true,
		showButtons: ['next', 'previous', 'close'],
		progressText: '{{current}} of {{total}}',
		nextBtnText: 'Next',
		prevBtnText: 'Previous',
		doneBtnText: 'Got It!',
		steps
	};

	return driver(config);
}
