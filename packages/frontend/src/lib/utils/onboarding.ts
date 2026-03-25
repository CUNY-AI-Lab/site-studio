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
					'Build professional academic websites using AI.\n\nThis quick tour will show you the key features. Click "Continue" below to proceed through each step.',
				side: 'bottom',
				align: 'center'
			}
		},
		{
			element: '[data-tour="new-project"]',
			popover: {
				title: 'Create Your First Project',
				description:
					'This button lets you create a new project. You can choose from pre-built templates or start with a blank canvas.',
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
					'That\'s it! Create your first project and describe what you want to build. The AI will guide you through the process.\n\nClick "Get Started" to begin!',
				side: 'center',
				align: 'center'
			}
		}
	];

	const config: Config = {
		showProgress: true,
		showButtons: ['next', 'previous', 'close'],
		progressText: '{{current}} of {{total}}',
		nextBtnText: 'Continue',
		prevBtnText: 'Back',
		doneBtnText: 'Get Started',
		disableActiveInteraction: true,
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
			element: '.agent-chat',
			popover: {
				title: 'AI Chat Assistant',
				description:
					'This is your AI assistant panel. Here you can describe what you want to build in plain English.',
				side: 'right',
				align: 'start'
			}
		},
		{
			element: '.input-field',
			popover: {
				title: 'Chat Input',
				description:
					'Type your requests here! For example:\n• "Create a hero section with a large title"\n• "Add a contact form"\n• "Make the background blue"',
				side: 'top',
				align: 'center'
			}
		},
		{
			element: '.input-container .icon-btn',
			popover: {
				title: 'Upload Files',
				description:
					'Click the + button to attach images or documents. You can reference them in your chat messages.\n\nSupported: images, PDFs, text files, and more.',
				side: 'top',
				align: 'start'
			}
		},
		{
			element: '.preview-area',
			popover: {
				title: 'Live Preview',
				description: 'Your site appears here and updates in real-time as the AI makes changes. What you see is what you get!',
				side: 'left',
				align: 'center'
			}
		},
		{
			element: '.panel-toggle-right, .code-panel',
			popover: {
				title: 'Code Editor (Optional)',
				description:
					'Want to tweak the code yourself? You can open the code editor here to make manual adjustments.\n\nYou\'re all set! Click "Got It!" to start building.',
				side: 'left',
				align: 'end'
			}
		}
	];

	const config: Config = {
		showProgress: true,
		showButtons: ['next', 'previous', 'close'],
		progressText: '{{current}} of {{total}}',
		nextBtnText: 'Continue',
		prevBtnText: 'Back',
		doneBtnText: 'Got It!',
		disableActiveInteraction: true,
		onDestroyed: () => {
			markOnboardingComplete();
		},
		steps
	};

	return driver(config);
}
