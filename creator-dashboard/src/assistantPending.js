/** The Expert's lines the saved history does not hold yet. A message sent into a running reply is not in history until the reply takes it up. */
export const unsaved = (lines, messages) => lines.filter(line => !messages.some(message => message.id === line.id));

/** The id a message is sent under: minted once for the words, reused by any retry of them, and new once they were sent. */
export class MessageKeys {
  constructor(mint) { this.mint = mint; this.words = ""; this.key = ""; }

  keyFor(words) {
    if (this.words !== words) { this.words = words; this.key = this.mint(); }
    return this.key;
  }

  sent() { this.words = ""; }
}
