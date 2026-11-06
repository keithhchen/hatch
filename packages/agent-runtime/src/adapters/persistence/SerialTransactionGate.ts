export class SerialTransactionGate {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T>): Promise<T> {
		let release!: () => void;
		const previous = this.tail;
		this.tail = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}
