export interface SaveSnapshot {
	projectId: string;
	filePath: string;
	content: string;
}

export interface AutosaveOptions {
	persist: (snapshot: SaveSnapshot) => Promise<boolean>;
	delayMs?: number;
	onSavingChange?: (saving: boolean) => void;
}

export interface Autosave {
	queue(snapshot: SaveSnapshot): void;
	flush(): Promise<boolean>;
	dispose(): void;
}

const DEFAULT_DELAY_MS = 1000;

export function createAutosave(options: AutosaveOptions): Autosave {
	const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
	let queuedSave: SaveSnapshot | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let drainPromise: Promise<boolean> | null = null;
	let disposed = false;

	function clearTimer() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function setSaving(saving: boolean) {
		options.onSavingChange?.(saving);
	}

	function drain(): Promise<boolean> {
		if (drainPromise) {
			return drainPromise;
		}

		drainPromise = (async () => {
			setSaving(true);

			try {
				while (queuedSave && !disposed) {
					const snapshot = queuedSave;
					queuedSave = null;

					const didSave = await options.persist(snapshot);
					if (!didSave) {
						// SS-35: a failed save must stay pending unless newer content
						// arrived while it was in flight; last content wins for a file.
						if (!queuedSave && !disposed) {
							queuedSave = snapshot;
						}
						return false;
					}
				}

				return true;
			} finally {
				setSaving(false);
				drainPromise = null;
			}
		})();

		return drainPromise;
	}

	return {
		queue(snapshot: SaveSnapshot) {
			if (disposed) return;

			queuedSave = snapshot;
			clearTimer();
			timer = setTimeout(() => {
				timer = null;
				void drain();
			}, delayMs);
		},

		async flush() {
			clearTimer();

			if (disposed) {
				return true;
			}

			if (drainPromise) {
				return drainPromise;
			}

			if (!queuedSave) {
				return true;
			}

			return drain();
		},

		dispose() {
			disposed = true;
			clearTimer();
			queuedSave = null;
		}
	};
}
