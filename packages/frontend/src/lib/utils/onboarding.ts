import { driver } from 'driver.js';
import type { DriveStep, Config } from 'driver.js';
import { browserStorage } from '$lib/contracts';

const ONBOARDING_KEY = 'site-studio-onboarding-completed';

export function hasCompletedOnboarding(): boolean {
	return browserStorage()?.getItem(ONBOARDING_KEY) === 'true';
}

export function markOnboardingComplete(): void {
	browserStorage()?.setItem(ONBOARDING_KEY, 'true');
}

function tourConfig(steps: DriveStep[]): Config {
	return {
		showProgress: true,
		showButtons: ['next', 'previous', 'close'],
		progressText: '{{current}} of {{total}}',
		nextBtnText: 'Continue',
		prevBtnText: 'Back',
		doneBtnText: 'Done',
		disableActiveInteraction: true,
		onDestroyed: () => {
			markOnboardingComplete();
		},
		steps
	};
}

export function createDashboardTour() {
	const steps: DriveStep[] = [
		{
			popover: {
				title: 'Site Studio',
				description:
					'Make a website for your course, project, or research.\n\nThis short tour shows the main parts. Click "Continue" to move through each step.',
				side: 'bottom',
				align: 'center'
			}
		},
		{
			element: '[data-tour="new-project"]',
			popover: {
				title: 'Create a project',
				description:
					'This button creates a new project. You can start from a template or from a blank page.',
				side: 'bottom',
				align: 'start'
			}
		},
		{
			popover: {
				title: 'What happens next',
				description:
					'After creating a project, you\'ll enter the editor where you can:\n\n• Describe what you want and the assistant builds it\n• Preview changes as they are made\n• Edit code by hand if you want',
				side: 'bottom' as const,
				align: 'center'
			}
		},
		{
			popover: {
				title: 'Next steps',
				description: 'Create a project and describe what you want to build.',
				side: 'bottom' as const,
				align: 'center'
			}
		}
	];

	return driver(tourConfig(steps));
}

export function createEditorTour() {
	const steps: DriveStep[] = [
		{
			element: '.agent-chat',
			popover: {
				title: 'Assistant',
				description:
					'Describe what you want to build in plain English, and the assistant makes the changes.',
				side: 'right',
				align: 'start'
			}
		},
		{
			element: '.input-field',
			popover: {
				title: 'Message box',
				description:
					'Type your request here. For example:\n• "Create a hero section with a large title"\n• "Add a contact form"\n• "Make the background blue"',
				side: 'top',
				align: 'center'
			}
		},
		{
			element: '.input-container .icon-btn',
			popover: {
				title: 'Attach files',
				description:
					'Click the + button to attach images or documents, then refer to them in your message.\n\nImages, PDFs, and text files are supported.',
				side: 'top',
				align: 'start'
			}
		},
		{
			element: '.preview-area',
			popover: {
				title: 'Preview',
				description: 'Your site appears here and updates as changes are made.',
				side: 'left',
				align: 'center'
			}
		},
		{
			element: '.panel-toggle-right, .code-panel',
			popover: {
				title: 'Code editor',
				description: 'Open the code editor if you want to edit by hand.',
				side: 'left',
				align: 'end'
			}
		}
	];

	return driver(tourConfig(steps));
}
