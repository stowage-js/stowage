export interface XmlElement {
  readonly name: string;
  readonly children: readonly XmlElement[];
  /** The text directly inside the element, its children's left out. */
  readonly text: string;
}

/** A document outside the subset ADR 0003 reads, reported rather than read around. */
export class XmlSyntaxError extends Error {
  override readonly name = "XmlSyntaxError";
}

/**
 * The root element of an XML document of the subset S3 answers a listing with: elements,
 * attributes, text and comments under one optional declaration.
 */
export function parseXml(document: string): XmlElement {
  const scanner = new Scanner(document);

  scanner.skipDeclaration();
  scanner.skipMisc();

  const root = scanner.readElement();

  scanner.skipMisc();
  scanner.requireEnd();

  return root;
}

const namePattern = /[:A-Z_a-z\u00C0-\uFFFF][:A-Z_a-z\u00C0-\uFFFF.\d-]*/uy;
const whitespacePattern = /[ \t\r\n]*/y;
const entityPattern = /&(?:#x([\da-fA-F]+)|#(\d+)|([A-Za-z]\w*));/uy;

/** `Char` of XML 1.0, section 2.2: what a character reference may name. */
function isXmlCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7_ff) ||
    (codePoint >= 0xe0_00 && codePoint <= 0xff_fd) ||
    (codePoint >= 0x1_00_00 && codePoint <= 0x10_ff_ff)
  );
}

/** The five entities XML defines without a DTD, which is every one a document here has. */
const predefinedEntities: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

class Scanner {
  readonly #document: string;
  #position = 0;

  constructor(document: string) {
    this.#document = document;
  }

  skipDeclaration(): void {
    if (!this.#startsWith("<?xml")) return;

    this.#position = this.#after("?>", "The XML declaration is never closed");
  }

  /** Whitespace and comments, which are all that may stand beside the root element. */
  skipMisc(): void {
    for (;;) {
      this.#skipWhitespace();

      if (this.#startsWith("<!DOCTYPE")) throw this.#error("A DTD is refused");
      if (!this.#startsWith("<!--")) return;

      this.#skipComment();
    }
  }

  requireEnd(): void {
    if (this.#position < this.#document.length) {
      throw this.#error("Something follows the root element");
    }
  }

  readElement(): XmlElement {
    this.#expect("<");

    const name = this.#readName();

    if (this.#readAttributes() === "empty") return { name, children: [], text: "" };

    const children: XmlElement[] = [];
    let text = "";

    for (;;) {
      if (this.#position >= this.#document.length) {
        throw this.#error(`The element <${name}> is never closed`);
      }

      if (this.#startsWith("</")) {
        this.#position += 2;
        this.#closeElement(name);

        return { name, children, text };
      }

      if (this.#startsWith("<!--")) this.#skipComment();
      else if (this.#startsWith("<![CDATA[")) throw this.#error("A CDATA section is refused");
      else if (this.#startsWith("<")) children.push(this.readElement());
      else text += this.#readText();
    }
  }

  #closeElement(name: string): void {
    const closing = this.#readName();

    if (closing !== name) throw this.#error(`The element <${name}> is closed by </${closing}>`);

    this.#skipWhitespace();
    this.#expect(">");
  }

  /** Reads to the end of the start tag, which says whether content follows. */
  #readAttributes(): "empty" | "open" {
    for (;;) {
      const before = this.#position;

      this.#skipWhitespace();

      if (this.#startsWith("/>")) {
        this.#position += 2;

        return "empty";
      }

      if (this.#startsWith(">")) {
        this.#position += 1;

        return "open";
      }

      if (this.#position === before) throw this.#error("An attribute follows no whitespace");

      this.#readName();
      this.#skipWhitespace();
      this.#expect("=");
      this.#skipWhitespace();
      this.#skipQuoted();
    }
  }

  #skipQuoted(): void {
    const quote = this.#document[this.#position];

    if (quote !== '"' && quote !== "'") throw this.#error("An attribute value is not quoted");

    this.#position = this.#after(quote, "An attribute value is never closed", 1);
  }

  /** Text up to the next markup, every `&` in it the start of an entity it decodes. */
  #readText(): string {
    const markup = this.#document.indexOf("<", this.#position);
    const end = markup === -1 ? this.#document.length : markup;
    let text = "";

    while (this.#position < end) {
      const ampersand = this.#document.indexOf("&", this.#position);

      if (ampersand === -1 || ampersand >= end) {
        text += this.#document.slice(this.#position, end);
        this.#position = end;

        break;
      }

      text += this.#document.slice(this.#position, ampersand);
      this.#position = ampersand;
      text += this.#readEntity();
    }

    return text;
  }

  #readEntity(): string {
    entityPattern.lastIndex = this.#position;

    const found = entityPattern.exec(this.#document);

    if (found === null) throw this.#error("An `&` starts no entity");

    const [entity, hex, decimal, name] = found;

    if (name !== undefined) {
      const character = predefinedEntities.get(name);

      if (character === undefined) throw this.#error(`The entity ${entity} is not defined`);

      this.#position = entityPattern.lastIndex;

      return character;
    }

    const codePoint = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);

    if (!isXmlCharacter(codePoint)) {
      throw this.#error(`The reference ${entity} names no character XML carries`);
    }

    this.#position = entityPattern.lastIndex;

    return String.fromCodePoint(codePoint);
  }

  #skipComment(): void {
    this.#position = this.#after("-->", "A comment is never closed", 4);
  }

  #readName(): string {
    namePattern.lastIndex = this.#position;

    const found = namePattern.exec(this.#document);

    if (found === null) throw this.#error("A name is missing where one belongs");

    this.#position = namePattern.lastIndex;

    return found[0];
  }

  #skipWhitespace(): void {
    whitespacePattern.lastIndex = this.#position;
    whitespacePattern.exec(this.#document);
    this.#position = whitespacePattern.lastIndex;
  }

  #expect(literal: string): void {
    if (!this.#startsWith(literal)) throw this.#error(`\`${literal}\` is missing`);

    this.#position += literal.length;
  }

  /** The position just past the next `terminator`, searched from `offset` on. */
  #after(terminator: string, unterminated: string, offset = 0): number {
    const end = this.#document.indexOf(terminator, this.#position + offset);

    if (end === -1) throw this.#error(unterminated);

    return end + terminator.length;
  }

  #startsWith(literal: string): boolean {
    return this.#document.startsWith(literal, this.#position);
  }

  #error(message: string): XmlSyntaxError {
    return new XmlSyntaxError(`${message} (at character ${this.#position})`);
  }
}
