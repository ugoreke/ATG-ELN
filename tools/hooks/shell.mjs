// A small reader of shell commands for the hooks: enough of sh to tell the commands a line runs from the text it only quotes.
//
//   scanCommands('cd x && git commit -m "say git add"')  ->  [{ words: [cd, x] }, { words: [git, commit, -m, "say git add"] }]
//
// Each command comes back as { words, depth, heredocs }. A word is { text, dynamic }: `dynamic` is true when the shell would work the word
// out as it runs ($VAR, $(...), backticks), so its text here is only what was typed. `depth` is 0 for a command of the line itself and
// higher inside ( ), $( ) or backticks. `heredocs` holds the bodies of the heredocs the command was given; a body is text, never commands.
//
// What it understands: single and double quotes, $'...', backslashes, comments, && || ; | & and newlines, ( ) groups, $( ) and backticks
// (the commands inside are returned too, before the command that holds them), heredocs (<<WORD, <<-WORD, quoted or not), and
// redirections, whose target is left out of the words.
//
// A << with no closing line after it is not taken for a heredoc. Nesting deeper than 64 levels is refused with an error.
//
// What it does not: `case` patterns (their lone `)` can end a $( ) early), the expansions inside an unquoted heredoc body, aliases,
// functions, and anything a variable, `eval`, `sh -c` or `xargs` turns into a command only when the line runs.
const ANSI_C_ESCAPES = { n: "\n", t: "\t", r: "\r" };
const ENDS_HEREDOC_WORD = /[\s;&|()<>]/;
const MAX_DEPTH = 64;

export function scanCommands(source) {
  const src = String(source ?? ""), segments = [], pending = [];
  let i = 0;

  /* after a newline: the bodies of the heredocs announced on the line before it, each up to the line that is its closing word */
  const readHeredocBodies = () => {
    while (pending.length) {
      const { word, stripTabs, sink } = pending.shift(), start = i;
      let body = "", isClosed = false;
      while (i < src.length && !isClosed) {
        const end = src.indexOf("\n", i), line = src.slice(i, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end + 1;
        if ((stripTabs ? line.replace(/^\t+/, "") : line) === word) isClosed = true; else body += line + "\n";
      }
      /* no closing line: it was not a heredoc (the << of $((1<<2)), say), and the lines after it are commands */
      if (isClosed) sink.push(body); else i = start;
    }
  };

  /* one list of commands, up to `closer` (")" or "`") or the end of the text */
  function scanList(closer, depth) {
    if (depth > MAX_DEPTH) throw new Error(`the command nests deeper than ${MAX_DEPTH} levels of ( ) or $( )`);
    let words = [], word = null, heredocs = [], skipNext = false;   // `words` is filled in place: a command can have tens of thousands of words
    const add = (text, dynamic = false) => { word = { text: (word ? word.text : "") + text, dynamic: Boolean(word && word.dynamic) || dynamic }; };
    const endWord = () => { if (word && !skipNext) words.push(word); if (word) skipNext = false; word = null; };
    const endSegment = () => { endWord(); if (words.length) segments.push({ words, depth, heredocs }); words = []; heredocs = []; skipNext = false; };
    /* $( ... ) or ` ... `: the commands inside are scanned as commands; the word gets the text as typed */
    const substitution = (openLength, close) => { const start = i; i += openLength; scanList(close, depth + 1); return src.slice(start, i); };

    const readDoubleQuoted = () => {   // i is just past the opening quote
      add("");
      while (i < src.length && src[i] !== '"') {
        const c = src[i], next = src[i + 1];
        if (c === "\\") { if (next !== "\n") add(next !== undefined && '"\\$`'.includes(next) ? next : "\\" + (next ?? "")); i += 2; }
        else if (c === "$" && next === "(") add(substitution(2, ")"), true);
        else if (c === "`") add(substitution(1, "`"), true);
        else if (c === "$") { add("$", true); i++; }
        else { add(c); i++; }
      }
      i++;
    };
    const readAnsiCQuoted = () => {   // i is at the $ of $'...'
      i += 2; add("");
      while (i < src.length && src[i] !== "'") {
        if (src[i] === "\\") { const e = src[i + 1] ?? ""; add(ANSI_C_ESCAPES[e] ?? e); i += 2; } else { add(src[i]); i++; }
      }
      i++;
    };
    const readDollar = next => {
      if (next === "'") return readAnsiCQuoted();
      if (next === "(") return add(substitution(2, ")"), true);
      if (next === "{") { const end = src.indexOf("}", i), stop = end === -1 ? src.length : end + 1; add(src.slice(i, stop), true); i = stop; return undefined; }
      add("$", true); i++;
      return undefined;
    };
    /* < > >> >& <<< and heredocs: a file descriptor number before the operator and the target after it are not words of the command */
    const readRedirection = () => {
      if (word && /^\d+$/.test(word.text)) word = null; else endWord();
      if (src.startsWith("<<<", i)) { i += 3; skipNext = true; return; }
      if (src.startsWith("<<", i)) {
        i += 2;
        const stripTabs = src[i] === "-";
        if (stripTabs) i++;
        while (src[i] === " " || src[i] === "\t") i++;
        let closing = "";
        while (i < src.length && !ENDS_HEREDOC_WORD.test(src[i])) { if (!"'\"\\".includes(src[i])) closing += src[i]; i++; }
        pending.push({ word: closing, stripTabs, sink: heredocs });
        return;
      }
      i++;
      if (src[i] === ">" || src[i] === "&" || src[i] === "|") i++;
      if (src[i] !== "(") skipNext = true;
    };

    while (i < src.length) {
      const c = src[i], next = src[i + 1];
      if (c === closer) { i++; endSegment(); return; }
      if (c === "\\") { if (next !== "\n") add(next ?? ""); i += 2; }
      else if (c === "'") { const end = src.indexOf("'", i + 1), stop = end === -1 ? src.length : end; add(src.slice(i + 1, stop)); i = stop + 1; }
      else if (c === '"') { i++; readDoubleQuoted(); }
      else if (c === "$") readDollar(next);
      else if (c === "`") add(substitution(1, "`"), true);
      else if (c === " " || c === "\t") { endWord(); i++; }
      else if (c === "\n") { endSegment(); i++; readHeredocBodies(); }
      else if (c === ";" || c === "|" || c === "&") { endSegment(); i++; }
      else if (c === "(") { endSegment(); i++; scanList(")", depth + 1); }
      else if (c === ")") { endSegment(); i++; }
      else if (c === "<" || c === ">") readRedirection();
      else if (c === "#" && !word) { const end = src.indexOf("\n", i); i = end === -1 ? src.length : end; }
      else { add(c); i++; }
    }
    endSegment();
  }

  scanList(null, 0);
  return segments;
}
