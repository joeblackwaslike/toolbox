/** A `tool.toml` imported with `with { type: 'text' }`: Bun and the tbx build inline its text. */
declare module '*.toml' {
  const text: string;
  export default text;
}
