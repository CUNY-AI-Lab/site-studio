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
 * Hard cap on how many toasts stack at once. Error toasts persist (duration 0),
 * so a burst of repeated failures would otherwise grow the stack without bound.
 * When adding a toast would exceed the cap, the oldest is dropped.
 */
const MAX_TOASTS = 4;

/**
 * Reactive list of active toasts. Read by the single <Toaster /> mounted at the
 * root layout. Mutated via the exported `toast` helpers below.
 */
export const toasts = $state<Toast[]>([]);

function push(kind: ToastKind, message: string, duration: number): number {
	// SS-23: de-dupe — if an identical (kind + message) toast is already showing,
	// don't stack a duplicate. Return the existing id so callers still get a handle.
	const existing = toasts.find((t) => t.kind === kind && t.message === message);
	if (existing) {
		return existing.id;
	}

	const id = ++counter;
	toasts.push({ id, kind, message, duration });

	// SS-23: cap the stack. Drop the oldest toasts so persistent errors can't pile
	// up unboundedly on repeated failures.
	while (toasts.length > MAX_TOASTS) {
		toasts.shift();
	}

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
