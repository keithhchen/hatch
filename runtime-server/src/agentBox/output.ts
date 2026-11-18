/** Keeps the start and the end of what a command prints, and says how much was left out in between. */
export class OutputCapture {
  private head = "";
  private tail = "";
  private omitted = 0;
  constructor(private readonly half: number) {}

  push(chunk: string): void {
    const room = this.half - this.head.length;
    if (room > 0) { this.head += chunk.slice(0, room); chunk = chunk.slice(room); }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > this.half) { this.omitted += this.tail.length - this.half; this.tail = this.tail.slice(-this.half); }
  }

  text(): string {
    return this.omitted ? `${this.head}\n[... ${this.omitted} characters omitted ...]\n${this.tail}` : this.head + this.tail;
  }
}
