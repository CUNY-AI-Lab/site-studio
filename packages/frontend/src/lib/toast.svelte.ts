export type ToastKind = 'error' | 'success' | 'info';

export interface Toast {
	id: number;
	kind: ToastKind;
	message: string;
	/** ms until auto-dismiss; 0 or undefined means persist until dismissed. */
	duration: number;
}

let counter = 0;

/**
 * Reactive list of active toasts. Read by the single <Toaster /> mounted at the
 * root layout. Mutated via the exported `toast` helpers below.
 */
export const toasts = $state<Toast[]>([]);

function push(kind: ToastKind, message: string, duration: number): number {
	const id = ++counter;
	toasts.push({ id, kind, message, duration });
	if (duration > 0) {
		setTimeout(() => dismiss(id), duration);
	}
	return id;
}

export function dismiss(id: number) {
	const index = toasts.findIndex((t) => t.id === id);
	if (index !== -1) {
		toasts.splice(index, 1);
	}
}

export const toast = {
	/** Errors persist until the user dismisses them. */
	error(message: string): number {
		return push('error', message, 0);
	},
	success(message: string): number {
		return push('success', message, 5000);
	},
	info(message: string): number {
		return push('info', message, 5000);
	}
};
