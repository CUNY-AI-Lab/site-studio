export interface SaveSnapshot {
	projectId: string;
	filePath: string;
	content: string;
}

export interface AutosaveOptions {
	persist: (snapshot: SaveSnapshot, signal: AbortSignal) => Promise<boolean>;
	delayMs?: number;
	/** Maximum time an interaction waits for one file persistence operation. */
	persistTimeoutMs?: number;
	onSavingChange?: (saving: boolean) => void;
}

export interface Autosave {
	queue(snapshot: SaveSnapshot): void;
	pending(): SaveSnapshot | null;
	flush(): Promise<boolean>;
	dispose(): void;
}

const DEFAULT_DELAY_MS = 1000;
const DEFAULT_PERSIST_TIMEOUT_MS = 15_000;

interface ActivePersist {
	snapshot: SaveSnapshot;
	controller: AbortController;
	promise: Promise<boolean>;
	removeTimeoutListener: () => void;
	detached: boolean;
}

interface AbortWait {
	promise: Promise<void>;
	cleanup: () => void;
}

function waitForAbort(signal: AbortSignal): AbortWait {
	let resolveAbort!: () => void;
	const onAbort = () => {
		signal.removeEventListener('abort', onAbort);
		resolveAbort();
	};
	const promise = new Promise<void>((resolve) => {
		resolveAbort = resolve;
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});

	return {
		promise,
		cleanup: () => signal.removeEventListener('abort', onAbort)
	};
}

function sameSnapshot(left: SaveSnapshot, right: SaveSnapshot): boolean {
	return (
		left.projectId === right.projectId &&
		left.filePath === right.filePath &&
		left.content === right.content
	);
}

export function createAutosave(options: AutosaveOptions): Autosave {
	const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
	const persistTimeoutMs = options.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT_MS;
	let queuedSave: SaveSnapshot | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let drainPromise: Promise<boolean> | null = null;
	let activePersist: ActivePersist | null = null;
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

	function finishPersist(operation: ActivePersist, didSave: boolean) {
		if (activePersist !== operation) return;

		activePersist = null;
		operation.removeTimeoutListener();
		if (operation.detached && didSave && queuedSave && sameSnapshot(queuedSave, operation.snapshot)) {
			// A late result from a timed-out operation is still authoritative when
			// it confirms the exact snapshot that was retained for retry.
			queuedSave = null;
		}

		// A timed-out operation remains the sole owner of its write until it
		// settles. Once it does, a newer queued snapshot may proceed. Do not
		// retry the timed-out snapshot itself: its result is still uncertain, and
		// starting it again could create a concurrent write. A regular failed
		// operation keeps the existing explicit-retry behavior.
		const timedOut = operation.detached || operation.controller.signal.aborted;
		if (timedOut && !disposed && queuedSave !== null && !sameSnapshot(queuedSave, operation.snapshot)) {
			const drainNewerSave = () => {
				if (!disposed && activePersist === null && queuedSave !== null && !sameSnapshot(queuedSave, operation.snapshot)) {
					void drain();
				}
			};
			const currentDrain = drainPromise;
			if (currentDrain) {
				// The operation can settle before the current drain has observed its
				// timeout. Wait for that drain to finish before starting the newer
				// write, otherwise drain() just returns the current promise and the
				// queued snapshot can remain stranded.
				void currentDrain.then(drainNewerSave, drainNewerSave);
			} else {
				drainNewerSave();
			}
		}
	}

	function startPersist(snapshot: SaveSnapshot): ActivePersist {
		const controller = new AbortController();
		const timeoutSignal = AbortSignal.timeout(persistTimeoutMs);
		const forwardTimeout = () => controller.abort(timeoutSignal.reason);
		timeoutSignal.addEventListener('abort', forwardTimeout, { once: true });
		const operation: ActivePersist = {
			snapshot,
			controller,
			promise: Promise.resolve().then(() => options.persist(snapshot, controller.signal)),
			removeTimeoutListener: () => timeoutSignal.removeEventListener('abort', forwardTimeout),
			detached: false
		};
		activePersist = operation;
		void operation.promise.then(
			(didSave) => finishPersist(operation, didSave),
			() => finishPersist(operation, false)
		);
		return operation;
	}

	async function awaitPersist(operation: ActivePersist): Promise<boolean> {
		const abort = waitForAbort(operation.controller.signal);
		const result = await Promise.race([
			operation.promise.then(
				(didSave) => ({ kind: 'result' as const, didSave }),
				() => ({ kind: 'result' as const, didSave: false })
			),
			abort.promise.then(() => ({ kind: 'aborted' as const }))
		]);
		abort.cleanup();

		if (result.kind === 'aborted') {
			operation.detached = true;
			return false;
		}

		finishPersist(operation, result.didSave);
		return result.didSave;
	}

	function drain(): Promise<boolean> {
		if (drainPromise) {
			return drainPromise;
		}
		if (activePersist) {
			return Promise.resolve(false);
		}

		drainPromise = (async () => {
			setSaving(true);

			try {
				while (queuedSave) {
					const snapshot = queuedSave;
					queuedSave = null;

					const operation = startPersist(snapshot);
					const didSave = await awaitPersist(operation);
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

		pending() {
			return queuedSave;
		},

		async flush() {
			clearTimer();

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
			activePersist?.controller.abort(new DOMException('Autosave disposed', 'AbortError'));
		}
	};
}
